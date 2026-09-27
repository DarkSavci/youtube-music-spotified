package main

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"spotifier/internal/innertube"
)

/*
upstreamLog records every request made to YouTube's API.

Only failures used to be logged, so when YouTube started answering 429 there
was no telling how many requests had been made, by what, or when. Now each
call is one line — what was asked for, which /v1 route asked, the status and
how long it took — and a summary line each minute counts them, so a burst
shows up as a number rather than having to be inferred.
*/
type upstreamLog struct {
	log *slog.Logger

	mu        sync.Mutex
	total     int
	refused   int
	limited   int
	cancelled int
	byKind    map[string]int
	byRoute   map[string]int
}

func newUpstreamLog(log *slog.Logger) *upstreamLog {
	return &upstreamLog{log: log, byKind: map[string]int{}, byRoute: map[string]int{}}
}

func (u *upstreamLog) record(r innertube.CallRecord) {
	attrs := []any{"kind", r.Kind, "route", r.Route}
	if r.Detail != "" {
		attrs = append(attrs, "detail", r.Detail)
	}
	switch {
	case r.Refused:
		attrs = append(attrs, "refused", true, "retryAfter", r.RetryAfter.Round(time.Second))
	case r.Err != nil && r.Status == 0:
		attrs = append(attrs, "err", r.Err, "took", r.Duration.Round(time.Millisecond))
	default:
		attrs = append(attrs, "status", r.Status, "took", r.Duration.Round(time.Millisecond))
		if r.RetryAfter > 0 {
			attrs = append(attrs, "retryAfter", r.RetryAfter.Round(time.Second))
		}
	}
	level := slog.LevelInfo
	if r.Refused || r.Status == 429 || r.Status == 503 {
		level = slog.LevelWarn
	}
	u.log.Log(context.Background(), level, "youtube call", attrs...)

	u.mu.Lock()
	defer u.mu.Unlock()
	if r.Refused {
		u.refused++
		return
	}
	if r.Status == 0 && errors.Is(r.Err, context.Canceled) {
		// Abandoned by whoever asked, most likely before it was sent.
		u.cancelled++
		return
	}
	u.total++
	if r.Status == 429 || r.Status == 503 {
		u.limited++
	}
	u.byKind[r.Kind]++
	u.byRoute[r.Route]++
}

// run writes the per-minute summary until ctx ends. A quiet minute writes
// nothing.
func (u *upstreamLog) run(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			u.flush()
		}
	}
}

func (u *upstreamLog) flush() {
	u.mu.Lock()
	total, refused, limited, cancelled := u.total, u.refused, u.limited, u.cancelled
	kinds, routes := u.byKind, u.byRoute
	u.total, u.refused, u.limited, u.cancelled = 0, 0, 0, 0
	u.byKind, u.byRoute = map[string]int{}, map[string]int{}
	u.mu.Unlock()
	if total == 0 && refused == 0 && cancelled == 0 {
		return
	}
	u.log.Info("youtube calls in the last minute", "sent", total, "rateLimited", limited,
		"refused", refused, "cancelled", cancelled, "byKind", counts(kinds), "byRoute", counts(routes))
}

// counts renders a tally as "a=3 b=1", largest first.
func counts(m map[string]int) string {
	type kv struct {
		k string
		n int
	}
	list := make([]kv, 0, len(m))
	for k, n := range m {
		list = append(list, kv{k, n})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].n != list[j].n {
			return list[i].n > list[j].n
		}
		return list[i].k < list[j].k
	})
	parts := make([]string, len(list))
	for i, e := range list {
		parts[i] = e.k + "=" + strconv.Itoa(e.n)
	}
	return strings.Join(parts, " ")
}
