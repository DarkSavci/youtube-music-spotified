package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"spotifier/internal/audiocache"
	"spotifier/internal/domain"
	"spotifier/internal/resolver"
)

// rangedUpstream serves one file by byte range, refusing anything wider than
// a window as googlevideo does.
func rangedUpstream(t *testing.T, data []byte) (*httptest.Server, *atomic.Int32) {
	var hits atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		var from, to int64
		if _, err := fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &from, &to); err != nil || to-from+1 > streamWindow {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if from >= int64(len(data)) {
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		if to >= int64(len(data)) {
			to = int64(len(data)) - 1
		}
		w.Header().Set("Content-Type", "audio/webm")
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, to, len(data)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(data[from : to+1])
	}))
	t.Cleanup(up.Close)
	return up, &hits
}

// switchable resolves to url until told to fail, counting resolutions.
type switchable struct {
	url   string
	size  int64
	fail  atomic.Bool
	delay time.Duration
	calls atomic.Int32
}

func (r *switchable) Name() string { return "switchable" }

func (r *switchable) Resolve(ctx context.Context, id string) (domain.Stream, resolver.Quality, error) {
	r.calls.Add(1)
	if r.fail.Load() {
		return domain.Stream{}, resolver.Quality{}, errors.New("resolver down")
	}
	select {
	case <-time.After(r.delay):
	case <-ctx.Done():
		return domain.Stream{}, resolver.Quality{}, ctx.Err()
	}
	return domain.Stream{Kind: domain.StreamURL, VideoID: id, URL: r.url, SizeBytes: r.size,
		MimeType: `audio/webm; codecs="opus"`, ExpiresAt: time.Now().Add(time.Hour)}, resolver.Quality{}, nil
}

func audioFile(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i * 7)
	}
	return b
}

func streamGet(s *Server, id, rng string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/v1/stream/"+id, nil)
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	return rec
}

func waitComplete(t *testing.T, c *audiocache.Cache, id string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if m, ok := c.Get(id); ok && m.Complete() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	m, _ := c.Get(id)
	t.Fatalf("track never cached whole: %+v", m)
}

// A track played once plays again from disk, with no resolution at all.
func TestPlayedTrackIsCachedAndReplaysWithoutResolving(t *testing.T) {
	data := audioFile(3*streamWindow + 1234)
	up, _ := rangedUpstream(t, data)
	cache, _ := audiocache.New(t.TempDir(), 1<<30)
	res := &switchable{url: up.URL, size: int64(len(data))}
	s := New(Deps{Resolver: res, Audio: cache})

	if rec := streamGet(s, "track00001", "bytes=0-"); rec.Code != http.StatusPartialContent {
		t.Fatalf("first play: %d", rec.Code)
	}
	waitComplete(t, cache, "track00001")

	res.fail.Store(true)
	before := res.calls.Load()
	rec := streamGet(s, "track00001", "bytes=100-")
	if rec.Code != http.StatusPartialContent || res.calls.Load() != before {
		t.Fatalf("replay: status %d, resolutions %d -> %d", rec.Code, before, res.calls.Load())
	}
	if !bytes.Equal(rec.Body.Bytes(), data[100:100+rec.Body.Len()]) || rec.Body.Len() == 0 {
		t.Fatal("replayed bytes differ from the track")
	}
}

// A prefetched opening starts playing at once, however slow resolving is.
func TestPrefetchedOpeningStartsWithoutWaiting(t *testing.T) {
	data := audioFile(3 * streamWindow)
	up, _ := rangedUpstream(t, data)
	cache, _ := audiocache.New(t.TempDir(), 1<<30)
	res := &switchable{url: up.URL, size: int64(len(data))}
	s := New(Deps{Resolver: res, Audio: cache})

	s.Prefetch("track00002", false)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if m, ok := cache.Get("track00002"); ok && m.Have >= prefixBytes {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the opening was never prefetched")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Resolution now takes far longer than a start may. The response goes
	// on to the rest of the track as it downloads, so what is timed is the
	// opening arriving, not the whole body.
	s.streams.drop("track00002")
	res.delay = 3 * time.Second
	srv := httptest.NewServer(s.mux)
	defer srv.Close()
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1/stream/track00002", nil)
	req.Header.Set("Range", "bytes=0-")
	t0 := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	opening := make([]byte, prefixBytes)
	if _, err := io.ReadFull(resp.Body, opening); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(t0); took > 500*time.Millisecond {
		t.Fatalf("the opening waited %v for a resolution", took)
	}
	if resp.StatusCode != http.StatusPartialContent || !bytes.Equal(opening, data[:prefixBytes]) {
		t.Fatalf("opening: status %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Range"); got != fmt.Sprintf("bytes 0-%d/%d", len(data)-1, len(data)) {
		t.Fatalf("Content-Range %q", got)
	}
	// And the rest follows once the download behind it catches up.
	rest, _ := io.ReadAll(resp.Body)
	if !bytes.Equal(rest, data[prefixBytes:]) {
		t.Fatalf("the rest of the track: %d of %d bytes", len(rest), len(data)-prefixBytes)
	}
}

// An opening cached from one file is never continued with another's bytes.
func TestOpeningFromAnotherFormatIsDiscarded(t *testing.T) {
	data := audioFile(2 * streamWindow)
	up, _ := rangedUpstream(t, data)
	cache, _ := audiocache.New(t.TempDir(), 1<<30)
	w, _, _ := cache.Writer("track00003", "audio/webm", 999_999)
	_, _ = w.Write([]byte("an older, different encoding"))
	_ = w.Close()

	s := New(Deps{Resolver: &switchable{url: up.URL, size: int64(len(data))}, Audio: cache})
	s.Prefetch("track00003", true)
	waitComplete(t, cache, "track00003")
	f, _, _ := cache.Open("track00003")
	defer f.Close()
	got, _ := io.ReadAll(f)
	if !bytes.Equal(got, data) {
		t.Fatal("the cached track mixes two files")
	}
}

// ctxResolver records whether each resolution finished or was cancelled.
type ctxResolver struct {
	delay     time.Duration
	started   chan string
	cancelled atomic.Int32
}

func (r *ctxResolver) Name() string { return "ctx" }

func (r *ctxResolver) Resolve(ctx context.Context, id string) (domain.Stream, resolver.Quality, error) {
	r.started <- id
	select {
	case <-time.After(r.delay):
		return domain.Stream{Kind: domain.StreamURL, VideoID: id, URL: "http://127.0.0.1:1/" + id,
			ExpiresAt: time.Now().Add(time.Hour)}, resolver.Quality{}, nil
	case <-ctx.Done():
		r.cancelled.Add(1)
		return domain.Stream{}, resolver.Quality{}, ctx.Err()
	}
}

// A guess in progress gives way to a track someone is waiting for: a yt-dlp
// run already going was making the clicked track twice as slow to start.
func TestListenerPreemptsSpeculativeResolution(t *testing.T) {
	cache, _ := audiocache.New(t.TempDir(), 1<<30)
	res := &ctxResolver{delay: 3 * time.Second, started: make(chan string, 4)}
	s := New(Deps{Resolver: res, Audio: cache})

	s.Prefetch("guessed001", false)
	if id := <-res.started; id != "guessed001" {
		t.Fatalf("started %s", id)
	}
	done := make(chan error, 1)
	go func() { _, err := s.resolveCached(context.Background(), "clicked001"); done <- err }()
	<-res.started

	deadline := time.Now().Add(time.Second)
	for res.cancelled.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if res.cancelled.Load() != 1 {
		t.Fatal("the speculative resolution kept running")
	}
	if err := <-done; err != nil {
		t.Fatalf("the listener's resolution failed: %v", err)
	}
}
