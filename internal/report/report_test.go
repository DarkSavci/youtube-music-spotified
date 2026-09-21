package report

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"sync"
	"testing"
)

type fakeCaller struct {
	mu     sync.Mutex
	player json.RawMessage
	gets   []string
}

func (f *fakeCaller) Call(context.Context, string, map[string]any) (json.RawMessage, error) {
	return f.player, nil
}

func (f *fakeCaller) GetSigned(_ context.Context, rawURL string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gets = append(f.gets, rawURL)
	return 204, nil
}

func (f *fakeCaller) urls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.gets...)
}

const playerBody = `{
  "playbackTracking": {
    "videostatsPlaybackUrl": {"baseUrl": "https://s.youtube.com/api/stats/playback?docid=abc&ei=E1"},
    "videostatsWatchtimeUrl": {"baseUrl": "https://s.youtube.com/api/stats/watchtime?docid=abc&ei=E1"}
  },
  "videoDetails": {"lengthSeconds": "321"}
}`

func newReporter() (*Reporter, *fakeCaller) {
	f := &fakeCaller{player: json.RawMessage(playerBody)}
	r := &Reporter{Client: f}
	r.SetEnabled(true)
	return r, f
}

// Nothing is sent until reporting is switched on: writing to someone's
// account is not a side effect of installing a player.
func TestSilentUntilEnabled(t *testing.T) {
	f := &fakeCaller{player: json.RawMessage(playerBody)}
	r := &Reporter{Client: f}

	_ = r.Track(context.Background(), "abc")
	r.Progress(context.Background(), "abc", 5000)

	if len(f.urls()) != 0 {
		t.Fatalf("sent %d requests while disabled", len(f.urls()))
	}
}

/*
The first progress report marks the track as started.

Watch time that arrives without the playback ping is not attributed, so the
order matters: playback first, then watchtime.
*/
func TestFirstProgressSendsPlaybackThenWatchtime(t *testing.T) {
	r, f := newReporter()
	ctx := context.Background()
	if err := r.Track(ctx, "abc"); err != nil {
		t.Fatalf("track: %v", err)
	}
	r.Progress(ctx, "abc", 12_000)

	got := f.urls()
	if len(got) != 2 {
		t.Fatalf("sent %d pings, want 2: %v", len(got), got)
	}
	if !strings.Contains(got[0], "/stats/playback") {
		t.Fatalf("first ping was %s, want playback", got[0])
	}
	if !strings.Contains(got[1], "/stats/watchtime") {
		t.Fatalf("second ping was %s, want watchtime", got[1])
	}

	q, _ := url.Parse(got[1])
	v := q.Query()
	if v.Get("cmt") != "12.000" {
		t.Fatalf("cmt %q, want 12.000", v.Get("cmt"))
	}
	if v.Get("len") != "321" {
		t.Fatalf("len %q, want 321 from the player response", v.Get("len"))
	}
	if len(v.Get("cpn")) != 16 {
		t.Fatalf("cpn %q is not 16 characters", v.Get("cpn"))
	}
	// The signed parameters must survive untouched, or the ping is rejected.
	if v.Get("docid") != "abc" || v.Get("ei") != "E1" {
		t.Fatalf("lost the signed parameters: %v", v)
	}
}

// A paused player stops reporting rather than insisting on the same second.
func TestStalledPositionIsNotResent(t *testing.T) {
	r, f := newReporter()
	ctx := context.Background()
	_ = r.Track(ctx, "abc")

	r.Progress(ctx, "abc", 30_000)
	before := len(f.urls())
	for range 5 {
		r.Progress(ctx, "abc", 30_000)
	}
	if after := len(f.urls()); after != before {
		t.Fatalf("a stalled position sent %d more pings", after-before)
	}
}

// One nonce per run of a track, so a replay is not mistaken for a resume.
func TestEachTrackGetsItsOwnNonce(t *testing.T) {
	r, f := newReporter()
	ctx := context.Background()

	_ = r.Track(ctx, "abc")
	r.Progress(ctx, "abc", 1000)
	_ = r.Track(ctx, "def")
	r.Progress(ctx, "def", 1000)

	got := f.urls()
	first, _ := url.Parse(got[1])
	last, _ := url.Parse(got[len(got)-1])
	a, b := first.Query().Get("cpn"), last.Query().Get("cpn")
	if a == "" || b == "" || a == b {
		t.Fatalf("nonces %q and %q, want two different ones", a, b)
	}
}

// Reports for a track that is no longer the one playing are dropped: a late
// tick after a skip must not credit the wrong song.
func TestProgressForAnotherTrackIsIgnored(t *testing.T) {
	r, f := newReporter()
	ctx := context.Background()
	_ = r.Track(ctx, "abc")
	r.Progress(ctx, "stale", 9000)

	if len(f.urls()) != 0 {
		t.Fatalf("reported against a track that is not playing: %v", f.urls())
	}
}

// Turning it off mid-track stops everything immediately.
func TestDisablingStopsReporting(t *testing.T) {
	r, f := newReporter()
	ctx := context.Background()
	_ = r.Track(ctx, "abc")
	r.Progress(ctx, "abc", 5000)
	sent := len(f.urls())

	r.SetEnabled(false)
	r.Progress(ctx, "abc", 60_000)

	if len(f.urls()) != sent {
		t.Fatal("kept reporting after being turned off")
	}
}
