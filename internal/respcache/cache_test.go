package respcache

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"spotifier/internal/clock"
)

// memPersist stands in for the database.
type memPersist struct {
	mu   sync.Mutex
	rows map[string]Entry
}

func newMemPersist() *memPersist { return &memPersist{rows: map[string]Entry{}} }

func (m *memPersist) LoadResponse(_ context.Context, key string) (Entry, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.rows[key]
	return e, ok
}

func (m *memPersist) SaveResponse(_ context.Context, key string, e Entry, _ time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[key] = e
	return nil
}

func (m *memPersist) DeleteResponses(_ context.Context, prefix string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k := range m.rows {
		if strings.HasPrefix(k, prefix) {
			delete(m.rows, k)
		}
	}
	return nil
}

func (m *memPersist) ExpireResponses(_ context.Context, prefix string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, e := range m.rows {
		if strings.HasPrefix(k, prefix) {
			e.Expired = true
			m.rows[k] = e
		}
	}
	return nil
}

// upstream counts calls and answers with the body it is set to.
type upstream struct {
	calls atomic.Int32
	mu    sync.Mutex
	body  string
	err   error
	gate  chan struct{}
}

func (u *upstream) fetch(ctx context.Context) (Entry, error) {
	u.calls.Add(1)
	if u.gate != nil {
		<-u.gate
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.err != nil {
		return Entry{}, u.err
	}
	return Entry{Status: 200, Body: []byte(u.body)}, nil
}

func (u *upstream) set(body string, err error) {
	u.mu.Lock()
	u.body, u.err = body, err
	u.mu.Unlock()
}

var hour = Policy{Fresh: time.Hour}

func newCache(clk clock.Clock, p Persist) *Cache {
	return New(Options{Clock: clk, Persist: p})
}

func TestFreshAnswerIsNotAskedForAgain(t *testing.T) {
	clk := clock.NewManual()
	c := newCache(clk, nil)
	up := &upstream{body: "a"}
	for i := 0; i < 3; i++ {
		e, res, err := c.Get(context.Background(), "k", hour, up.fetch)
		if err != nil || string(e.Body) != "a" {
			t.Fatalf("get %d: %v %q", i, err, e.Body)
		}
		if want := map[bool]Result{true: Miss, false: Hit}[i == 0]; res != want {
			t.Fatalf("get %d: %s, want %s", i, res, want)
		}
		clk.Advance(20 * time.Minute)
	}
	if n := up.calls.Load(); n != 1 {
		t.Fatalf("upstream asked %d times", n)
	}
}

func TestStaleAnswerIsServedWhileItRefreshes(t *testing.T) {
	clk := clock.NewManual()
	c := newCache(clk, nil)
	up := &upstream{body: "old"}
	c.Get(context.Background(), "k", hour, up.fetch)
	clk.Advance(2 * time.Hour)
	up.set("new", nil)

	e, res, err := c.Get(context.Background(), "k", hour, up.fetch)
	if err != nil || res != Stale || string(e.Body) != "old" {
		t.Fatalf("got %s %q %v, want the old copy at once", res, e.Body, err)
	}
	c.Wait()
	e, res, _ = c.Get(context.Background(), "k", hour, up.fetch)
	if res != Hit || string(e.Body) != "new" {
		t.Fatalf("after refresh: %s %q", res, e.Body)
	}
	if n := up.calls.Load(); n != 2 {
		t.Fatalf("upstream asked %d times, want 2", n)
	}
}

func TestAFailedUpstreamIsCoveredByTheKeptAnswer(t *testing.T) {
	clk := clock.NewManual()
	c := newCache(clk, nil)
	up := &upstream{body: "good"}
	c.Get(context.Background(), "k", hour, up.fetch)
	// Past the revalidate window, the answer is fetched before replying.
	clk.Advance(3 * 24 * time.Hour)
	up.set("", errors.New("HTTP 429: Resource has been exhausted"))

	e, res, err := c.Get(context.Background(), "k", hour, up.fetch)
	if err != nil || res != StaleError || string(e.Body) != "good" {
		t.Fatalf("got %s %q %v, want the kept copy", res, e.Body, err)
	}
}

func TestAFailureWithNothingKeptIsReturned(t *testing.T) {
	c := newCache(clock.NewManual(), nil)
	up := &upstream{err: errors.New("down")}
	if _, _, err := c.Get(context.Background(), "k", hour, up.fetch); err == nil {
		t.Fatal("expected the error")
	}
	// Errors are never kept as data.
	up.set("ok", nil)
	e, res, err := c.Get(context.Background(), "k", hour, up.fetch)
	if err != nil || res != Miss || string(e.Body) != "ok" {
		t.Fatalf("got %s %q %v", res, e.Body, err)
	}
}

func TestSomeErrorsAreNeverCovered(t *testing.T) {
	signedOut := errors.New("signed out")
	clk := clock.NewManual()
	c := New(Options{Clock: clk, ServeStale: func(err error) bool { return !errors.Is(err, signedOut) }})
	up := &upstream{body: "mine"}
	c.Get(context.Background(), "k", hour, up.fetch)
	clk.Advance(3 * 24 * time.Hour)
	up.set("", signedOut)
	if _, _, err := c.Get(context.Background(), "k", hour, up.fetch); !errors.Is(err, signedOut) {
		t.Fatalf("got %v, want the sign-out to reach the caller", err)
	}
}

func TestConcurrentAsksShareOneUpstreamCall(t *testing.T) {
	c := newCache(clock.NewManual(), nil)
	up := &upstream{body: "x", gate: make(chan struct{})}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e, _, err := c.Get(context.Background(), "k", hour, up.fetch); err != nil || string(e.Body) != "x" {
				t.Errorf("got %q %v", e.Body, err)
			}
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(up.gate)
	wg.Wait()
	if n := up.calls.Load(); n != 1 {
		t.Fatalf("upstream asked %d times, want 1", n)
	}
}

func TestOneCallerLeavingDoesNotFailTheOthers(t *testing.T) {
	c := newCache(clock.NewManual(), nil)
	up := &upstream{body: "x", gate: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() {
		_, _, err := c.Get(ctx, "k", hour, up.fetch)
		first <- err
	}()
	time.Sleep(20 * time.Millisecond)
	second := make(chan error, 1)
	go func() {
		_, _, err := c.Get(context.Background(), "k", hour, up.fetch)
		second <- err
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("first: %v", err)
	}
	close(up.gate)
	if err := <-second; err != nil {
		t.Fatalf("second: %v", err)
	}
}

func TestAnswersSurviveARestart(t *testing.T) {
	clk := clock.NewManual()
	db := newMemPersist()
	up := &upstream{body: "album"}
	newCache(clk, db).Get(context.Background(), "cat|album|x", hour, up.fetch)

	restarted := newCache(clk, db)
	e, res, err := restarted.Get(context.Background(), "cat|album|x", hour, up.fetch)
	if err != nil || res != Hit || string(e.Body) != "album" {
		t.Fatalf("after restart: %s %q %v", res, e.Body, err)
	}
	if n := up.calls.Load(); n != 1 {
		t.Fatalf("upstream asked %d times", n)
	}
	// Memory-only answers are not written down.
	newCache(clk, db).Get(context.Background(), "tmp", Policy{Fresh: time.Hour, Memory: true}, up.fetch)
	if _, ok := db.LoadResponse(context.Background(), "tmp"); ok {
		t.Fatal("a memory-only answer was persisted")
	}
}

func TestInvalidateDropsAPrefix(t *testing.T) {
	clk := clock.NewManual()
	db := newMemPersist()
	c := newCache(clk, db)
	up := &upstream{body: "v"}
	for _, k := range []string{"lib|playlists", "lib|artists", "cat|album|a"} {
		c.Get(context.Background(), k, hour, up.fetch)
	}
	c.Invalidate(context.Background(), "lib|")
	if _, ok := c.Peek(context.Background(), "lib|playlists", hour); ok {
		t.Fatal("lib|playlists survived")
	}
	if _, ok := c.Peek(context.Background(), "cat|album|a", hour); !ok {
		t.Fatal("an unrelated answer was dropped")
	}
}

func TestExpireRefetchesButCoversAFailure(t *testing.T) {
	clk := clock.NewManual()
	db := newMemPersist()
	c := newCache(clk, db)
	up := &upstream{body: "before"}
	c.Get(context.Background(), "me|liked", hour, up.fetch)
	c.Expire(context.Background(), "me|liked")

	up.set("after", nil)
	e, res, _ := c.Get(context.Background(), "me|liked", hour, up.fetch)
	if res != Miss || string(e.Body) != "after" {
		t.Fatalf("an expired answer was not fetched again: %s %q", res, e.Body)
	}
	c.Expire(context.Background(), "me|liked")
	up.set("", errors.New("down"))
	e, res, err := c.Get(context.Background(), "me|liked", hour, up.fetch)
	if err != nil || res != StaleError || string(e.Body) != "after" {
		t.Fatalf("got %s %q %v", res, e.Body, err)
	}
	// And the flag is written down, so a restart refreshes it too.
	if row, _ := db.LoadResponse(context.Background(), "me|liked"); !row.Expired {
		t.Fatal("expiry was not persisted")
	}
}

func TestAFailedBackgroundRefreshIsNotRetriedAtOnce(t *testing.T) {
	clk := clock.NewManual()
	c := newCache(clk, nil)
	up := &upstream{body: "a"}
	c.Get(context.Background(), "k", hour, up.fetch)
	clk.Advance(2 * time.Hour)
	up.set("", errors.New("429"))
	for i := 0; i < 5; i++ {
		if _, res, _ := c.Get(context.Background(), "k", hour, up.fetch); res != Stale {
			t.Fatalf("read %d: %s", i, res)
		}
		c.Wait()
	}
	if n := up.calls.Load(); n != 2 {
		t.Fatalf("upstream asked %d times, want 2 (one refresh, then a pause)", n)
	}
	clk.Advance(2 * time.Minute)
	c.Get(context.Background(), "k", hour, up.fetch)
	c.Wait()
	if n := up.calls.Load(); n != 3 {
		t.Fatalf("upstream asked %d times after the pause, want 3", n)
	}
}

func TestMemoryIsBounded(t *testing.T) {
	c := New(Options{Clock: clock.NewManual(), MaxBytes: 100})
	for i := 0; i < 20; i++ {
		up := &upstream{body: strings.Repeat("x", 30)}
		c.Get(context.Background(), string(rune('a'+i)), hour, up.fetch)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.bytes > 100 || len(c.items) > 4 {
		t.Fatalf("holding %d bytes in %d answers", c.bytes, len(c.items))
	}
}
