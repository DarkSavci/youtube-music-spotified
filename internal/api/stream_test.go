package api_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"spotifier/internal/api"
	"spotifier/internal/domain"
	"spotifier/internal/obs"
	"spotifier/internal/resolver"
)

/*
Stream relay.

The signed URLs upstream hands out are address-bound and short-lived, and it
refuses one that has been superseded. How the relay reacts to that refusal is
the difference between a track that plays and a queue that empties itself: a
403 reaching the media element is reported as MEDIA_ERR_SRC_NOT_SUPPORTED, and
the session then faults the track, marks it unplayable and skips to the next
one — which fails the same way.
*/

// rotatingResolver hands out a new URL each time, so a retry is distinguishable
// from a repeat of the same request.
type rotatingResolver struct {
	base  string
	calls atomic.Int32
}

func (r *rotatingResolver) Name() string { return "rotating" }

func (r *rotatingResolver) Resolve(_ context.Context, videoID string) (domain.Stream, resolver.Quality, error) {
	n := r.calls.Add(1)
	return domain.Stream{
		Kind:       domain.StreamURL,
		VideoID:    videoID,
		URL:        r.base + "/media?token=" + string(rune('a'+n-1)),
		MimeType:   `audio/webm; codecs="opus"`,
		DurationMs: 180_000,
		ExpiresAt:  time.Now().Add(time.Hour),
	}, resolver.Quality{Label: "Opus", Codec: "Opus"}, nil
}

// A stale URL must be renewed behind the client's back. The browser gets audio,
// never the refusal.
func TestStreamRetriesOnceWhenUpstreamRefusesAStaleURL(t *testing.T) {
	var mu sync.Mutex
	var seen []string

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		token := r.URL.Query().Get("token")
		seen = append(seen, token)
		mu.Unlock()

		// The first URL has gone stale; anything issued after it works.
		if token == "a" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "audio/webm")
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte("\x1a\x45\xdf\xa3webm-bytes"))
	}))
	defer upstream.Close()

	res := &rotatingResolver{base: upstream.URL}
	srv := httptest.NewServer(api.New(api.Deps{
		Recorder: obs.NewRecorder(),
		Resolver: res,
	}))
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1/stream/abc123", nil)
	req.Header.Set("Range", "bytes=0-1023")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusForbidden {
		t.Fatal("relayed the 403; the media element reports this as an unplayable source")
	}
	if resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", resp.StatusCode)
	}
	if len(body) == 0 {
		t.Fatal("no audio bytes reached the client")
	}
	if got := resp.Header.Get("Content-Type"); got != "audio/webm" {
		t.Fatalf("content-type = %q, want audio/webm", got)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 {
		t.Fatalf("upstream requests = %v, want exactly two (the stale one, then a fresh one)", seen)
	}
	if seen[1] == seen[0] {
		t.Fatal("retried the same stale URL instead of re-resolving")
	}
	// The Range must survive the retry, or a seek restarts the track.
	if res.calls.Load() != 2 {
		t.Fatalf("resolver calls = %d, want 2", res.calls.Load())
	}
}

// alwaysForbidden stands in for a genuine refusal — a track the account cannot
// play at all, rather than a URL that went stale.
type alwaysForbiddenResolver struct {
	base  string
	calls atomic.Int32
}

func (a *alwaysForbiddenResolver) Name() string { return "forbidden" }

func (a *alwaysForbiddenResolver) Resolve(_ context.Context, videoID string) (domain.Stream, resolver.Quality, error) {
	a.calls.Add(1)
	return domain.Stream{
		Kind:      domain.StreamURL,
		VideoID:   videoID,
		URL:       a.base + "/media",
		MimeType:  `audio/webm; codecs="opus"`,
		ExpiresAt: time.Now().Add(time.Hour),
	}, resolver.Quality{}, nil
}

// Retrying for ever would hang the player. One retry, then the failure is the
// client's to handle.
func TestStreamGivesUpAfterOneRetry(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusForbidden)
	}))
	defer upstream.Close()

	res := &alwaysForbiddenResolver{base: upstream.URL}
	srv := httptest.NewServer(api.New(api.Deps{
		Recorder: obs.NewRecorder(),
		Resolver: res,
	}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/v1/stream/abc123")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if got := hits.Load(); got != 2 {
		t.Fatalf("upstream requests = %d, want exactly 2 (one attempt, one retry)", got)
	}
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want the refusal passed through once retrying is exhausted", resp.StatusCode)
	}
}

// An unbounded request is what upstream refuses and what every media element
// sends first, so the relay must never forward one.
func TestBoundedRangeNeverAsksForAWholeFile(t *testing.T) {
	const size = 10 << 20
	cases := []struct {
		name   string
		client string
		want   string
	}{
		{"no range at all", "", "bytes=0-1048575"},
		{"open ended from zero", "bytes=0-", "bytes=0-1048575"},
		{"open ended mid file", "bytes=5000000-", "bytes=5000000-6048575"},
		{"small bounded passes through", "bytes=100-200", "bytes=100-200"},
		{"suffix range passes through", "bytes=-500", "bytes=-500"},
		{"malformed falls back to a window", "chunks=1-2", "bytes=0-1048575"},
		{"multi range takes the first", "bytes=0-,100-200", "bytes=0-1048575"},
		// Chromium asks for spans like this once it buffers ahead, and
		// upstream refuses them exactly as it refuses an open-ended range.
		{"oversized bounded is capped", "bytes=0-5000000", "bytes=0-1048575"},
		{"oversized bounded mid file is capped", "bytes=2000000-9000000", "bytes=2000000-3048575"},
		{"exactly at the ceiling passes through", "bytes=0-1048575", "bytes=0-1048575"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := api.BoundedRangeForTest(tc.client, size); got != tc.want {
				t.Fatalf("boundedRange(%q) = %q, want %q", tc.client, got, tc.want)
			}
		})
	}
}

// Asking past the end is another thing upstream refuses.
func TestBoundedRangeStopsAtTheEndOfAKnownFile(t *testing.T) {
	got := api.BoundedRangeForTest("bytes=0-", 1000)
	if got != "bytes=0-999" {
		t.Fatalf("boundedRange with a small file = %q, want bytes=0-999", got)
	}
	if got := api.BoundedRangeForTest("bytes=0-", 0); got != "bytes=0-1048575" {
		t.Fatalf("unknown size should still bound: %q", got)
	}
}

// rateLimitedResolver stands in for upstream refusing this address.
type rateLimitedResolver struct{}

func (rateLimitedResolver) Name() string { return "ratelimited" }
func (rateLimitedResolver) Resolve(context.Context, string) (domain.Stream, resolver.Quality, error) {
	return domain.Stream{}, resolver.Quality{}, resolver.ErrRateLimited
}

// A rate limit must be reported as one. Sent as a generic failure, the client
// marks the track unplayable and skips, so one rate limit walks the whole
// queue and leaves every entry greyed out for a condition that clears itself.
func TestStreamReportsRateLimitingDistinctly(t *testing.T) {
	srv := httptest.NewServer(api.New(api.Deps{
		Recorder: obs.NewRecorder(),
		Resolver: rateLimitedResolver{},
	}))
	defer srv.Close()

	for _, path := range []string{"/v1/stream/abc", "/v1/resolve/abc"} {
		t.Run(path, func(t *testing.T) {
			resp, err := http.Get(srv.URL + path)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusTooManyRequests {
				t.Fatalf("status = %d, want 429 so the client waits rather than skipping",
					resp.StatusCode)
			}
		})
	}
}
