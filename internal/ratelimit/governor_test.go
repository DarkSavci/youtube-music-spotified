package ratelimit

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

// fakeClock drives a Governor without real waiting: sleeping advances time.
type fakeClock struct {
	t     time.Time
	slept []time.Duration
}

func newFake(s Settings) (*Governor, *fakeClock) {
	c := &fakeClock{t: time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)}
	g := New("test", s)
	g.now = func() time.Time { return c.t }
	g.sleep = func(ctx context.Context, d time.Duration) error {
		c.slept = append(c.slept, d)
		c.t = c.t.Add(d)
		return ctx.Err()
	}
	return g, c
}

func TestBurstThenPaced(t *testing.T) {
	g, c := newFake(Settings{Rate: 4, Burst: 10})
	for i := 0; i < 10; i++ {
		release, err := g.Acquire(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		release()
	}
	if len(c.slept) != 0 {
		t.Fatalf("the burst waited: %v", c.slept)
	}
	start := c.t
	for i := 0; i < 4; i++ {
		release, err := g.Acquire(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		release()
	}
	if got := c.t.Sub(start); got < 900*time.Millisecond || got > 1100*time.Millisecond {
		t.Fatalf("four calls after the burst took %s, want about a second at 4/s", got)
	}
}

func TestInFlightCap(t *testing.T) {
	g := New("test", Settings{InFlight: 2})
	r1, _ := g.Acquire(context.Background())
	r2, _ := g.Acquire(context.Background())
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := g.Acquire(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("third call got in with two in flight: %v", err)
	}
	r1()
	r1() // releasing twice must not free a second slot
	r3, err := g.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel2()
	if _, err := g.Acquire(ctx2); err == nil {
		t.Fatal("a double release freed an extra slot")
	}
	r2()
	r3()
}

// A 429 with Retry-After holds everything back for that long, refusing at
// once and without sending.
func TestRetryAfterStartsACooldownThatRefusesAtOnce(t *testing.T) {
	g, c := newFake(Settings{Rate: 4, Burst: 10})
	h := http.Header{}
	h.Set("Retry-After", "120")
	err := g.Observe(http.StatusTooManyRequests, h, errors.New("HTTP 429"))
	if !errors.Is(err, ErrRateLimited) || RetryAfterOf(err) != 2*time.Minute {
		t.Fatalf("got %v (retry after %s)", err, RetryAfterOf(err))
	}
	_, err = g.Acquire(context.Background())
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("a call during the cooldown was not refused: %v", err)
	}
	if left := RetryAfterOf(err); left != 2*time.Minute {
		t.Fatalf("refusal says %s left", left)
	}
	if len(c.slept) != 0 {
		t.Fatal("a refused call waited instead of failing fast")
	}
	c.t = c.t.Add(2*time.Minute + time.Second)
	if _, err := g.Acquire(context.Background()); err != nil {
		t.Fatalf("still refused after the cooldown: %v", err)
	}
}

// Without Retry-After the cooldown doubles each time, is capped, and a
// success resets it.
func TestExponentialCooldown(t *testing.T) {
	g, c := newFake(Settings{})
	var got []time.Duration
	for i := 0; i < 7; i++ {
		got = append(got, RetryAfterOf(g.Observe(http.StatusTooManyRequests, nil, nil)))
		c.t = c.t.Add(time.Hour)
	}
	want := []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 10 * time.Minute, 10 * time.Minute}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("cooldowns %v, want %v", got, want)
		}
	}
	g.Observe(http.StatusOK, nil, nil)
	if d := RetryAfterOf(g.Observe(http.StatusServiceUnavailable, nil, nil)); d != 30*time.Second {
		t.Fatalf("after a success the cooldown is %s, want it back at 30s", d)
	}
}

// A Retry-After shorter than the minimum is not trusted: sending the same
// burst again a second later is how a limit is extended.
func TestShortRetryAfterIsClamped(t *testing.T) {
	g, _ := newFake(Settings{})
	h := http.Header{}
	h.Set("Retry-After", "1")
	if d := RetryAfterOf(g.Observe(http.StatusTooManyRequests, h, nil)); d != 30*time.Second {
		t.Fatalf("cooldown %s, want the 30s minimum", d)
	}
}

func TestOtherStatusesDoNotCoolDown(t *testing.T) {
	g, _ := newFake(Settings{})
	for _, st := range []int{200, 400, 403, 404, 500} {
		if err := g.Observe(st, nil, nil); err != nil {
			t.Fatalf("status %d started a cooldown", st)
		}
	}
	if cooling, _ := g.Cooling(); cooling {
		t.Fatal("cooling after ordinary errors")
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	cases := map[string]time.Duration{
		"":                              0,
		"0":                             0,
		"-5":                            0,
		"90":                            90 * time.Second,
		"Sun, 27 Sep 2026 12:05:00 GMT": 5 * time.Minute,
		"Sun, 27 Sep 2026 11:00:00 GMT": 0,
		"soon":                          0,
	}
	for in, want := range cases {
		if got := ParseRetryAfter(in, now); got != want {
			t.Errorf("ParseRetryAfter(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestCooldownHooksRun(t *testing.T) {
	g, _ := newFake(Settings{})
	var told time.Duration
	g.OnCooldown(func(d time.Duration) { told = d })
	g.CoolDown(0)
	if told != 30*time.Second {
		t.Fatalf("hook told %s", told)
	}
}

func TestNilGovernorAllowsEverything(t *testing.T) {
	var g *Governor
	release, err := g.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	release()
	if g.Observe(429, nil, nil) != nil || g.CoolDown(time.Minute) != 0 {
		t.Fatal("nil governor limited something")
	}
	if cooling, _ := g.Cooling(); cooling {
		t.Fatal("nil governor cooling")
	}
}
