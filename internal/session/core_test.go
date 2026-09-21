package session

import (
	"testing"
	"time"

	"spotifier/internal/clock"
	"spotifier/internal/domain"
)

// The whole point of a pure core: every behaviour below is exercised with a
// manual clock and no engine, no sockets and no audio.

func tracks(n int) []domain.Track {
	out := make([]domain.Track, n)
	for i := range n {
		out[i] = domain.Track{
			ID:         string(rune('a' + i)),
			Title:      string(rune('A' + i)),
			DurationMs: 180_000,
			Playable:   true,
		}
	}
	return out
}

func newCore(t *testing.T) (*Core, *clock.Manual) {
	t.Helper()
	clk := clock.NewManual()
	return New(clk, DefaultSettings(), 42), clk
}

func playN(t *testing.T, c *Core, n int) {
	t.Helper()
	if r, _ := c.Apply(Command{Kind: CmdPlay, Tracks: tracks(n), Origin: "Test"}); r != RejectNone {
		t.Fatalf("play rejected: %s", r)
	}
}

func currentID(c *Core) string {
	if cur := c.State().Queue.Current(); cur != nil {
		return cur.ID
	}
	return ""
}

// ---------- queue semantics ----------

func TestPlayAndAdvance(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)

	if got := currentID(c); got != "a" {
		t.Fatalf("current = %q, want a", got)
	}
	if c.State().State != domain.StatePlaying {
		t.Fatal("should be playing after play")
	}
	c.Apply(Command{Kind: CmdNext})
	if got := currentID(c); got != "b" {
		t.Fatalf("after next: %q, want b", got)
	}
}

func TestQueueEndStopsWithoutRepeat(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 2)
	c.Apply(Command{Kind: CmdNext})
	c.Apply(Command{Kind: CmdNext}) // past the end

	// Stopping at the end rather than wrapping, and holding the last track so
	// the transport bar still shows something.
	if c.State().State != domain.StatePaused {
		t.Errorf("state = %s, want paused at end of queue", c.State().State)
	}
	if currentID(c) != "b" {
		t.Errorf("should hold the last track, got %q", currentID(c))
	}
}

func TestRepeatAllWraps(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 2)
	c.Apply(Command{Kind: CmdSetRepeat, Repeat: domain.RepeatAll})
	c.Apply(Command{Kind: CmdNext})
	c.Apply(Command{Kind: CmdNext})
	if got := currentID(c); got != "a" {
		t.Errorf("repeat-all should wrap to a, got %q", got)
	}
}

func TestRepeatOneReplaysSameTrack(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.Apply(Command{Kind: CmdSetRepeat, Repeat: domain.RepeatOne})

	epoch := c.State().Epoch
	c.HandleEngine(EngineEvent{Kind: EvEnded, Epoch: epoch})

	if got := currentID(c); got != "a" {
		t.Errorf("repeat-one should replay a, got %q", got)
	}
	if c.State().Epoch == epoch {
		t.Error("replaying should advance the epoch so stale reports are dropped")
	}
}

// Previous restarts the track once past the opening seconds, and only steps
// back before that.
func TestPrevRestartsAfterThreeSeconds(t *testing.T) {
	c, clk := newCore(t)
	playN(t, c, 3)
	c.Apply(Command{Kind: CmdNext}) // on "b"

	clk.Advance(5 * time.Second)
	c.Apply(Command{Kind: CmdPrev})
	if got := currentID(c); got != "b" {
		t.Errorf("prev past 3s should restart b, moved to %q", got)
	}
	if pos := c.State().PositionMs; pos != 0 {
		t.Errorf("restart should seek to 0, got %d", pos)
	}

	c.Apply(Command{Kind: CmdPrev}) // now at 0s, steps back
	if got := currentID(c); got != "a" {
		t.Errorf("prev within 3s should step back to a, got %q", got)
	}
}

// ---------- shuffle ----------

func TestShuffleKeepsCurrentTrackPlaying(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 10)
	c.Apply(Command{Kind: CmdNext})
	c.Apply(Command{Kind: CmdNext}) // on "c"
	before := currentID(c)

	c.Apply(Command{Kind: CmdSetShuffle, Shuffle: true})
	if after := currentID(c); after != before {
		t.Errorf("turning shuffle on changed the playing track: %q -> %q", before, after)
	}
}

func TestShuffleVisitsEveryTrackOnce(t *testing.T) {
	c, _ := newCore(t)
	const n = 8
	playN(t, c, n)
	c.Apply(Command{Kind: CmdSetShuffle, Shuffle: true})

	seen := map[string]int{currentID(c): 1}
	for range n - 1 {
		c.Apply(Command{Kind: CmdNext})
		seen[currentID(c)]++
	}
	if len(seen) != n {
		t.Errorf("shuffle visited %d distinct tracks, want %d: %v", len(seen), n, seen)
	}
	for id, count := range seen {
		if count != 1 {
			t.Errorf("track %q visited %d times", id, count)
		}
	}
}

func TestShuffleOffRestoresOrder(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 5)
	c.Apply(Command{Kind: CmdSetShuffle, Shuffle: true})
	c.Apply(Command{Kind: CmdSetShuffle, Shuffle: false})

	// The queue itself is never rewritten, only the traversal order.
	for i, tr := range c.State().Queue.Items {
		if tr.ID != string(rune('a'+i)) {
			t.Fatalf("queue order was mutated by shuffle: %v", c.State().Queue.Items)
		}
	}
}

// ---------- epochs ----------

// A swapped-out engine reporting late must not skip the track that just
// started. This is the race epochs exist to close.
func TestStaleEngineEventIsIgnored(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	staleEpoch := c.State().Epoch

	c.Apply(Command{Kind: CmdNext}) // now on "b", epoch advanced
	if currentID(c) != "b" {
		t.Fatal("setup: expected to be on b")
	}

	// The old engine finally reports that "a" ended.
	c.HandleEngine(EngineEvent{Kind: EvEnded, Epoch: staleEpoch})

	if got := currentID(c); got != "b" {
		t.Errorf("stale ended event skipped a track: now on %q, want b", got)
	}
}

func TestTransferAdvancesEpoch(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 2)
	before := c.State().Epoch
	c.Apply(Command{Kind: CmdTransfer, DeviceID: "living-room"})

	if c.State().Epoch == before {
		t.Error("transfer must advance the epoch; the new owner resolves its own stream")
	}
	if c.State().OwnerDeviceID != "living-room" {
		t.Errorf("owner = %q", c.State().OwnerDeviceID)
	}
}

// ---------- failure ladder ----------

func TestFailureSkipsAndRecords(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 5)

	logs := c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: c.State().Epoch, Reason: "403"})

	if got := currentID(c); got != "b" {
		t.Errorf("failure should advance to b, got %q", got)
	}
	if len(c.State().Degraded) != 1 || c.State().Degraded[0].Reason != "403" {
		t.Errorf("failure not recorded: %+v", c.State().Degraded)
	}
	if len(logs) == 0 || !logs[0].Failed {
		t.Errorf("failure should emit a log entry, got %+v", logs)
	}
	if c.State().Queue.Items[0].Playable {
		t.Error("failed track should be marked unplayable so the UI can grey it")
	}
}

// Repeated failures must stop, not race silently to the end of the queue.
func TestConsecutiveFailuresPause(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 20)

	for range maxConsecutiveFaults {
		c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: c.State().Epoch, Reason: "unavailable"})
	}

	if c.State().State != domain.StatePaused {
		t.Errorf("state = %s, want paused after %d consecutive failures",
			c.State().State, maxConsecutiveFaults)
	}
	if len(c.State().Degraded) != maxConsecutiveFaults {
		t.Errorf("recorded %d faults, want %d", len(c.State().Degraded), maxConsecutiveFaults)
	}
}

func TestSuccessfulLoadResetsFaultCounter(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 10)

	c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: c.State().Epoch, Reason: "403"})
	c.HandleEngine(EngineEvent{Kind: EvLoaded, Epoch: c.State().Epoch, DurationMs: 200_000})
	c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: c.State().Epoch, Reason: "403"})
	c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: c.State().Epoch, Reason: "403"})

	// Two failures since the last success: below the limit, so still playing.
	if c.State().State == domain.StatePaused {
		t.Error("a successful load should reset the fault counter")
	}
}

// ---------- play log ----------

func TestShortPlayIsNotLogged(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)

	c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: c.State().Epoch, PositionMs: 5_000})
	_, logs := c.Apply(Command{Kind: CmdNext})

	if len(logs) != 0 {
		t.Errorf("5s of a 3m track should not count as listened, got %+v", logs)
	}
}

func TestPassingThresholdIsLogged(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)

	c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: c.State().Epoch, PositionMs: 45_000})
	_, logs := c.Apply(Command{Kind: CmdNext})

	if len(logs) != 1 {
		t.Fatalf("expected one log entry, got %+v", logs)
	}
	if logs[0].TrackID != "a" || logs[0].PlayedMs < 30_000 {
		t.Errorf("unexpected entry: %+v", logs[0])
	}
	if logs[0].Origin != "Test" {
		t.Errorf("origin not carried into the log: %q", logs[0].Origin)
	}
}

// Scrubbing back and forth must not inflate listened time.
func TestSeekingDoesNotInflateListenedTime(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 2)
	e := c.State().Epoch

	c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: e, PositionMs: 10_000})
	c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: e, PositionMs: 2_000}) // scrubbed back
	c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: e, PositionMs: 9_000}) // replayed

	_, logs := c.Apply(Command{Kind: CmdNext})
	if len(logs) != 0 {
		t.Errorf("only ~17s of forward progress; should not be logged: %+v", logs)
	}
}

func TestCompletedTrackIsLoggedRegardlessOfThreshold(t *testing.T) {
	c, _ := newCore(t)
	short := []domain.Track{{ID: "s", Title: "Short", DurationMs: 8_000, Playable: true}}
	c.Apply(Command{Kind: CmdPlay, Tracks: short, Origin: "Test"})

	c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: c.State().Epoch, PositionMs: 8_000})
	logs := c.HandleEngine(EngineEvent{Kind: EvEnded, Epoch: c.State().Epoch})

	if len(logs) == 0 || !logs[0].Completed {
		t.Errorf("a track played to the end should be logged as completed: %+v", logs)
	}
}

// ---------- queue editing ----------

func TestEnqueueAboveCurrentKeepsPlayingTrack(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.Apply(Command{Kind: CmdNext}) // on "b"

	c.Apply(Command{Kind: CmdEnqueue, Insert: tracks(2), At: 0})
	if got := currentID(c); got != "b" {
		t.Errorf("inserting above current changed playback: now %q", got)
	}
}

func TestMoveKeepsPlayingTrack(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 5)
	c.Apply(Command{Kind: CmdNext})
	c.Apply(Command{Kind: CmdNext}) // on "c"

	c.Apply(Command{Kind: CmdMove, From: 0, To: 4})
	if got := currentID(c); got != "c" {
		t.Errorf("reordering changed what is sounding: now %q", got)
	}
}

func TestRemoveCurrentSlidesNextIntoPlace(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.Apply(Command{Kind: CmdNext}) // on "b", index 1

	c.Apply(Command{Kind: CmdRemove, At: 1})
	if got := currentID(c); got != "c" {
		t.Errorf("removing the current track should slide c into place, got %q", got)
	}
}

func TestOutOfRangeEditsAreRejected(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	for _, cmd := range []Command{
		{Kind: CmdRemove, At: 99},
		{Kind: CmdMove, From: 0, To: 99},
		{Kind: CmdPlay, Tracks: tracks(2), StartIndex: 5},
	} {
		if r, _ := c.Apply(cmd); r != RejectOutOfRange {
			t.Errorf("%s should be rejected as out of range, got %q", cmd.Kind, r)
		}
	}
}

func TestCommandsOnEmptyQueueAreRejectedNotPanicking(t *testing.T) {
	c, _ := newCore(t)
	for _, cmd := range []Command{
		{Kind: CmdToggle}, {Kind: CmdNext}, {Kind: CmdPrev}, {Kind: CmdSeek, PositionMs: 1000},
	} {
		if r, _ := c.Apply(cmd); r != RejectEmptyQueue {
			t.Errorf("%s on empty queue: got %q, want empty_queue", cmd.Kind, r)
		}
	}
}

// ---------- target ----------

// Gapless needs the next track named ahead of time; without a preload there is
// nothing to be gapless with.
func TestTargetNamesNextTrackForPreload(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)

	target := c.Target()
	if target.VideoID != "a" {
		t.Errorf("target video = %q, want a", target.VideoID)
	}
	if target.PreloadVideoID != "b" {
		t.Errorf("preload = %q, want b", target.PreloadVideoID)
	}
	if target.Transition.Kind != "gapless" {
		t.Errorf("transition = %q, want gapless by default", target.Transition.Kind)
	}
}

// Crossfade is only requested when the engine can actually do it; asking an
// engine for something it cannot deliver is how silent breakage starts.
func TestTargetRespectsEngineCapability(t *testing.T) {
	clk := clock.NewManual()
	c := New(clk, Settings{CrossfadeMs: 6000, Gapless: true, ListenedThreshold: 30 * time.Second}, 1)
	playN(t, c, 2)

	c.SetCapabilities(Capabilities{Crossfade: "none"})
	if got := c.Target().Transition.Kind; got == "crossfade" {
		t.Error("requested crossfade from an engine that cannot do it")
	}

	c.SetCapabilities(Capabilities{Crossfade: "true"})
	if got := c.Target().Transition; got.Kind != "crossfade" || got.Ms != 6000 {
		t.Errorf("transition = %+v, want 6000ms crossfade", got)
	}
}

func TestTargetOnEmptyQueueIsInert(t *testing.T) {
	c, _ := newCore(t)
	if got := c.Target(); got.VideoID != "" || got.Playing {
		t.Errorf("empty queue should produce an inert target, got %+v", got)
	}
}

func TestVolumeIsClamped(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 1)
	for _, in := range []float64{-5, 0.5, 99} {
		c.Apply(Command{Kind: CmdSetVolume, Volume: in})
		v := c.State().Volume
		// Up to 200%: volume boost goes past full scale.
		if v < 0 || v > MaxVolume {
			t.Errorf("volume %v escaped [0,%v]: %v", in, MaxVolume, v)
		}
	}
}

// Version must advance on every accepted change, since consumers drop any
// projection that is not newer than what they hold.
func TestVersionAdvancesOnEveryChange(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	prev := c.State().Version

	for _, cmd := range []Command{
		{Kind: CmdNext}, {Kind: CmdToggle}, {Kind: CmdSetShuffle, Shuffle: true},
		{Kind: CmdSetRepeat, Repeat: domain.RepeatAll}, {Kind: CmdSeek, PositionMs: 5000},
	} {
		c.Apply(cmd)
		if c.State().Version <= prev {
			t.Fatalf("%s did not advance the version (%d)", cmd.Kind, c.State().Version)
		}
		prev = c.State().Version
	}
}

// ---------- autoplay refusal ----------

// A browser refusing to start without a user gesture is not a broken track.
// Reporting it as a failure would mark each track unplayable in turn, write a
// failed play for each, and leave the user several tracks past the one they
// asked for — which is what "I can't play a song" looks like from the inside.
func TestBlockedPausesWithoutSkippingOrFaulting(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)

	logs := c.HandleEngine(EngineEvent{Kind: EvBlocked, Epoch: c.State().Epoch})

	st := c.State()
	if st.Queue.Index != 0 {
		t.Fatalf("queue advanced past the requested track: index %d", st.Queue.Index)
	}
	if got := currentID(c); got != "a" {
		t.Fatalf("current = %q, want a", got)
	}
	if !st.Queue.Items[0].Playable {
		t.Fatal("track marked unplayable by a permission refusal")
	}
	if len(st.Degraded) != 0 {
		t.Fatalf("recorded a fault for a track that is fine: %+v", st.Degraded)
	}
	if len(logs) != 0 {
		t.Fatalf("wrote a play-log entry for a track that never played: %+v", logs)
	}
	if st.State != domain.StatePaused {
		t.Fatalf("state = %v, want paused so the next press carries a gesture", st.State)
	}
	if c.Target().Playing {
		t.Fatal("target still asks the engine to play; it will be refused again")
	}
}

// Once the gesture arrives, the same track starts — not a later one.
func TestBlockedThenToggleResumesSameTrack(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.HandleEngine(EngineEvent{Kind: EvBlocked, Epoch: c.State().Epoch})
	c.Apply(Command{Kind: CmdToggle})

	if got := currentID(c); got != "a" {
		t.Fatalf("resumed on %q, want a", got)
	}
	if !c.Target().Playing {
		t.Fatal("target does not ask the engine to play after the gesture")
	}
}

// ---------- stalling ----------

/*
A stall must not pause the engine.

Buffering is the engine saying "I am trying"; telling it to stop is the one
response that guarantees it never starts again, because a paused engine stops
fetching and stops reporting, and a position report is the only thing that
clears a stall. Seeking always buffers, so this deadlock made seeking break
playback every time.
*/
func TestStallKeepsTheEngineTrying(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)

	c.HandleEngine(EngineEvent{Kind: EvStalled, Epoch: c.State().Epoch})

	if c.State().State != domain.StateStalled {
		t.Fatalf("state = %v, want stalled", c.State().State)
	}
	if !c.Target().Playing {
		t.Fatal("a stalled target tells the engine to pause; it can then never recover")
	}
}

// And once bytes arrive, the stall clears on its own.
func TestPositionReportClearsAStall(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.HandleEngine(EngineEvent{Kind: EvStalled, Epoch: c.State().Epoch})

	c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: c.State().Epoch, PositionMs: 4000})

	if got := c.State().State; got != domain.StatePlaying {
		t.Fatalf("state = %v, want playing once data arrived", got)
	}
	if !c.Target().Playing {
		t.Fatal("target stopped asking for playback after recovery")
	}
}

// An explicit pause still stops the engine — intent is the user's, not the
// buffer's.
func TestPauseStillStopsTheEngine(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.Apply(Command{Kind: CmdToggle})

	if c.State().State != domain.StatePaused {
		t.Fatalf("state = %v, want paused", c.State().State)
	}
	if c.Target().Playing {
		t.Fatal("target still asks the engine to play after an explicit pause")
	}
}

// Seeking while stalled must keep the intent to play, or a scrub during
// buffering leaves playback stopped at the new position.
func TestSeekWhileStalledKeepsTrying(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.HandleEngine(EngineEvent{Kind: EvStalled, Epoch: c.State().Epoch})

	c.Apply(Command{Kind: CmdSeek, PositionMs: 90_000})

	if !c.Target().Playing {
		t.Fatal("seeking during a stall left the engine told to stop")
	}
	if got := c.Target().StartAtMs; got != 90_000 {
		t.Fatalf("target position = %d, want 90000", got)
	}
}
