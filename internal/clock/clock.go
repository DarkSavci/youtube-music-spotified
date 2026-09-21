// Package clock is the time seam.
//
// Gapless scheduling, crossfade timing and the play-log "what counts as
// listened" threshold are all time-dependent. With the system clock they can
// only be verified by listening; behind this seam they become ordinary
// assertions. Two adapters justify it: system in production, manual in tests.
package clock

import (
	"sync"
	"time"
)

// Clock reports the current instant.
type Clock interface {
	Now() time.Time
}

// System is the production Clock.
type System struct{}

func (System) Now() time.Time { return time.Now() }

// Manual is a Clock that only moves when told to, so time-dependent behaviour
// is exercised exactly rather than approximately.
type Manual struct {
	mu  sync.Mutex
	now time.Time
}

// NewManual starts a Manual clock at a fixed, arbitrary instant. The value is
// deliberately not time.Now(): tests that accidentally depend on the wall
// clock should fail loudly rather than pass on most machines.
func NewManual() *Manual {
	return &Manual{now: time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)}
}

func (m *Manual) Now() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.now
}

// Advance moves the clock forward.
func (m *Manual) Advance(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.now = m.now.Add(d)
}
