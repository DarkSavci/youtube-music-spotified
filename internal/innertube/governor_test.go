package innertube

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"spotifier/internal/ratelimit"
)

const homepage = `{"INNERTUBE_API_KEY":"k","INNERTUBE_CLIENT_VERSION":"1.2026","VISITOR_DATA":"v"}`

func respond(status int, body string, h http.Header) *http.Response {
	if h == nil {
		h = http.Header{}
	}
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: h}
}

// A launch starts many calls at once. They must share one homepage scrape,
// not each fetch the homepage for themselves.
func TestConcurrentCallsShareOneConfigScrape(t *testing.T) {
	var scrapes, calls atomic.Int32
	release := make(chan struct{})
	h := &http.Client{Transport: roundTrip(func(r *http.Request) *http.Response {
		if r.Method == http.MethodGet {
			scrapes.Add(1)
			<-release // hold the scrape so everyone piles up behind it
			return respond(200, homepage, nil)
		}
		calls.Add(1)
		return respond(200, `{}`, nil)
	})}
	c := New(WithHTTPClient(h))
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Call(context.Background(), "browse", map[string]any{"browseId": "FEmusic_home"}); err != nil {
				t.Error(err)
			}
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if n := scrapes.Load(); n != 1 {
		t.Fatalf("%d homepage scrapes for 12 concurrent calls, want 1", n)
	}
	if n := calls.Load(); n != 12 {
		t.Fatalf("%d calls went out, want 12", n)
	}
}

// Clients sharing the program's config store scrape once between them.
func TestSharedConfigAcrossClients(t *testing.T) {
	var scrapes atomic.Int32
	h := &http.Client{Transport: roundTrip(func(r *http.Request) *http.Response {
		if r.Method == http.MethodGet {
			scrapes.Add(1)
			return respond(200, homepage, nil)
		}
		return respond(200, `{}`, nil)
	})}
	store := newConfigStore()
	a := New(WithHTTPClient(h))
	b := New(WithHTTPClient(h))
	a.configs, b.configs = store, store
	_, _ = a.Call(context.Background(), "browse", nil)
	_, _ = b.Call(context.Background(), "browse", nil)
	if n := scrapes.Load(); n != 1 {
		t.Fatalf("%d scrapes for two clients sharing a store, want 1", n)
	}
}

// A homepage that answers with an error is not read as a config, and the
// failure is remembered rather than fetched again before every call.
func TestFailedScrapeIsCheckedAndRemembered(t *testing.T) {
	var scrapes atomic.Int32
	h := &http.Client{Transport: roundTrip(func(r *http.Request) *http.Response {
		if r.Method == http.MethodGet {
			scrapes.Add(1)
			return respond(429, homepage, nil) // has a version in it, but is a refusal
		}
		t.Error("a call was sent without a config")
		return respond(200, `{}`, nil)
	})}
	c := New(WithHTTPClient(h))
	for i := 0; i < 3; i++ {
		if _, err := c.Call(context.Background(), "browse", nil); err == nil {
			t.Fatal("call succeeded without a config")
		}
	}
	if n := scrapes.Load(); n != 1 {
		t.Fatalf("%d scrapes; a failed one should be remembered", n)
	}
}

func TestRememberedFailureExpires(t *testing.T) {
	var scrapes atomic.Int32
	ok := atomic.Bool{}
	h := &http.Client{Transport: roundTrip(func(r *http.Request) *http.Response {
		if r.Method == http.MethodGet {
			scrapes.Add(1)
			if ok.Load() {
				return respond(200, homepage, nil)
			}
			return respond(503, "", nil)
		}
		return respond(200, `{}`, nil)
	})}
	c := New(WithHTTPClient(h))
	now := time.Now()
	c.configs.now = func() time.Time { return now }
	if _, err := c.Call(context.Background(), "browse", nil); err == nil {
		t.Fatal("expected failure")
	}
	ok.Store(true)
	now = now.Add(configFailTTL + time.Second)
	if _, err := c.Call(context.Background(), "browse", nil); err != nil {
		t.Fatalf("still failing after the failure expired: %v", err)
	}
	if n := scrapes.Load(); n != 2 {
		t.Fatalf("%d scrapes, want 2", n)
	}
}

// A 429 comes back as a rate-limit error carrying upstream's message, and the
// next call is refused without being sent.
func TestRateLimitedCallCoolsDownTheGovernor(t *testing.T) {
	var sent atomic.Int32
	h := &http.Client{Transport: roundTrip(func(r *http.Request) *http.Response {
		if r.Method == http.MethodGet {
			return respond(200, homepage, nil)
		}
		sent.Add(1)
		hdr := http.Header{}
		hdr.Set("Retry-After", "300")
		return respond(429, `{"error":{"message":"Resource has been exhausted"}}`, hdr)
	})}
	g := ratelimit.New("t", ratelimit.Settings{})
	c := New(WithHTTPClient(h), WithGovernor(g))
	_, err := c.Call(context.Background(), "browse", map[string]any{"browseId": "FEmusic_liked_playlists"})
	if !errors.Is(err, ratelimit.ErrRateLimited) {
		t.Fatalf("429 not reported as a rate limit: %v", err)
	}
	var h429 *HTTPError
	if !errors.As(err, &h429) || h429.Status != 429 || !strings.Contains(err.Error(), "exhausted") {
		t.Fatalf("lost the upstream response: %v", err)
	}
	if ratelimit.RetryAfterOf(err) != 5*time.Minute {
		t.Fatalf("retry after %s", ratelimit.RetryAfterOf(err))
	}
	_, err = c.Call(context.Background(), "browse", nil)
	if !errors.Is(err, ratelimit.ErrRateLimited) || sent.Load() != 1 {
		t.Fatalf("second call: err %v, sent %d; want refused without sending", err, sent.Load())
	}
}

// Every call is reported to the observer with its route and what it asked.
func TestCallsAreObserved(t *testing.T) {
	h := &http.Client{Transport: roundTrip(func(r *http.Request) *http.Response {
		if r.Method == http.MethodGet {
			return respond(200, homepage, nil)
		}
		return respond(200, `{}`, nil)
	})}
	var mu sync.Mutex
	var got []CallRecord
	SetObserver(func(r CallRecord) { mu.Lock(); got = append(got, r); mu.Unlock() })
	defer SetObserver(nil)
	c := New(WithHTTPClient(h))
	ctx := WithRoute(context.Background(), "GET /v1/artists/{id}")
	_, _ = c.Call(ctx, "browse", map[string]any{"browseId": "UCabc"})
	_, _ = c.Continue(ctx, "browse", "tok")
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 3 {
		t.Fatalf("observed %d calls, want config + 2: %+v", len(got), got)
	}
	if got[0].Kind != "config" || got[1].Kind != "browse" || got[1].Detail != "UCabc" || got[2].Detail != "continuation" {
		t.Fatalf("records %+v", got)
	}
	if got[1].Route != "GET /v1/artists/{id}" || got[1].Status != 200 {
		t.Fatalf("record %+v", got[1])
	}
}
