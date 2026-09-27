// Package respcache keeps upstream answers so the same question is not asked
// of YouTube twice.
//
// Almost everything the app shows is read from YouTube, and most of it barely
// changes: an album is the same album next week, an artist page for hours.
// Asking again on every page view, every window and every restart is what
// runs an account into YouTube's rate limit, and a rate-limited account then
// sees empty pages. So answers are kept, in memory and in the database, and:
//
//   - identical requests in flight share one upstream call (singleflight);
//   - an answer past its freshness is still served at once while a
//     background refresh replaces it (stale-while-revalidate);
//   - when the upstream call fails, rate limits included, the last good answer
//     is served instead of the error (stale-if-error).
//
// Only successful answers are kept. An error is never stored as data.
package respcache

import (
	"container/list"
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"spotifier/internal/clock"
)

// Entry is one kept answer: the status and body the route wrote.
type Entry struct {
	Status   int
	Body     []byte
	StoredAt time.Time
	// Expired marks an answer a local change made out of date: it is still
	// shown, but the next read refreshes it whatever its age.
	Expired bool
	// FreshUntil, when set, overrides the Policy's freshness for this one
	// answer: shorter for a result that is likely to change soon (a list read
	// just after an edit, an empty result that more history will fill).
	FreshUntil time.Time
	// NoStore returns the answer to everyone waiting for it without keeping
	// it, for answers that must never be served again (a signed-out state).
	NoStore bool
}

// fresh reports whether e is still fresh under p at now.
func (e Entry) fresh(p Policy, now time.Time) bool {
	if e.Expired {
		return false
	}
	if !e.FreshUntil.IsZero() {
		return now.Before(e.FreshUntil)
	}
	return now.Sub(e.StoredAt) < p.Fresh
}

// Policy says how long an answer is good for.
type Policy struct {
	// Fresh is how long an answer is served without asking upstream again.
	Fresh time.Duration
	// Keep is how long a stale answer may still stand in for a failed or
	// pending refresh. Zero means DefaultKeep.
	Keep time.Duration
	// Memory keeps the answer in memory only; the rest are also written to
	// the database so a restart reuses them.
	Memory bool
}

// DefaultKeep is how long a stale answer stays usable when a Policy says
// nothing: long enough to ride out an outage or a rate limit, short enough
// that nothing absurdly old is shown.
const DefaultKeep = 30 * 24 * time.Hour

// revalidate is how long past Fresh an answer is still served at once while
// it refreshes in the background: as long as it was fresh, and at least a
// day. Older than that it is fetched before answering, since showing a
// week-old home page and replacing it a moment later helps nobody.
func (p Policy) revalidate() time.Duration {
	if p.Fresh > 24*time.Hour {
		return p.Fresh
	}
	return 24 * time.Hour
}

func (p Policy) keep() time.Duration {
	if p.Keep > 0 {
		return p.Keep
	}
	return DefaultKeep
}

// Result says where an answer came from, for the X-Cache header and tests.
type Result string

const (
	Miss Result = "miss" // asked upstream now
	Hit  Result = "hit"  // fresh copy
	// Stale is an expired copy served while a refresh runs in the background.
	Stale Result = "stale"
	// StaleError is an expired copy served because upstream failed.
	StaleError Result = "stale-error"
)

// Persist is the database behind the cache. The Control store implements it.
type Persist interface {
	LoadResponse(ctx context.Context, key string) (Entry, bool)
	SaveResponse(ctx context.Context, key string, e Entry, keepUntil time.Time) error
	DeleteResponses(ctx context.Context, prefix string) error
	ExpireResponses(ctx context.Context, prefix string) error
	// PruneResponses drops what is past its keep date and the oldest beyond
	// the store's caps. Called now and then, not on every write.
	PruneResponses(ctx context.Context) error
}

// Fetch asks upstream. The status is what the route writes with the body; an
// error means nothing is kept.
type Fetch func(ctx context.Context) (Entry, error)

// Options tune a Cache. Zero values take the defaults.
type Options struct {
	Clock   clock.Clock
	Persist Persist
	Log     *slog.Logger
	// MaxBytes bounds the in-memory copies. Default 64 MiB.
	MaxBytes int
	// Background bounds how many stale answers are refreshed at once.
	// Default 2: refreshes are the part nobody is waiting for.
	Background int
	// ServeStale decides whether a failure may be covered by a stale copy.
	// A signed-out session, for one, must reach the UI as itself. Nil means
	// every error may be covered.
	ServeStale func(error) bool
	// FetchTimeout bounds one upstream call made on behalf of possibly
	// several requests. Default 45s.
	FetchTimeout time.Duration
	// RetryAfterFailure is how long a failed background refresh of one key
	// waits before it is tried again. Default 1 minute.
	RetryAfterFailure time.Duration
	// EditLag is how long after a local edit a re-read is kept only briefly,
	// since YouTube can still answer with the list as it was. Default 1 min.
	EditLag time.Duration
	// PruneEvery is how often the persisted answers are pruned. Default 1h.
	PruneEvery time.Duration
}

// edit is one Invalidate or Expire: which keys, and when.
type edit struct {
	prefix string
	gen    uint64
	at     time.Time
}

// maxEdits bounds the remembered edits; older ones only matter to a fetch
// that has been running longer than its timeout.
const maxEdits = 256

// Cache is safe for concurrent use.
type Cache struct {
	opt Options

	mu       sync.Mutex
	lru      *list.List // front = most recent; values are *item
	items    map[string]*list.Element
	bytes    int
	flights  map[string]*flight
	failedAt map[string]time.Time
	// gen counts edits. A fetch notes it when it starts; an edit to its key
	// after that means the answer may be from before the edit.
	gen       uint64
	edits     []edit
	lastPrune time.Time

	bg chan struct{}
	wg sync.WaitGroup
}

type item struct {
	key   string
	entry Entry
}

type flight struct {
	done  chan struct{}
	entry Entry
	err   error
	gen   uint64 // the edit count when the fetch started
}

// New builds a Cache.
func New(o Options) *Cache {
	if o.Clock == nil {
		o.Clock = clock.System{}
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.MaxBytes <= 0 {
		o.MaxBytes = 64 << 20
	}
	if o.Background <= 0 {
		o.Background = 2
	}
	if o.FetchTimeout <= 0 {
		o.FetchTimeout = 45 * time.Second
	}
	if o.RetryAfterFailure <= 0 {
		o.RetryAfterFailure = time.Minute
	}
	if o.EditLag <= 0 {
		o.EditLag = time.Minute
	}
	if o.PruneEvery <= 0 {
		o.PruneEvery = time.Hour
	}
	return &Cache{
		opt:       o,
		lru:       list.New(),
		items:     map[string]*list.Element{},
		flights:   map[string]*flight{},
		failedAt:  map[string]time.Time{},
		bg:        make(chan struct{}, o.Background),
		lastPrune: o.Clock.Now(),
	}
}

// Get returns the answer for key, asking upstream only when it must.
func (c *Cache) Get(ctx context.Context, key string, p Policy, fetch Fetch) (Entry, Result, error) {
	now := c.opt.Clock.Now()
	cached, have := c.lookup(ctx, key, p)
	if have && !cached.Expired {
		if cached.fresh(p, now) {
			return cached, Hit, nil
		}
		age := now.Sub(cached.StoredAt)
		if age < p.Fresh+p.revalidate() && age < p.keep() {
			c.refreshLater(key, p, fetch)
			return cached, Stale, nil
		}
	}
	// Past the revalidate window, or made out of date by a local change: the
	// answer is fetched now, and the kept one only covers a failure.

	e, err := c.shared(ctx, key, p, fetch)
	if err == nil {
		return e, Miss, nil
	}
	if have && now.Sub(cached.StoredAt) < p.keep() && c.coverable(err) {
		c.opt.Log.Info("serving a kept answer after an upstream failure", "key", key, "err", err)
		return cached, StaleError, nil
	}
	return Entry{}, Miss, err
}

// Peek returns a kept answer without asking upstream, however old it is.
func (c *Cache) Peek(ctx context.Context, key string, p Policy) (Entry, bool) {
	return c.lookup(ctx, key, p)
}

// Put stores an answer made elsewhere (a local edit of a kept list).
func (c *Cache) Put(ctx context.Context, key string, p Policy, e Entry) {
	if e.StoredAt.IsZero() {
		e.StoredAt = c.opt.Clock.Now()
	}
	c.store(ctx, key, p, e)
}

// Expire keeps the answers under prefix but makes them stale, so the next
// read refreshes them while still showing the old copy.
func (c *Cache) Expire(ctx context.Context, prefix string) {
	c.mu.Lock()
	c.noteEdit(prefix, c.opt.Clock.Now())
	for k, el := range c.items {
		if strings.HasPrefix(k, prefix) {
			el.Value.(*item).entry.Expired = true
		}
	}
	c.mu.Unlock()
	if c.opt.Persist != nil {
		if err := c.opt.Persist.ExpireResponses(ctx, prefix); err != nil {
			c.opt.Log.Warn("response cache: expire", "prefix", prefix, "err", err)
		}
	}
}

// Invalidate drops every answer whose key starts with prefix, after an edit:
// a re-read in the next minute is kept only briefly (see Options.EditLag).
func (c *Cache) Invalidate(ctx context.Context, prefix string) {
	c.drop(ctx, prefix, c.opt.Clock.Now())
}

// Clear drops every answer whose key starts with prefix without treating it
// as an edit YouTube may lag behind: for a change of account, or startup.
func (c *Cache) Clear(ctx context.Context, prefix string) {
	c.drop(ctx, prefix, time.Time{})
}

func (c *Cache) drop(ctx context.Context, prefix string, at time.Time) {
	c.mu.Lock()
	c.noteEdit(prefix, at)
	for k, el := range c.items {
		if strings.HasPrefix(k, prefix) {
			c.bytes -= len(el.Value.(*item).entry.Body)
			c.lru.Remove(el)
			delete(c.items, k)
		}
	}
	c.mu.Unlock()
	if c.opt.Persist != nil {
		if err := c.opt.Persist.DeleteResponses(ctx, prefix); err != nil {
			c.opt.Log.Warn("response cache: delete", "prefix", prefix, "err", err)
		}
	}
}

// noteEdit records an edit to the keys under prefix at the given time (zero
// for one that starts no lag window). Fetches already running for them are
// detached, so a read after the edit starts its own rather than joining one
// that may return the list as it was. c.mu is held.
func (c *Cache) noteEdit(prefix string, at time.Time) {
	c.gen++
	c.edits = append(c.edits, edit{prefix: prefix, gen: c.gen, at: at})
	if len(c.edits) > maxEdits {
		c.edits = c.edits[len(c.edits)-maxEdits:]
	}
	for k := range c.flights {
		if strings.HasPrefix(k, prefix) {
			delete(c.flights, k)
		}
	}
}

// editedSince reports whether key was edited after gen, and whether it was
// edited within the lag window before now. c.mu is held.
func (c *Cache) editedSince(key string, gen uint64, now time.Time) (after, recent bool) {
	for _, e := range c.edits {
		if !strings.HasPrefix(key, e.prefix) {
			continue
		}
		if e.gen > gen {
			after = true
		}
		if !e.at.IsZero() && now.Sub(e.at) < c.opt.EditLag {
			recent = true
		}
	}
	return after, recent
}

// Now is the cache's clock, for callers timing things against kept answers.
func (c *Cache) Now() time.Time { return c.opt.Clock.Now() }

// Wait blocks until background refreshes finish. For tests and shutdown.
func (c *Cache) Wait() { c.wg.Wait() }

func (c *Cache) coverable(err error) bool {
	return c.opt.ServeStale == nil || c.opt.ServeStale(err)
}

func (c *Cache) lookup(ctx context.Context, key string, p Policy) (Entry, bool) {
	c.mu.Lock()
	if el, ok := c.items[key]; ok {
		c.lru.MoveToFront(el)
		e := el.Value.(*item).entry
		c.mu.Unlock()
		return e, true
	}
	c.mu.Unlock()
	if p.Memory || c.opt.Persist == nil {
		return Entry{}, false
	}
	e, ok := c.opt.Persist.LoadResponse(ctx, key)
	if !ok {
		return Entry{}, false
	}
	c.remember(key, e)
	return e, true
}

func (c *Cache) remember(key string, e Entry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.bytes -= len(el.Value.(*item).entry.Body)
		el.Value.(*item).entry = e
		c.lru.MoveToFront(el)
	} else {
		c.items[key] = c.lru.PushFront(&item{key: key, entry: e})
	}
	c.bytes += len(e.Body)
	for c.bytes > c.opt.MaxBytes && c.lru.Len() > 1 {
		el := c.lru.Back()
		it := el.Value.(*item)
		c.bytes -= len(it.entry.Body)
		c.lru.Remove(el)
		delete(c.items, it.key)
	}
}

func (c *Cache) store(ctx context.Context, key string, p Policy, e Entry) {
	if e.NoStore {
		return
	}
	c.remember(key, e)
	if p.Memory || c.opt.Persist == nil {
		return
	}
	if err := c.opt.Persist.SaveResponse(ctx, key, e, e.StoredAt.Add(p.keep())); err != nil {
		c.opt.Log.Warn("response cache: save", "key", key, "err", err)
	}
	c.mu.Lock()
	due := c.opt.Clock.Now().Sub(c.lastPrune) >= c.opt.PruneEvery
	if due {
		c.lastPrune = c.opt.Clock.Now()
	}
	c.mu.Unlock()
	if due {
		if err := c.opt.Persist.PruneResponses(ctx); err != nil {
			c.opt.Log.Warn("response cache: prune", "err", err)
		}
	}
}

// shared runs fetch once for everyone asking for key at the same time. The
// call is detached from the first caller, so one closed page does not fail
// the others waiting on it.
func (c *Cache) shared(ctx context.Context, key string, p Policy, fetch Fetch) (Entry, error) {
	c.mu.Lock()
	f, running := c.flights[key]
	if !running {
		f = &flight{done: make(chan struct{}), gen: c.gen}
		c.flights[key] = f
	}
	c.mu.Unlock()

	if !running {
		go func() {
			fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.opt.FetchTimeout)
			defer cancel()
			e, err := fetch(fctx)
			if err == nil {
				now := c.opt.Clock.Now()
				e.StoredAt = now
				c.mu.Lock()
				after, recent := c.editedSince(key, f.gen, now)
				c.mu.Unlock()
				switch {
				case after:
					// Edited while this ran: it may be the list from before
					// the edit. Show it, but read again next time.
					e.Expired = true
				case recent && (e.FreshUntil.IsZero() || e.FreshUntil.After(now.Add(c.opt.EditLag))):
					// Read just after an edit, when YouTube can still answer
					// with the old list: kept only briefly.
					e.FreshUntil = now.Add(c.opt.EditLag)
				}
				c.store(fctx, key, p, e)
			}
			f.entry, f.err = e, err
			c.mu.Lock()
			if c.flights[key] == f {
				delete(c.flights, key)
			}
			c.mu.Unlock()
			close(f.done)
		}()
	}

	select {
	case <-f.done:
		return f.entry, f.err
	case <-ctx.Done():
		return Entry{}, ctx.Err()
	}
}

// refreshLater replaces a stale answer in the background, a few at a time,
// and not again soon after one failed.
func (c *Cache) refreshLater(key string, p Policy, fetch Fetch) {
	now := c.opt.Clock.Now()
	c.mu.Lock()
	if _, running := c.flights[key]; running {
		c.mu.Unlock()
		return
	}
	if at, ok := c.failedAt[key]; ok && now.Sub(at) < c.opt.RetryAfterFailure {
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()

	select {
	case c.bg <- struct{}{}:
	default:
		return // busy; the next read tries again
	}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer func() { <-c.bg }()
		_, err := c.shared(context.Background(), key, p, fetch)
		c.mu.Lock()
		if err != nil {
			c.failedAt[key] = c.opt.Clock.Now()
		} else {
			delete(c.failedAt, key)
		}
		c.mu.Unlock()
		if err != nil {
			c.opt.Log.Info("response cache: background refresh failed", "key", key, "err", err)
		}
	}()
}
