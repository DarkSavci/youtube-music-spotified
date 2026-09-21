// Package resolver turns a videoId into something playable.
//
// It never implements YouTube's signature or n-parameter decipher itself.
// Phase 0 established that the current player build defeats every canonical
// extraction anchor — the split/join shape is gone, and the reverse/splice
// helper object has zero occurrences in 2.6MB of ES6 — so hand-rolling it is a
// recurring cost that lands without warning. Decipher is delegated to a
// maintained extractor behind this seam.
//
// The seam has three adapters, which comfortably justifies it: a pure-Go
// library, a yt-dlp subprocess for Premium tiers, and a fake for tests.
package resolver

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"time"

	"spotifier/internal/domain"
)

// Common failures callers may want to distinguish. Anything else is a
// transport or upstream fault and should be retried rather than interpreted.
var (
	// ErrUnavailable means the Track cannot be played at all — removed,
	// private, or blocked in this region. Skipping is the only sane response.
	ErrUnavailable = errors.New("resolver: track unavailable")

	// ErrRateLimited means upstream is refusing this address for now, not that
	// anything is wrong with the Track.
	//
	// It matters that this is its own error: treated as a track failure it
	// marks the track unplayable and skips, so a single rate limit walks the
	// whole queue and ends in silence with every entry greyed out. Recovery is
	// just waiting, and the queue must survive the wait.
	ErrRateLimited = errors.New("resolver: rate limited upstream")

	// ErrNoAudio means formats came back but none were usable. Usually a sign
	// the upstream client context has changed.
	ErrNoAudio = errors.New("resolver: no usable audio format")
)

// Quality ranks the audio a Stream carries, for the badge in the transport bar.
type Quality struct {
	// Label is display text such as "Opus 394 kbps".
	Label   string
	Bitrate int
	Codec   string
	// Premium is true for tiers only offered to subscribers.
	Premium bool
}

// Resolver produces a playable handle for a Track.
//
// Implementations must be safe for concurrent use. A resolved Stream of kind
// StreamURL is bound to the Device that resolved it — the requesting IP is
// inside the URL's signature — so it must never be cached across devices or
// handed to another machine.
type Resolver interface {
	// Resolve returns a handle for the given video.
	Resolve(ctx context.Context, videoID string) (domain.Stream, Quality, error)

	// Name identifies the adapter, for diagnostics and the health panel.
	Name() string
}

// Premium-only audio formats. Their presence in a player response is how
// subscription status is detected: the account menu carries no such signal,
// which Phase 0 established by observation.
var premiumItags = map[int]bool{
	141: true, // m4a ~287 kbps
	774: true, // opus ~394 kbps
}

// IsPremiumItag reports whether a format is subscriber-only.
func IsPremiumItag(itag int) bool { return premiumItags[itag] }

// describeQuality turns a format into a badge label.
func describeQuality(itag, bitrate int, mime string) Quality {
	codec := "AAC"
	if containsAny(mime, "opus") {
		codec = "Opus"
	}
	kbps := bitrate / 1000
	return Quality{
		Label:   fmt.Sprintf("%s %d kbps", codec, kbps),
		Bitrate: bitrate,
		Codec:   codec,
		Premium: premiumItags[itag],
	}
}

func containsAny(s string, sub string) bool {
	return len(s) >= len(sub) && indexOf(s, sub) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// expiryFrom converts an upstream expiry to an absolute instant, defaulting to
// a conservative window when none is given. Resolved URLs observed in Phase 0
// carried roughly six hours.
// expiryOfURL reads when a googlevideo URL stops working from its own
// signed "expire" parameter — a Unix time, about six hours out. Guessing
// instead meant a flat thirty minutes, so a track replayed an hour later ran
// yt-dlp again for a URL that was still good. Without the parameter, the
// guess stays short.
func expiryOfURL(raw string, now time.Time) time.Time {
	if u, err := url.Parse(raw); err == nil {
		if secs, err := strconv.ParseInt(u.Query().Get("expire"), 10, 64); err == nil && secs > now.Unix() {
			return time.Unix(secs, 0)
		}
	}
	return now.Add(30 * time.Minute)
}

func expiryFrom(seconds int64, now time.Time) time.Time {
	if seconds <= 0 {
		seconds = 5 * 3600
	}
	return now.Add(time.Duration(seconds) * time.Second)
}
