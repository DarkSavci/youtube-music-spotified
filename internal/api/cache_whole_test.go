package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"spotifier/internal/audiocache"
	"spotifier/internal/domain"
	"spotifier/internal/resolver"
)

// wholeUpstream serves a file the way yt-dlp's URLs are served now: any
// range, open-ended included, in one response. It counts the bytes it sends.
type wholeUpstream struct {
	data     []byte
	sent     atomic.Int64
	requests atomic.Int32
	// stallAfter, when set, makes the first response hang after that many
	// bytes, as a dead connection does.
	stallAfter int64
	stalled    atomic.Bool
}

func (u *wholeUpstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	u.requests.Add(1)
	from, to := int64(0), int64(len(u.data)-1)
	if h := r.Header.Get("Range"); h != "" {
		spec := strings.TrimPrefix(h, "bytes=")
		a, b, _ := strings.Cut(spec, "-")
		fmt.Sscan(a, &from)
		if b != "" {
			fmt.Sscan(b, &to)
		}
	}
	if from >= int64(len(u.data)) {
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	to = min(to, int64(len(u.data)-1))
	w.Header().Set("Content-Type", "audio/webm")
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, to, len(u.data)))
	w.Header().Set("Content-Length", fmt.Sprint(to-from+1))
	w.WriteHeader(http.StatusPartialContent)
	body := u.data[from : to+1]
	if u.stallAfter > 0 && u.stalled.CompareAndSwap(false, true) {
		n, _ := w.Write(body[:u.stallAfter])
		u.sent.Add(int64(n))
		w.(http.Flusher).Flush()
		<-r.Context().Done() // hang until the client gives up
		return
	}
	n, _ := w.Write(body)
	u.sent.Add(int64(n))
}

func newWholeServer(t *testing.T, u *wholeUpstream, res resolver.Resolver) (*Server, *audiocache.Cache) {
	t.Helper()
	up := httptest.NewServer(u)
	t.Cleanup(up.Close)
	if sw, ok := res.(*switchable); ok {
		sw.url = up.URL
		sw.size = int64(len(u.data))
	}
	cache, _ := audiocache.New(t.TempDir(), 1<<30)
	s := New(Deps{Resolver: res, Audio: cache})
	t.Cleanup(func() {
		// Stop speculative work before TempDir cleanup removes its files.
		// A completed next track does not imply the other queued fill ended.
		s.PrefetchQueue(nil)
		deadline := time.Now().Add(5 * time.Second)
		for {
			active := false
			s.fills.Range(func(key, _ any) bool {
				active = active || s.fillActive(key.(string))
				return !active
			})
			if !active {
				return
			}
			if time.Now().After(deadline) {
				t.Error("cache fills did not stop before temporary directory cleanup")
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
	return s, cache
}

// A track played for the first time is fetched from upstream once: played
// from the download as it arrives, not relayed and downloaded side by side.
func TestFirstPlayDownloadsTheTrackOnce(t *testing.T) {
	u := &wholeUpstream{data: audioFile(5*streamWindow + 777)}
	s, cache := newWholeServer(t, u, &switchable{})

	srv := httptest.NewServer(s.mux)
	defer srv.Close()
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1/stream/track00010", nil)
	req.Header.Set("Range", "bytes=0-")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !bytes.Equal(got, u.data) {
		t.Fatalf("played %d of %d bytes", len(got), len(u.data))
	}
	waitComplete(t, cache, "track00010")
	if sent := u.sent.Load(); sent != int64(len(u.data)) {
		t.Fatalf("upstream sent %d bytes for a %d-byte track", sent, len(u.data))
	}
	if n := u.requests.Load(); n != 1 {
		t.Fatalf("%d upstream requests for one track", n)
	}
}

// A download that stops making progress is abandoned and resumed from where
// it got to, rather than hanging the track.
func TestStalledDownloadResumes(t *testing.T) {
	old := stallTimeout
	stallTimeout = 300 * time.Millisecond
	defer func() { stallTimeout = old }()

	u := &wholeUpstream{data: audioFile(3 * streamWindow), stallAfter: streamWindow / 2}
	s, cache := newWholeServer(t, u, &switchable{})
	s.Prefetch("track00011", true)
	waitComplete(t, cache, "track00011")

	f, _, _ := cache.Open("track00011")
	defer f.Close()
	got, _ := io.ReadAll(f)
	if !bytes.Equal(got, u.data) {
		t.Fatal("the resumed download does not match the track")
	}
}

// A track that leaves the queue stops downloading.
func TestLeavingTheQueueStopsTheDownload(t *testing.T) {
	// The default stall timeout already exceeds this test's deadline. Do not
	// restore a global timeout while the replacement prefetch is still running.

	u := &wholeUpstream{data: audioFile(4 * streamWindow), stallAfter: 1024}
	s, _ := newWholeServer(t, u, &switchable{})
	s.PrefetchQueue([]string{"track00012"})
	deadline := time.Now().Add(3 * time.Second)
	for !s.deps.Audio.Writing("track00012") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	s.PrefetchQueue([]string{"track00013"})
	deadline = time.Now().Add(3 * time.Second)
	for s.deps.Audio.Writing("track00012") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if s.deps.Audio.Writing("track00012") {
		t.Fatal("a track that left the queue kept downloading")
	}
}

// memURLs is a URLStore in memory.
type memURLs struct {
	mu sync.Mutex
	m  map[string][]byte
}

func (m *memURLs) SaveStreamURL(_ context.Context, id string, entry []byte, _ time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.m[id] = entry
	return nil
}

func (m *memURLs) StreamURL(_ context.Context, id string) ([]byte, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.m[id]
	return e, ok
}

func (m *memURLs) DropStreamURL(_ context.Context, id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.m, id)
}

// A resolution outlives the process: after a restart, a track whose URL is
// still good resolves without yt-dlp.
func TestResolutionSurvivesARestart(t *testing.T) {
	store := &memURLs{m: map[string][]byte{}}
	res := &switchable{url: "https://example/videoplayback", size: 10}
	a := New(Deps{Resolver: res, URLs: store})
	if _, err := a.resolveCached(context.Background(), "track00014"); err != nil {
		t.Fatal(err)
	}

	b := New(Deps{Resolver: res, URLs: store})
	before := res.calls.Load()
	if _, err := b.resolveCached(context.Background(), "track00014"); err != nil {
		t.Fatal(err)
	}
	if res.calls.Load() != before {
		t.Fatal("resolved again after a restart despite a stored URL")
	}
}

// A URL that would die before the track ends is not reused.
func TestAURLThatWouldExpireMidTrackIsNotReused(t *testing.T) {
	e := resolvedEntry{stream: domain.Stream{Kind: domain.StreamURL, DurationMs: 4 * 60 * 1000,
		ExpiresAt: time.Now().Add(3 * time.Minute)}}
	if e.usable(time.Now()) {
		t.Fatal("a URL with three minutes left was reused for a four-minute track")
	}
	e.stream.ExpiresAt = time.Now().Add(5 * time.Hour)
	if !e.usable(time.Now()) {
		t.Fatal("a URL good for hours was not reused")
	}
}

// Why a track failed is answered from what is known, without resolving.
func TestTrackHealthReportsARateLimitWithoutResolving(t *testing.T) {
	res := &limited{}
	s := New(Deps{Resolver: res})
	_, _ = s.resolveCached(context.Background(), "track00015")
	calls := res.calls.Load()

	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/tracks/track00015/health", nil))
	var body struct {
		RateLimited bool `json:"rateLimited"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if !body.RateLimited {
		t.Fatalf("health did not report the rate limit: %s", rec.Body.String())
	}
	if res.calls.Load() != calls {
		t.Fatal("asking about a failure resolved the track again")
	}
}

type limited struct{ calls atomic.Int32 }

func (l *limited) Name() string { return "limited" }
func (l *limited) Resolve(context.Context, string) (domain.Stream, resolver.Quality, error) {
	l.calls.Add(1)
	return domain.Stream{}, resolver.Quality{}, resolver.ErrRateLimited
}

// The engine readying the next track is not someone waiting: it must not
// cancel a guess in progress the way a click does.
func TestPreloadDoesNotPreemptBackgroundWork(t *testing.T) {
	cache, _ := audiocache.New(t.TempDir(), 1<<30)
	res := &ctxResolver{delay: 500 * time.Millisecond, started: make(chan string, 4)}
	s := New(Deps{Resolver: res, Audio: cache})

	s.Prefetch("guessed002", false)
	<-res.started
	go func() {
		rec := httptest.NewRecorder()
		s.mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/stream/preload002?preload=1", nil))
	}()
	<-res.started
	time.Sleep(700 * time.Millisecond)
	if res.cancelled.Load() != 0 {
		t.Fatal("a preload cancelled a background resolution")
	}
	// The fake URLs lead nowhere; let the retries give up before the temp
	// directory goes.
	deadline := time.Now().Add(15 * time.Second)
	for (s.fillActive("guessed002") || s.fillActive("preload002")) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
}

// A queued download that gave way to a click comes back afterwards: the
// next track still ends up ready.
func TestQueuedDownloadResumesAfterAClick(t *testing.T) {
	u := &wholeUpstream{data: audioFile(2 * streamWindow)}
	res := &switchable{delay: 400 * time.Millisecond}
	s, cache := newWholeServer(t, u, res)

	s.PrefetchQueue([]string{"playing001", "nextup0001"})
	time.Sleep(100 * time.Millisecond) // the guesses are resolving
	if _, err := s.resolveCached(context.Background(), "clicked003"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if m, ok := cache.Get("nextup0001"); ok && m.Complete() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the next track never finished downloading after the click")
}
