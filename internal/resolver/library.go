package resolver

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	ytlib "github.com/kkdai/youtube/v2"

	"spotifier/internal/domain"
)

// Library resolves through a maintained pure-Go extractor.
//
// Verified working in Phase 0: it resolved and streamed a track successfully in
// the same session where the hand-rolled decipher could not. It runs in-process
// with no extra binary, which makes it the right default.
//
// One caveat established by observation: attaching account cookies to this
// extractor's own client context made it *fail*, going from a working stream to
// HTTP 403. The library drives its own client identity and the two cannot
// simply be combined, so this adapter runs unauthenticated and therefore serves
// standard tiers only. Premium formats need the yt-dlp adapter.
//
// Standard tier is not a meaningful compromise: itag 251 is ~211 kbps Opus,
// broadly equivalent to a 320 kbps lossy stream.
type Library struct {
	client ytlib.Client
}

// NewLibrary builds the pure-Go resolver.
func NewLibrary() *Library {
	return &Library{
		client: ytlib.Client{
			HTTPClient: &http.Client{Timeout: 45 * time.Second},
		},
	}
}

var _ Resolver = (*Library)(nil)

func (l *Library) Name() string { return "library" }

func (l *Library) Resolve(ctx context.Context, videoID string) (domain.Stream, Quality, error) {
	video, err := l.client.GetVideoContext(ctx, videoID)
	if err != nil {
		return domain.Stream{}, Quality{}, classify(err)
	}

	best := bestAudio(video.Formats)
	if best == nil {
		return domain.Stream{}, Quality{}, ErrNoAudio
	}

	url, err := l.client.GetStreamURLContext(ctx, video, best)
	if err != nil {
		return domain.Stream{}, Quality{}, classify(err)
	}

	q := describeQuality(best.ItagNo, best.Bitrate, best.MimeType)
	return domain.Stream{
		Kind:       domain.StreamURL,
		VideoID:    videoID,
		URL:        url,
		MimeType:   best.MimeType,
		Bitrate:    best.Bitrate,
		SizeBytes:  best.ContentLength,
		DurationMs: video.Duration.Milliseconds(),
		ExpiresAt:  expiryOfURL(url, time.Now()),
	}, q, nil
}

// bestAudio picks the highest-bitrate audio-only format.
//
// Audio-only matters: a combined format would pull video bytes we discard,
// which on a 400 kbps audio track means downloading an order of magnitude more
// data for no benefit.
func bestAudio(formats ytlib.FormatList) *ytlib.Format {
	var best *ytlib.Format
	for i := range formats {
		f := &formats[i]
		if !strings.HasPrefix(f.MimeType, "audio/") {
			continue
		}
		if best == nil || f.Bitrate > best.Bitrate {
			best = f
		}
	}
	return best
}

// classify maps extractor errors onto the ones callers act on, so the Session
// core can tell "skip this track" from "retry later".
func classify(err error) error {
	if err == nil {
		return nil
	}
	msg := strings.ToLower(err.Error())
	switch {
	// Upstream answers 429 once an address has asked for too much, and the
	// bot check surfaces the same way. Neither says anything about the track.
	case strings.Contains(msg, "429"),
		strings.Contains(msg, "too many requests"),
		strings.Contains(msg, "not a bot"),
		strings.Contains(msg, "sign in to confirm"):
		return fmt.Errorf("%w: %v", ErrRateLimited, err)
	case strings.Contains(msg, "unavailable"),
		strings.Contains(msg, "private"),
		strings.Contains(msg, "removed"),
		strings.Contains(msg, "not available"):
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	default:
		return err
	}
}
