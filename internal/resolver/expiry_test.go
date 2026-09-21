package resolver

import (
	"testing"
	"time"
)

func TestExpiryComesFromTheURL(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	got := expiryOfURL("https://rr1---sn-x.googlevideo.com/videoplayback?expire=1800021600&itag=774", now)
	if want := time.Unix(1_800_021_600, 0); !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// No parameter, or one already past: a short guess, never a long one.
	for _, raw := range []string{"https://example/videoplayback?itag=774", "https://x/?expire=5"} {
		if d := expiryOfURL(raw, now).Sub(now); d != 30*time.Minute {
			t.Errorf("%s: guessed %v", raw, d)
		}
	}
}
