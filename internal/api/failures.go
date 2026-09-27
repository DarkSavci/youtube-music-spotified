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
}

const (
	unavailableMemo = time.Hour
	failureMemoTTL  = 2 * time.Minute
)

func (m *failureMemo) clock() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now()
}

func (m *failureMemo) recall(videoID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.entries[videoID]
	if !ok {
		return nil
	}
	if !m.clock().Before(f.until) {
		delete(m.entries, videoID)
		return nil
	}
	return f.err
}

func (m *failureMemo) remember(videoID string, err error) {
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
	m.entries[videoID] = failure{err: err, until: m.clock().Add(ttl)}
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
