package resolver

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"

	"spotifier/internal/domain"
)

/*
Preferred resolver, with a fallback.

ADR 0007 names yt-dlp the default and the pure-Go library the fallback, for a
reason worth restating: the library drives its own client identity and cannot
be handed account cookies, so it reaches standard tiers only. yt-dlp applies
cookies the way a browser does and reaches the subscriber tiers.

The fallback is not a retry loop. Some failures are about the track and mean
the same to both adapters — a removed video is removed for everyone, and a
rate limit refuses the address, not the tool. Falling back on those would
double every upstream request for no gain and make a rate limit worse. Only a
failure of the preferred adapter *itself* is worth trying the other one for.
*/

// Chain resolves through a preferred adapter and falls back to another.
type Chain struct {
	Preferred Resolver
	Fallback  Resolver
	Log       *slog.Logger

	// fellBack latches once the preferred adapter has proven unusable, so a
	// broken binary costs one failed attempt rather than one per track.
	fellBack atomic.Bool
}

// NewChain builds a Chain. Either adapter may be nil, in which case the other
// is used alone.
func NewChain(preferred, fallback Resolver, log *slog.Logger) *Chain {
	if log == nil {
		log = slog.Default()
	}
	return &Chain{Preferred: preferred, Fallback: fallback, Log: log}
}

var _ Resolver = (*Chain)(nil)

func (c *Chain) Name() string {
	if c.Preferred == nil {
		return name(c.Fallback)
	}
	if c.fellBack.Load() {
		return name(c.Fallback)
	}
	return name(c.Preferred)
}

func name(r Resolver) string {
	if r == nil {
		return "none"
	}
	return r.Name()
}

func (c *Chain) Resolve(ctx context.Context, videoID string) (domain.Stream, Quality, error) {
	if c.Preferred == nil || c.fellBack.Load() {
		if c.Fallback == nil {
			return domain.Stream{}, Quality{}, errors.New("resolver: none configured")
		}
		return c.Fallback.Resolve(ctx, videoID)
	}

	stream, quality, err := c.Preferred.Resolve(ctx, videoID)
	if err == nil {
		return stream, quality, nil
	}

	// These mean the same thing to every adapter; trying again elsewhere only
	// spends another upstream request, and under a rate limit it deepens it.
	if errors.Is(err, ErrUnavailable) || errors.Is(err, ErrRateLimited) || ctx.Err() != nil {
		return domain.Stream{}, Quality{}, err
	}
	if c.Fallback == nil {
		return domain.Stream{}, Quality{}, err
	}

	c.Log.Warn("preferred resolver failed; falling back",
		"preferred", name(c.Preferred), "fallback", name(c.Fallback), "err", err)

	stream, quality, ferr := c.Fallback.Resolve(ctx, videoID)
	if ferr != nil {
		// Both failed. Report the preferred adapter's error: it is the one
		// configured to work, so its reason is the one worth acting on.
		return domain.Stream{}, Quality{}, err
	}
	// Only latch once the fallback has actually proven it can do the job,
	// so one bad track does not permanently downgrade audio quality.
	c.fellBack.Store(true)
	return stream, quality, nil
}
