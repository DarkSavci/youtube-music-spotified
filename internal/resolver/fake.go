package resolver

import (
	"context"
	"sync"
	"time"

	"spotifier/internal/domain"
)

// Fake resolves without a network, so Session and engine behaviour can be
// exercised deterministically.
//
// It is the third adapter at this seam and the one that makes the other two
// testable: a Session test needs resolution to succeed or fail on command, not
// to actually reach YouTube.
type Fake struct {
	mu sync.Mutex

	// FailFor makes named videos fail with the given error.
	FailFor map[string]error
	// Calls records resolution attempts in order, for assertions.
	Calls []string
	// Delay simulates resolution latency.
	Delay time.Duration
}

func NewFake() *Fake {
	return &Fake{FailFor: map[string]error{}}
}

var _ Resolver = (*Fake)(nil)

func (f *Fake) Name() string { return "fake" }

func (f *Fake) Resolve(ctx context.Context, videoID string) (domain.Stream, Quality, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, videoID)
	err := f.FailFor[videoID]
	delay := f.Delay
	f.mu.Unlock()

	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return domain.Stream{}, Quality{}, ctx.Err()
		}
	}
	if err != nil {
		return domain.Stream{}, Quality{}, err
	}
	return domain.Stream{
		Kind:       domain.StreamURL,
		VideoID:    videoID,
		URL:        "https://example.invalid/stream/" + videoID,
		MimeType:   "audio/webm; codecs=\"opus\"",
		Bitrate:    211_337,
		DurationMs: 180_000,
		ExpiresAt:  time.Now().Add(6 * time.Hour),
	}, Quality{Label: "Opus 211 kbps", Bitrate: 211_337, Codec: "Opus"}, nil
}

// Embedded hands back only the identifier, for the engine that drives
// YouTube's own player and needs no URL.
//
// Its existence is why Stream is a handle rather than always a URL: the Session
// core must not learn which engine is active.
type Embedded struct{}

var _ Resolver = (*Embedded)(nil)

func (Embedded) Name() string { return "embedded" }

func (Embedded) Resolve(_ context.Context, videoID string) (domain.Stream, Quality, error) {
	return domain.Stream{
		Kind:    domain.StreamVideoID,
		VideoID: videoID,
	}, Quality{Label: "", Codec: "AAC"}, nil
}
