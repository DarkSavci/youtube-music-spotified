package api

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"spotifier/internal/domain"
	"spotifier/internal/resolver"
)

// slowResolver counts how many resolutions actually ran, and takes long
// enough that concurrent callers genuinely overlap.
type slowResolver struct {
	calls atomic.Int32
	delay time.Duration
}

func (r *slowResolver) Name() string { return "slow" }

func (r *slowResolver) Resolve(ctx context.Context, videoID string) (domain.Stream, resolver.Quality, error) {
	r.calls.Add(1)
	select {
	case <-time.After(r.delay):
	case <-ctx.Done():
		return domain.Stream{}, resolver.Quality{}, ctx.Err()
	}
	return domain.Stream{Kind: domain.StreamURL, VideoID: videoID, URL: "http://example/" + videoID},
		resolver.Quality{Label: "Opus 160 kbps"}, nil
}

/*
Playing a track asks to resolve it twice at once, and that must cost one.

The media element fetches the stream while the client asks for the track's
loudness. Both used to miss the cache and both started yt-dlp — two
subprocesses racing for the machine, which made starting a song slower than
doing nothing would have been.
*/
func TestConcurrentResolvesRunOnce(t *testing.T) {
	r := &slowResolver{delay: 150 * time.Millisecond}
	s := New(Deps{Resolver: r})

	const callers = 8
	var wg sync.WaitGroup
	got := make([]domain.Stream, callers)
	errs := make([]error, callers)
	for i := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			e, err := s.resolveCached(context.Background(), "abc123")
			got[i], errs[i] = e.stream, err
		}()
	}
	wg.Wait()

	if n := r.calls.Load(); n != 1 {
		t.Fatalf("resolved %d times for one track, want 1", n)
	}
	for i := range callers {
		if errs[i] != nil {
			t.Fatalf("caller %d: %v", i, errs[i])
		}
		// Everyone waiting gets the same answer, not a zero value.
		if got[i].URL != "http://example/abc123" {
			t.Fatalf("caller %d got %q", i, got[i].URL)
		}
	}
}

/*
And a caller that gives up does not take the others down with it.

The loudness lookup is abandoned freely — a fast skip, a closed panel — and it
is often the one that arrived first. Cancelling the shared resolution with it
would fail the request that is actually trying to play something.
*/
func TestGiveUpDoesNotCancelTheShared(t *testing.T) {
	r := &slowResolver{delay: 250 * time.Millisecond}
	s := New(Deps{Resolver: r})

	quitting, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	go func() {
		close(started)
		_, _ = s.resolveCached(quitting, "xyz789")
	}()
	<-started
	time.Sleep(30 * time.Millisecond)
	cancel()

	e, err := s.resolveCached(context.Background(), "xyz789")
	if err != nil {
		t.Fatalf("second caller failed after the first gave up: %v", err)
	}
	if e.stream.URL != "http://example/xyz789" {
		t.Fatalf("got %q", e.stream.URL)
	}
	if n := r.calls.Load(); n > 2 {
		t.Fatalf("resolved %d times, want at most 2", n)
	}
}
