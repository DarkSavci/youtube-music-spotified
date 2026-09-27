package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"spotifier/internal/catalog"
	"spotifier/internal/clock"
	"spotifier/internal/domain"
	"spotifier/internal/innertube"
	"spotifier/internal/ratelimit"
	"spotifier/internal/renderers"
	"spotifier/internal/resolver"
	"spotifier/internal/session"
)

// failingResolver fails every resolution with err and counts the attempts.
type failingResolver struct {
	calls atomic.Int32
	err   error
}

func (r *failingResolver) Name() string { return "failing" }
func (r *failingResolver) Resolve(context.Context, string) (domain.Stream, resolver.Quality, error) {
	r.calls.Add(1)
	return domain.Stream{}, resolver.Quality{}, r.err
}

// A track that failed is answered from memory: an unavailable one for an
// hour, anything else for two minutes — not by running yt-dlp again for the
// stream, its preload, the silence probe and the health check in turn.
func TestFailedResolutionsAreRemembered(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		ttl  time.Duration
	}{
		{"unavailable", fmt.Errorf("%w: removed", resolver.ErrUnavailable), time.Hour},
		{"other", errors.New("yt-dlp: signature extraction failed"), 2 * time.Minute},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &failingResolver{err: tc.err}
			s := New(Deps{Resolver: r})
			now := time.Now()
			s.failures.now = func() time.Time { return now }
			for i := 0; i < 4; i++ {
				if _, err := s.resolveCached(context.Background(), "vid00000001"); err == nil {
					t.Fatal("resolved a failing track")
				}
			}
			if n := r.calls.Load(); n != 1 {
				t.Fatalf("%d resolutions for four asks, want 1", n)
			}
			now = now.Add(tc.ttl + time.Second)
			_, _ = s.resolveCached(context.Background(), "vid00000001")
			if n := r.calls.Load(); n != 2 {
				t.Fatalf("not tried again after %s", tc.ttl)
			}
		})
	}
}

// A network fault is not remembered: the connection coming back must be met
// with a fresh try, not a stale failure.
func TestNetworkFaultsAreNotRemembered(t *testing.T) {
	for _, err := range []error{
		&net.OpError{Op: "dial", Err: errors.New("connection refused")},
		errors.New("yt-dlp: ERROR: Unable to download API page: [Errno 11001] getaddrinfo failed"),
		context.DeadlineExceeded,
	} {
		r := &failingResolver{err: err}
		s := New(Deps{Resolver: r})
		_, _ = s.resolveCached(context.Background(), "vid00000002")
		_, _ = s.resolveCached(context.Background(), "vid00000002")
		if n := r.calls.Load(); n != 2 {
			t.Fatalf("%v was remembered (%d calls)", err, n)
		}
	}
}

// yt-dlp's rate limit cools stream resolution down: the next ask is refused
// without running it, as a rate limit the API reports as 429.
func TestStreamRateLimitCoolsDown(t *testing.T) {
	r := &failingResolver{err: fmt.Errorf("%w: sign in to confirm", resolver.ErrRateLimited)}
	g := ratelimit.New("streams", ratelimit.Settings{})
	s := New(Deps{Resolver: r, StreamGovernor: g})
	_, err := s.resolveCached(context.Background(), "vid00000003")
	if !errors.Is(err, resolver.ErrRateLimited) || ratelimit.RetryAfterOf(err) != 30*time.Second {
		t.Fatalf("first: %v", err)
	}
	// A guess during the cooldown is refused without running anything.
	_, err = s.resolveSpeculative(context.Background(), "vid00000004")
	if !errors.Is(err, resolver.ErrRateLimited) || r.calls.Load() != 1 {
		t.Fatalf("a guess resolved during the cooldown: %v (%d runs)", err, r.calls.Load())
	}
	// A play gets one probe per cooldown; the next play is refused.
	_, _ = s.resolveCached(context.Background(), "vid00000005")
	_, err = s.resolveCached(context.Background(), "vid00000006")
	if !errors.Is(err, resolver.ErrRateLimited) || r.calls.Load() != 2 {
		t.Fatalf("plays during the cooldown ran %d times, want one probe", r.calls.Load())
	}
	// The refusal is on record, so the health check reports a rate limit.
	if v, ok := s.lastFailure.Load("vid00000006"); !ok || !errors.Is(v.(error), resolver.ErrRateLimited) {
		t.Fatal("refused track has no rate-limit failure on record")
	}
	if !s.prefetch.pausedUntil.After(time.Now()) {
		t.Fatal("speculative prefetch not paused by the cooldown")
	}
}

// A rate limit reaches the UI as 429 with Retry-After, never as a 502 it
// would retry.
func TestRateLimitsAreReportedAs429(t *testing.T) {
	s := New(Deps{})
	for _, err := range []error{
		&ratelimit.Error{RetryAfter: 90 * time.Second},
		fmt.Errorf("innertube browse: %w", &innertube.HTTPError{Status: 429, Endpoint: "browse", Message: "Resource has been exhausted"}),
		resolver.ErrRateLimited,
	} {
		rec := httptest.NewRecorder()
		s.fail(rec, httptest.NewRequest(http.MethodGet, "/v1/me/library", nil), err)
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("%v → %d", err, rec.Code)
		}
		if rec.Header().Get("Retry-After") == "" {
			t.Fatalf("%v: no Retry-After", err)
		}
		var body apiError
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if !body.RateLimited || body.RetryAfter <= 0 {
			t.Fatalf("%v: body %s", err, rec.Body)
		}
	}
	rec := httptest.NewRecorder()
	s.fail(rec, httptest.NewRequest(http.MethodGet, "/v1/me/library", nil), &ratelimit.Error{RetryAfter: 90 * time.Second})
	if rec.Header().Get("Retry-After") != "90" {
		t.Fatalf("Retry-After %q, want 90", rec.Header().Get("Retry-After"))
	}
}

// Requests are tagged with the route they serve, for the call log.
func TestRequestsAreTaggedWithTheirRoute(t *testing.T) {
	var got string
	cat := routeCatalog{seen: &got}
	s := New(Deps{Catalog: cat})
	s.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/v1/albums/MPREb_x", nil))
	if got != "GET /v1/albums/{id}" {
		t.Fatalf("route %q", got)
	}
}

type routeCatalog struct {
	catalog.Catalog
	seen *string
}

func (c routeCatalog) Album(ctx context.Context, id string) (domain.Album, error) {
	*c.seen = innertube.RouteOf(ctx)
	return domain.Album{}, errors.New("no")
}

// Only the newest few guesses are kept; asking for another drops the oldest,
// which is free to be asked for again.
func TestSpeculativePrefetchesAreBounded(t *testing.T) {
	p := newPrefetcher()
	var cancelled []int
	var mu sync.Mutex
	for i := 0; i < 5; i++ {
		i := i
		key := fmt.Sprintf("v%d", i)
		p.recent[key] = time.Now()
		p.addGuess(key, func() { mu.Lock(); cancelled = append(cancelled, i); mu.Unlock() })
	}
	mu.Lock()
	defer mu.Unlock()
	if len(p.guesses) != maxGuesses {
		t.Fatalf("%d pending guesses, want %d", len(p.guesses), maxGuesses)
	}
	if len(cancelled) != 2 || cancelled[0] != 0 || cancelled[1] != 1 {
		t.Fatalf("cancelled %v, want the two oldest", cancelled)
	}
	if _, ok := p.recent["v0"]; ok {
		t.Fatal("a dropped guess is still marked as recently fetched")
	}
}

// A guess that finishes leaves the pending list.
func TestFinishedGuessLeavesTheList(t *testing.T) {
	p := newPrefetcher()
	end := p.addGuess("a", func() {})
	p.addGuess("b", func() {})
	end()
	if len(p.guesses) != 1 || p.guesses[0].key != "b" {
		t.Fatalf("pending %v", p.guesses)
	}
}

// repeatCatalog's radio only ever repeats the seed's first page.
type repeatCatalog struct {
	catalog.Catalog
	mu    sync.Mutex
	times []time.Time
}

func (c *repeatCatalog) RadioPage(_ context.Context, seed, token string) ([]domain.Track, string, error) {
	c.mu.Lock()
	c.times = append(c.times, time.Now())
	c.mu.Unlock()
	return []domain.Track{track(seed)}, "more", nil
}

func (c *repeatCatalog) asked() []time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]time.Time(nil), c.times...)
}

// A radio that keeps repeating what the queue has is paged at the gap, and
// given up on after three such pages — not paged through back to back.
func TestAutoplayGivesUpOnARadioWithNothingNew(t *testing.T) {
	hub := session.NewHub(clock.System{}, session.DefaultSettings(), nil)
	cat := &repeatCatalog{}
	s := New(Deps{Session: hub, Catalog: cat})
	s.autoplay.gap = 60 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.RunAutoplay(ctx)
	_, _ = hub.Command(context.Background(), "d", session.Command{Kind: session.CmdPlay, Tracks: []domain.Track{track("only")}, Origin: "x"})
	time.Sleep(600 * time.Millisecond)
	times := cat.asked()
	if len(times) != autoplayMaxDry {
		t.Fatalf("%d pages asked, want %d then stop", len(times), autoplayMaxDry)
	}
	for i := 1; i < len(times); i++ {
		if d := times[i].Sub(times[i-1]); d < 50*time.Millisecond {
			t.Fatalf("pages %s apart, want at least the gap", d)
		}
	}
}

// Position reports alone do not make autoplay look at the queue again; a
// forced re-check does.
func TestAutoplayIgnoresPositionReports(t *testing.T) {
	hub := session.NewHub(clock.System{}, session.DefaultSettings(), nil)
	cat := &repeatCatalog{}
	s := New(Deps{Session: hub, Catalog: cat})
	s.autoplay.gap = time.Hour // no scheduled re-check gets in the way
	_, _ = hub.Command(context.Background(), "d", session.Command{Kind: session.CmdPlay, Tracks: []domain.Track{track("a")}, Origin: "o"})
	p := hub.Projection()

	s.topUp(context.Background(), p, false) // first look: fetches
	time.Sleep(50 * time.Millisecond)
	s.topUp(context.Background(), p, false) // same position: not looked at
	time.Sleep(50 * time.Millisecond)
	if n := len(cat.asked()); n != 1 {
		t.Fatalf("%d fetches; a repeated position report fetched again", n)
	}
	s.autoplay.mu.Lock()
	s.autoplay.fetchedAt = time.Time{}
	s.autoplay.mu.Unlock()
	s.topUp(context.Background(), p, true)
	time.Sleep(50 * time.Millisecond)
	if n := len(cat.asked()); n != 2 {
		t.Fatalf("%d fetches after a forced re-check, want 2", n)
	}
}

// slowRadio holds the first queue's page until released, so a new queue is
// started while autoplay is busy fetching for the old one.
type slowRadio struct {
	catalog.Catalog
	mu      sync.Mutex
	pages   []string
	release chan struct{}
}

func (c *slowRadio) RadioPage(_ context.Context, seed, token string) ([]domain.Track, string, error) {
	c.mu.Lock()
	c.pages = append(c.pages, seed)
	c.mu.Unlock()
	if strings.HasPrefix(seed, "old") {
		<-c.release
	}
	var out []domain.Track
	for i := range 10 {
		out = append(out, track(fmt.Sprintf("%s-r%s-%d", seed, token, i)))
	}
	return out, token + "x", nil
}

// A queue started while autoplay was fetching for the previous one is still
// extended once that fetch returns.
func TestNewQueueDuringAFetchIsStillExtended(t *testing.T) {
	hub := session.NewHub(clock.System{}, session.DefaultSettings(), nil)
	cat := &slowRadio{release: make(chan struct{})}
	s := New(Deps{Session: hub, Catalog: cat})
	s.autoplay.gap = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.RunAutoplay(ctx)
	_, _ = hub.Command(context.Background(), "d", session.Command{Kind: session.CmdPlay, Tracks: []domain.Track{track("old1")}, Origin: "A"})
	time.Sleep(100 * time.Millisecond)
	_, _ = hub.Command(context.Background(), "d", session.Command{Kind: session.CmdPlay, Tracks: []domain.Track{track("new1")}, Origin: "B"})
	time.Sleep(100 * time.Millisecond)
	close(cat.release)
	if ids := waitQueue(t, hub, 11); ids[0] != "new1" {
		t.Fatalf("queue %v", ids)
	}
}

// A failed guess never stands in the way of a play, and a failed play only
// answers the next play for a few seconds; a sign-in clears everything.
func TestPlaysGetAFreshAttempt(t *testing.T) {
	r := &failingResolver{err: fmt.Errorf("%w: removed", resolver.ErrUnavailable)}
	s := New(Deps{Resolver: r})
	now := time.Now()
	s.failures.now = func() time.Time { return now }

	_, _ = s.resolveSpeculative(context.Background(), "vid00000010")
	_, _ = s.resolveSpeculative(context.Background(), "vid00000010")
	if n := r.calls.Load(); n != 1 {
		t.Fatalf("guesses ran %d times, want 1", n)
	}
	_, _ = s.resolveCached(context.Background(), "vid00000010")
	if n := r.calls.Load(); n != 2 {
		t.Fatal("a failed guess blocked a play")
	}
	_, _ = s.resolveCached(context.Background(), "vid00000010")
	if n := r.calls.Load(); n != 2 {
		t.Fatal("a play straight after a failed play ran again")
	}
	now = now.Add(directWindow + time.Second)
	_, _ = s.resolveCached(context.Background(), "vid00000010")
	if n := r.calls.Load(); n != 3 {
		t.Fatal("pressing play again later was not a fresh attempt")
	}
	_, _ = s.resolveSpeculative(context.Background(), "vid00000010")
	if n := r.calls.Load(); n != 3 {
		t.Fatal("guesses ran again within the hour")
	}
	s.failures.clear()
	_, _ = s.resolveSpeculative(context.Background(), "vid00000010")
	if n := r.calls.Load(); n != 4 {
		t.Fatal("clearing (sign-in) did not forget the failure")
	}
}

// The prefetch pause follows the cooldown's length.
func TestPrefetchPauseMatchesTheCooldown(t *testing.T) {
	api := ratelimit.New("api", ratelimit.Settings{})
	s := New(Deps{APIGovernor: api})
	api.CoolDown(0)
	left := time.Until(s.prefetch.pausedUntil)
	if left < 25*time.Second || left > 35*time.Second {
		t.Fatalf("paused for %s after a 30s cooldown", left)
	}
}

// gatedResolver succeeds, but only once released, so it can finish after a
// cooldown began.
type gatedResolver struct{ release chan struct{} }

func (r *gatedResolver) Name() string { return "gated" }
func (r *gatedResolver) Resolve(ctx context.Context, id string) (domain.Stream, resolver.Quality, error) {
	<-r.release
	return domain.Stream{Kind: domain.StreamURL, VideoID: id, URL: "http://x/" + id}, resolver.Quality{}, nil
}

// A lookup that began before a cooldown and finishes during it leaves the
// cooldown running.
func TestOldLookupDoesNotEndANewCooldown(t *testing.T) {
	r := &gatedResolver{release: make(chan struct{})}
	g := ratelimit.New("streams", ratelimit.Settings{})
	s := New(Deps{Resolver: r, StreamGovernor: g})
	done := make(chan struct{})
	go func() { _, _ = s.resolveCached(context.Background(), "vid00000020"); close(done) }()
	time.Sleep(30 * time.Millisecond)
	g.CoolDown(0)
	close(r.release)
	<-done
	if cooling, _ := g.Cooling(); !cooling {
		t.Fatal("a lookup begun before the cooldown ended it")
	}
}

// Liked Music's throttle shape (a 200) cools the API governor down and is
// reported like any rate limit.
func TestLikedThrottleCoolsDownTheAPI(t *testing.T) {
	g := ratelimit.New("api", ratelimit.Settings{})
	s := New(Deps{APIGovernor: g})
	rec := httptest.NewRecorder()
	s.fail(rec, httptest.NewRequest(http.MethodGet, "/v1/me/liked", nil), renderers.ErrLikedShape)
	var body apiError
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != http.StatusTooManyRequests || !body.RateLimited || rec.Header().Get("Retry-After") != "30" {
		t.Fatalf("%d %q %s", rec.Code, rec.Header().Get("Retry-After"), rec.Body)
	}
	if cooling, _ := g.Cooling(); !cooling {
		t.Fatal("the API governor was not cooled down")
	}
}
