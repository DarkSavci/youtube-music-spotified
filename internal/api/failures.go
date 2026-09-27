package api

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"time"

	"spotifier/internal/resolver"
)

/*
failureMemo remembers resolutions that failed.

A track that cannot be resolved was asked for again by everything that wanted
it — the stream, its preload, the silence probe, the health check, a retry —
and each ask ran yt-dlp again: two runs and the pure-Go fallback, all to get
the same answer. Now the answer is kept for a while: an hour for a track
YouTube says is unavailable, two minutes for anything else. Rate limits are the
governor's business, and a network fault is not remembered at all, so a
connection coming back is not met with a stale failure.
*/
type failureMemo struct {
	mu      sync.Mutex
	entries map[string]failure
	now     func() time.Time
}

type failure struct {
	err   error
	until time.Time
	// direct is when a play (not a guess) last failed this way; zero if only
	// guesses have.
	direct time.Time
}

const (
	unavailableMemo = time.Hour
	failureMemoTTL  = 2 * time.Minute
	// directWindow is how long a failed play answers the next play from
	// memory: long enough to cover the stream, loudness, health and silence
	// asks that arrive together and the automatic retries right after, short
	// enough that someone pressing play again gets a fresh attempt.
	directWindow = 15 * time.Second
)

func (m *failureMemo) clock() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now()
}

// recall returns the remembered failure for a track, if any. For a play
// (direct), only a failed play in the last directWindow counts.
func (m *failureMemo) recall(videoID string, direct bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.entries[videoID]
	if !ok {
		return nil
	}
	now := m.clock()
	if !now.Before(f.until) {
		delete(m.entries, videoID)
		return nil
	}
	if direct && (f.direct.IsZero() || now.Sub(f.direct) >= directWindow) {
		return nil
	}
	return f.err
}

// clear forgets every failure: after a sign-in, what failed may now work.
func (m *failureMemo) clear() {
	m.mu.Lock()
	m.entries = nil
	m.mu.Unlock()
}

func (m *failureMemo) remember(videoID string, err error, direct bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err == nil {
		delete(m.entries, videoID)
		return
	}
	ttl := memoFor(err)
	if ttl <= 0 {
		return
	}
	if m.entries == nil {
		m.entries = map[string]failure{}
	}
	if len(m.entries) > 1000 {
		m.entries = map[string]failure{}
	}
	f := failure{err: err, until: m.clock().Add(ttl)}
	if direct {
		f.direct = m.clock()
	}
	m.entries[videoID] = f
}

func (m *failureMemo) forget(videoID string) {
	m.mu.Lock()
	delete(m.entries, videoID)
	m.mu.Unlock()
}

func memoFor(err error) time.Duration {
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return 0
	case errors.Is(err, resolver.ErrRateLimited):
		return 0
	case errors.Is(err, resolver.ErrUnavailable):
		return unavailableMemo
	case networkFault(err):
		return 0
	default:
		return failureMemoTTL
	}
}

// networkFault reports errors that mean this machine could not reach YouTube,
// as opposed to YouTube refusing: yt-dlp reports them only as text.
func networkFault(err error) bool {
	var ne net.Error
	if errors.As(err, &ne) {
		return true
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return true
	}
	msg := strings.ToLower(err.Error())
	for _, s := range []string{"getaddrinfo", "no such host", "network is unreachable",
		"connection refused", "connection reset", "timed out", "timeout",
		"unable to connect", "failed to resolve", "temporary failure in name resolution",
		"no route to host", "connectex"} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

type reasonKey struct{}

// withReason says why a resolution is being asked for, for the log line it
// produces: play, preload, queue, hover, page, search, loudness, health.
func withReason(ctx context.Context, reason string) context.Context {
	return context.WithValue(ctx, reasonKey{}, reason)
}

func resolveReason(ctx context.Context, speculative bool) string {
	if r, ok := ctx.Value(reasonKey{}).(string); ok && r != "" {
		return r
	}
	if speculative {
		return "speculative"
	}
	return "other"
}
