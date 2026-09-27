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
}

// Cache is safe for concurrent use.
type Cache struct {
	opt Options

	mu       sync.Mutex
	lru      *list.List // front = most recent; values are *item
	items    map[string]*list.Element
	bytes    int
	flights  map[string]*flight
	failedAt map[string]time.Time

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
	return &Cache{
		opt:      o,
		lru:      list.New(),
		items:    map[string]*list.Element{},
		flights:  map[string]*flight{},
		failedAt: map[string]time.Time{},
		bg:       make(chan struct{}, o.Background),
	}
}

// Get returns the answer for key, asking upstream only when it must.
func (c *Cache) Get(ctx context.Context, key string, p Policy, fetch Fetch) (Entry, Result, error) {
	now := c.opt.Clock.Now()
	cached, have := c.lookup(ctx, key, p)
	if have && !cached.Expired {
		age := now.Sub(cached.StoredAt)
		if age < p.Fresh {
			return cached, Hit, nil
		}
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

// Invalidate drops every answer whose key starts with prefix.
func (c *Cache) Invalidate(ctx context.Context, prefix string) {
	c.mu.Lock()
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
	c.remember(key, e)
	if p.Memory || c.opt.Persist == nil {
		return
	}
	if err := c.opt.Persist.SaveResponse(ctx, key, e, e.StoredAt.Add(p.keep())); err != nil {
		c.opt.Log.Warn("response cache: save", "key", key, "err", err)
	}
}

// shared runs fetch once for everyone asking for key at the same time. The
// call is detached from the first caller, so one closed page does not fail
// the others waiting on it.
func (c *Cache) shared(ctx context.Context, key string, p Policy, fetch Fetch) (Entry, error) {
	c.mu.Lock()
	f, running := c.flights[key]
	if !running {
		f = &flight{done: make(chan struct{})}
		c.flights[key] = f
	}
	c.mu.Unlock()

	if !running {
		go func() {
			fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.opt.FetchTimeout)
			defer cancel()
			e, err := fetch(fctx)
			if err == nil {
				e.StoredAt = c.opt.Clock.Now()
				c.store(fctx, key, p, e)
			}
			f.entry, f.err = e, err
			c.mu.Lock()
			delete(c.flights, key)
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
