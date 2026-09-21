package session

import (
	"context"
	"runtime"
	"testing"
	"time"

	"spotifier/internal/clock"
	"spotifier/internal/domain"
)

/*
Soak.

A music player runs for hours. The failures that matter over that span are not
logic errors — those show up immediately — but slow leaks: a goroutine per
reconnect, a subscriber that is never released, unbounded state that grows with
every skipped track.

These run by default because they are seconds long, not hours. They are shaped
to catch the leak, not to simulate real elapsed time: churn the paths that leak
thousands of times, then assert the counts came back down.

	go test ./internal/session/ -run Soak -v
*/

// measure settles the runtime and reports live heap and goroutine count.
func measure() (heapBytes uint64, goroutines int) {
	// Two collections: the first drops garbage, the second collects anything
	// that became unreachable during the first. Without it the reading is
	// noisy enough to hide a real leak.
	runtime.GC()
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc, runtime.NumGoroutine()
}

// Subscribers come and go constantly in use: every reconnect, every reload,
// every device waking up. A cancel that does not actually release is the
// classic leak in a fan-out hub.
func TestSoakSubscriberChurn(t *testing.T) {
	h, _ := newHub(t)
	ctx := context.Background()
	h.Register("laptop", "Laptop", fullCaps())
	h.Command(ctx, "laptop", Command{Kind: CmdPlay, Tracks: tracks(10)})

	// Warm up so the baseline is not measuring first-use allocation.
	for range 100 {
		_, cancel := h.Subscribe()
		cancel()
	}
	baseHeap, baseGoroutines := measure()

	const cycles = 5000
	for range cycles {
		ch, cancel := h.Subscribe()
		// Drain the initial projection, as a real subscriber would.
		select {
		case <-ch:
		default:
		}
		cancel()
	}

	heap, goroutines := measure()

	h.mu.Lock()
	remaining := len(h.subscribers)
	h.mu.Unlock()

	t.Logf("%d subscribe/cancel cycles: goroutines %d -> %d, heap %s -> %s, subscribers left %d",
		cycles, baseGoroutines, goroutines, human(baseHeap), human(heap), remaining)

	if remaining != 0 {
		t.Errorf("%d subscribers were never released", remaining)
	}
	if goroutines > baseGoroutines+10 {
		t.Errorf("goroutines grew %d -> %d across %d cycles", baseGoroutines, goroutines, cycles)
	}
}

// Skipping is the most-repeated action in a long session, and the one that
// appends: degraded entries, log entries, shuffle orders.
func TestSoakContinuousPlayback(t *testing.T) {
	h, sink := newHub(t)
	ctx := context.Background()
	clk := clock.NewManual()
	h.clk = clk
	h.Register("laptop", "Laptop", fullCaps())

	ch, cancel := h.Subscribe()
	defer cancel()
	// A real subscriber drains continuously; without this the lossy channel
	// would mask a leak by dropping everything.
	go func() {
		for range ch {
		}
	}()

	h.Command(ctx, "laptop", Command{Kind: CmdPlay, Tracks: tracks(50), Origin: "Soak"})
	baseHeap, baseGoroutines := measure()

	// Roughly a day of listening at three minutes a track.
	const plays = 5000
	for i := range plays {
		epoch := h.Projection().State.Epoch
		h.EngineEvent(ctx, "laptop", EngineEvent{Kind: EvPosition, Epoch: epoch, PositionMs: 45_000})
		clk.Advance(3 * time.Minute)
		h.EngineEvent(ctx, "laptop", EngineEvent{Kind: EvEnded, Epoch: epoch})

		// Re-queue when the queue runs out, as autoplay would.
		if i%49 == 48 {
			h.Command(ctx, "laptop", Command{Kind: CmdPlay, Tracks: tracks(50), Origin: "Soak"})
		}
	}

	heap, goroutines := measure()
	state := h.Projection().State

	t.Logf("%d plays: goroutines %d -> %d, heap %s -> %s, log entries %d, degraded %d",
		plays, baseGoroutines, goroutines, human(baseHeap), human(heap),
		len(sink.entries), len(state.Degraded))

	if goroutines > baseGoroutines+10 {
		t.Errorf("goroutines grew %d -> %d over %d plays", baseGoroutines, goroutines, plays)
	}
	// Queue length is bounded by what was queued, never by how long the app ran.
	if len(state.Queue.Items) > 50 {
		t.Errorf("queue grew to %d items; it should stay bounded", len(state.Queue.Items))
	}
	if state.Queue.Index < 0 || state.Queue.Index >= len(state.Queue.Items) {
		t.Errorf("queue index escaped bounds after %d plays: %d of %d",
			plays, state.Queue.Index, len(state.Queue.Items))
	}
}

// A long run in a bad region or with an expired session is mostly failures.
// Degraded entries accumulate per play, so this is where unbounded growth
// would show up first.
func TestSoakSustainedFailures(t *testing.T) {
	h, _ := newHub(t)
	ctx := context.Background()
	h.Register("laptop", "Laptop", fullCaps())

	baseHeap, baseGoroutines := measure()

	const rounds = 2000
	for range rounds {
		h.Command(ctx, "laptop", Command{Kind: CmdPlay, Tracks: tracks(10)})
		for range 5 {
			h.EngineEvent(ctx, "laptop", EngineEvent{
				Kind: EvFailed, Epoch: h.Projection().State.Epoch, Reason: "403",
			})
		}
	}

	heap, goroutines := measure()
	degraded := len(h.Projection().State.Degraded)

	t.Logf("%d failure rounds: goroutines %d -> %d, heap %s -> %s, degraded entries %d",
		rounds, baseGoroutines, goroutines, human(baseHeap), human(heap), degraded)

	if goroutines > baseGoroutines+10 {
		t.Errorf("goroutines grew %d -> %d under sustained failure", baseGoroutines, goroutines)
	}
	// Each Play resets Degraded, so it tracks the current queue rather than
	// the whole session. Growing with uptime would be the leak.
	if degraded > 10 {
		t.Errorf("degraded entries accumulated to %d; they should reset per queue", degraded)
	}
	if got := h.Projection().State.State; got != domain.StatePaused {
		t.Errorf("state = %s; repeated failures should stop rather than race to the end", got)
	}
}

// Devices joining and leaving is the Connect equivalent of subscriber churn.
func TestSoakDeviceChurn(t *testing.T) {
	h, _ := newHub(t)
	ctx := context.Background()
	h.Register("anchor", "Anchor", fullCaps())
	h.Command(ctx, "anchor", Command{Kind: CmdPlay, Tracks: tracks(10)})

	baseHeap, baseGoroutines := measure()

	const cycles = 3000
	for i := range cycles {
		id := "transient"
		h.Register(id, "Transient", limitedCaps())
		h.Command(ctx, id, Command{Kind: CmdNext})
		h.Unregister(id)
		_ = i
	}

	heap, goroutines := measure()
	h.mu.Lock()
	devices := len(h.devices)
	h.mu.Unlock()

	t.Logf("%d device join/leave cycles: goroutines %d -> %d, heap %s -> %s, devices left %d",
		cycles, baseGoroutines, goroutines, human(baseHeap), human(heap), devices)

	if devices != 1 {
		t.Errorf("%d devices remain; only the anchor should", devices)
	}
	if goroutines > baseGoroutines+10 {
		t.Errorf("goroutines grew %d -> %d across device churn", baseGoroutines, goroutines)
	}
	// The anchor keeps ownership throughout, so playback never stops.
	if owner := h.Projection().State.OwnerDeviceID; owner != "anchor" {
		t.Errorf("owner = %q after churn, want anchor", owner)
	}
}

func human(b uint64) string {
	const unit = 1024
	if b < unit {
		return string(rune('0'+b%10)) + "B"
	}
	div, exp := uint64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return formatFloat(float64(b)/float64(div)) + string("KMGT"[exp]) + "iB"
}

func formatFloat(f float64) string {
	whole := int(f)
	frac := int((f - float64(whole)) * 10)
	return itoa(whole) + "." + itoa(frac)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
