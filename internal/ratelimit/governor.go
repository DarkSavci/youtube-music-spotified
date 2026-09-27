/*
Package ratelimit paces the requests this program makes to YouTube, and backs
off when YouTube says to.

Nothing used to: a launch fanned out into dozens of InnerTube calls at once,
and a 429 was answered by the UI retrying, which is exactly what keeps an
address or an account rate limited. A Governor is the one place every call
goes through. It spaces calls out (a token bucket), caps how many are in
flight, and after a 429 or 503 refuses to send anything until the cooldown
YouTube asked for — or an exponential one of its own — has passed. Refusing
is immediate and costs nothing upstream, which is the point: a request sent
into a rate limit extends it.
*/
package ratelimit

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ErrRateLimited is what a refused or rate-limited call matches with
// errors.Is. The concrete error is *Error, which carries how long to wait.
var ErrRateLimited = errors.New("rate limited by YouTube")

// Error is returned while a Governor is cooling down, and wraps a 429 or 503.
type Error struct {
	// RetryAfter is how long until the cooldown ends, from when the error was
	// made. Zero when unknown.
	RetryAfter time.Duration
	// Cause is the upstream error that started the cooldown, when this error
	// is that response rather than a refusal during one.
	Cause error
}

func (e *Error) Error() string {
	wait := ""
	if e.RetryAfter > 0 {
		wait = fmt.Sprintf("; retry in %s", e.RetryAfter.Round(time.Second))
	}
	if e.Cause != nil {
		return fmt.Sprintf("rate limited by YouTube%s: %v", wait, e.Cause)
	}
	return "rate limited by YouTube" + wait
}

func (e *Error) Is(target error) bool { return target == ErrRateLimited }
func (e *Error) Unwrap() error        { return e.Cause }

// RetryAfterOf reports how long a rate-limited error asks to wait, if it says.
func RetryAfterOf(err error) time.Duration {
	var rl *Error
	if errors.As(err, &rl) {
		return rl.RetryAfter
	}
	return 0
}

// Settings configure a Governor. Zero fields take the defaults.
type Settings struct {
	// Rate is calls per second, sustained. Zero disables pacing.
	Rate float64
	// Burst is how many calls may go out back to back after a quiet spell.
	Burst int
	// InFlight caps concurrent calls. Zero means no cap.
	InFlight int
	// MinCooldown and MaxCooldown bound the exponential cooldown used when a
	// refusal names no Retry-After.
	MinCooldown, MaxCooldown time.Duration
}

// Governor paces calls and enforces cooldowns. The zero value is not usable;
// build one with New. A nil *Governor allows everything, which is what tests
// that construct clients without one get.
type Governor struct {
	name string
	s    Settings
	now  func() time.Time
	// sleep waits for d or until ctx ends; tests replace it.
	sleep func(ctx context.Context, d time.Duration) error

	mu        sync.Mutex
	tokens    float64
	last      time.Time
	until     time.Time     // cooldown end
	probed    time.Time     // the cooldown end a probe was let through for
	coolStart time.Time     // when the running cooldown began
	backoff   time.Duration // next exponential cooldown
	inFlight  chan struct{}
	onCool    []func(time.Duration)
}

// New builds a Governor. name identifies it in logs.
func New(name string, s Settings) *Governor {
	if s.MinCooldown <= 0 {
		s.MinCooldown = 30 * time.Second
	}
	if s.MaxCooldown <= 0 {
		s.MaxCooldown = 10 * time.Minute
	}
	if s.Burst <= 0 {
		s.Burst = 1
	}
	g := &Governor{
		name:    name,
		s:       s,
		now:     time.Now,
		sleep:   sleepCtx,
		tokens:  float64(s.Burst),
		backoff: s.MinCooldown,
	}
	if s.InFlight > 0 {
		g.inFlight = make(chan struct{}, s.InFlight)
	}
	return g
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Name is the governor's label.
func (g *Governor) Name() string {
	if g == nil {
		return ""
	}
	return g.name
}

// OnCooldown registers a callback run (outside the lock) whenever a cooldown
// starts, with its length. The prefetcher uses it to stop guessing.
func (g *Governor) OnCooldown(f func(time.Duration)) {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.onCool = append(g.onCool, f)
	g.mu.Unlock()
}

// Cooling reports whether calls are being refused, and for how much longer.
func (g *Governor) Cooling() (bool, time.Duration) {
	if g == nil {
		return false, 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	left := g.until.Sub(g.now())
	return left > 0, max(left, 0)
}

// Check fails fast with *Error while cooling down, without taking a slot.
func (g *Governor) Check() error {
	if cooling, left := g.Cooling(); cooling {
		return &Error{RetryAfter: left}
	}
	return nil
}

/*
Acquire waits for a turn and returns the function that ends it.

While cooling down it refuses at once. Otherwise it waits for a token and for
an in-flight slot, either of which ctx may abandon.
*/
func (g *Governor) Acquire(ctx context.Context) (func(), error) {
	if g == nil {
		return func() {}, nil
	}
	if err := g.Check(); err != nil {
		return nil, err
	}
	for {
		wait := g.take()
		if wait <= 0 {
			break
		}
		if err := g.sleep(ctx, wait); err != nil {
			return nil, err
		}
		// A cooldown may have started while this call waited.
		if err := g.Check(); err != nil {
			return nil, err
		}
	}
	if g.inFlight != nil {
		select {
		case g.inFlight <- struct{}{}:
		case <-ctx.Done():
			// Nothing was sent, so the turn is handed back.
			g.refund()
			return nil, ctx.Err()
		}
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			if g.inFlight != nil {
				<-g.inFlight
			}
		})
	}, nil
}

// take spends a token, or reports how long until one is available.
func (g *Governor) take() time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.s.Rate <= 0 {
		return 0
	}
	now := g.now()
	if !g.last.IsZero() {
		g.tokens = math.Min(float64(g.s.Burst), g.tokens+now.Sub(g.last).Seconds()*g.s.Rate)
	}
	g.last = now
	if g.tokens >= 1 {
		g.tokens--
		return 0
	}
	need := (1 - g.tokens) / g.s.Rate
	return time.Duration(need * float64(time.Second))
}

// refund returns a token taken for a call that was never sent.
func (g *Governor) refund() {
	g.mu.Lock()
	if g.s.Rate > 0 {
		g.tokens = math.Min(float64(g.s.Burst), g.tokens+1)
	}
	g.mu.Unlock()
}

/*
Probe lets one call through during a cooldown, once per cooldown.

Someone pressing play is owed one real attempt: the cooldown may be over
upstream sooner than the guess here, and a refusal they did not cause, with
no attempt behind it, reads as a broken track. Background work never probes.
A probe that succeeds should call Succeeded, which ends the cooldown.
*/
func (g *Governor) Probe() bool {
	if g == nil {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.until.After(g.now()) || g.probed.Equal(g.until) {
		return false
	}
	g.probed = g.until
	return true
}

/*
Succeeded records a call that worked: the exponential step starts over, and a
cooldown still running is over, since upstream has just answered.

started is when the call began, and probe whether it was the cooldown's probe.
A call that began before the cooldown did says nothing about it — a slow
lookup finishing after a refusal is old news — so it changes nothing unless it
was the probe.
*/
func (g *Governor) Succeeded(started time.Time, probe bool) {
	if g == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if !probe && !g.coolStart.IsZero() && started.Before(g.coolStart) {
		return
	}
	g.backoff = g.s.MinCooldown
	g.until = time.Time{}
	g.coolStart = time.Time{}
}

/*
Observe records an upstream response's status.

A 429 or 503 starts a cooldown: as long as Retry-After says, or else the next
step of an exponential one (30 s, 1 min, 2 min … up to 10 min). Anything that
succeeds resets the exponential step. It returns the *Error to hand back for a
refusal, or nil.
*/
func (g *Governor) Observe(status int, header http.Header, cause error) error {
	if g == nil {
		return nil
	}
	if status != http.StatusTooManyRequests && status != http.StatusServiceUnavailable {
		if status >= 200 && status < 400 {
			g.mu.Lock()
			g.backoff = g.s.MinCooldown
			g.mu.Unlock()
		}
		return nil
	}
	var asked time.Duration
	if header != nil {
		asked = ParseRetryAfter(header.Get("Retry-After"), g.now())
	}
	d := g.coolDown(asked)
	return &Error{RetryAfter: d, Cause: cause}
}

// CoolDown starts a cooldown for d, or for the next exponential step when d is
// zero. Used when something other than an HTTP status says to back off, such
// as yt-dlp reporting that YouTube wants a sign-in to prove it is not a bot.
// It returns the length chosen.
func (g *Governor) CoolDown(d time.Duration) time.Duration {
	if g == nil {
		return 0
	}
	return g.coolDown(d)
}

func (g *Governor) coolDown(asked time.Duration) time.Duration {
	g.mu.Lock()
	d := asked
	if d <= 0 {
		d = min(max(g.backoff, g.s.MinCooldown), g.s.MaxCooldown)
		g.backoff = min(g.backoff*2, g.s.MaxCooldown)
	} else {
		// What upstream asked for is honoured, however long, up to an hour:
		// asking again sooner only extends it. Never shorter than the
		// minimum, though — an eager one second followed by the same burst
		// is how a limit gets extended too.
		d = min(max(d, g.s.MinCooldown), maxAskedCooldown)
	}
	now := g.now()
	wasCooling := g.until.After(now)
	if !wasCooling {
		g.coolStart = now
	}
	end := now.Add(d)
	if end.After(g.until) {
		g.until = end
	}
	if wasCooling {
		// Extended by a refusal during the cooldown — a probe that failed:
		// no second probe for the same stretch.
		g.probed = g.until
	}
	hooks := slices.Clone(g.onCool)
	g.mu.Unlock()
	for _, f := range hooks {
		f(d)
	}
	return d
}

// maxAskedCooldown caps a Retry-After, so a nonsense value cannot switch the
// program off for a day.
const maxAskedCooldown = time.Hour

// ParseRetryAfter reads a Retry-After value: seconds, or an HTTP date.
func ParseRetryAfter(v string, now time.Time) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil {
		if secs <= 0 {
			return 0
		}
		return time.Duration(secs) * time.Second
	}
	if at, err := http.ParseTime(v); err == nil {
		if d := at.Sub(now); d > 0 {
			return d
		}
	}
	return 0
}

/*
The program's governors.

API paces InnerTube: browse, next, search, player and account calls, for the
catalog and the account alike — one instance, because YouTube counts them
against the same address and account. Streams carries the cooldown for stream
resolution (yt-dlp), which YouTube limits separately and more harshly; it does
no pacing of its own because resolutions are already one at a time.
*/
var (
	API     = New("innertube", Settings{Rate: 4, Burst: 10, InFlight: 4})
	Streams = New("streams", Settings{})
)
