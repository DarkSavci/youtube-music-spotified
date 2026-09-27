package session

import (
	"testing"

	"spotifier/internal/domain"
)

// Offline, every track fails; none of them is broken (#7). The track waits
// where it is instead of being greyed out and skipped.
func TestAFailureWhileOfflineHoldsTheTrack(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 5)
	c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: c.State().Epoch, PositionMs: 42_000})
	c.SetOnline(false)
	for range 5 {
		if logs := c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: c.State().Epoch, Reason: "network"}); len(logs) != 0 {
			t.Fatalf("a failure offline was logged as a failed play: %+v", logs)
		}
	}
	s := c.State()
	if s.Queue.Index != 0 || s.State != domain.StateStalled || len(s.Degraded) != 0 || !s.Queue.Items[0].Playable {
		t.Fatalf("the track was not held: index %d state %s degraded %v", s.Queue.Index, s.State, s.Degraded)
	}
	if s.PositionMs != 42_000 {
		t.Fatalf("held at %d, want 42000", s.PositionMs)
	}
	if !c.Target().Playing {
		t.Fatal("held track no longer wanted playing")
	}
}

// When the connection comes back, the held track starts again from where it
// stopped, under a new epoch so the engine loads it afresh.
func TestComingBackOnlineStartsTheHeldTrackAgain(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 5)
	c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: c.State().Epoch, PositionMs: 42_000})
	c.SetOnline(false)
	epoch := c.State().Epoch
	c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: epoch, Reason: "network"})
	if !c.SetOnline(true) {
		t.Fatal("going back online changed nothing")
	}
	s := c.State()
	if s.State != domain.StatePlaying || s.Epoch == epoch || s.Queue.Index != 0 || s.PositionMs != 42_000 {
		t.Fatalf("held track not restarted: %+v", s)
	}
	// And failures count as usual again.
	c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: s.Epoch, Reason: "403"})
	if c.State().Queue.Index != 1 {
		t.Fatalf("a real failure online did not move on: index %d", c.State().Queue.Index)
	}
}

// Paused while the connection was down, it stays paused when it returns.
func TestPausingAHeldTrackKeepsItPausedOnline(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.SetOnline(false)
	c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: c.State().Epoch, Reason: "network"})
	if r, _ := c.Apply(Command{Kind: CmdToggle}); r != RejectNone {
		t.Fatalf("toggle rejected: %s", r)
	}
	if c.State().State != domain.StatePaused {
		t.Fatalf("toggle on a held track: %s, want paused", c.State().State)
	}
	epoch := c.State().Epoch
	c.SetOnline(true)
	if c.State().State != domain.StatePaused || c.State().Epoch != epoch {
		t.Fatalf("a paused track started on its own: %s", c.State().State)
	}
}

// The player shows Pause while buffering; pressing it pauses. It used to set
// "playing" over a track with nothing to play, and the timer ran in silence.
func TestTogglePausesAStalledTrack(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.HandleEngine(EngineEvent{Kind: EvStalled, Epoch: c.State().Epoch})
	if c.State().State != domain.StateStalled {
		t.Fatalf("setup: state %s", c.State().State)
	}
	c.Apply(Command{Kind: CmdToggle})
	if c.State().State != domain.StatePaused {
		t.Fatalf("toggle while stalled: %s, want paused", c.State().State)
	}
	c.Apply(Command{Kind: CmdToggle})
	if c.State().State != domain.StatePlaying {
		t.Fatalf("toggle while paused: %s, want playing", c.State().State)
	}
}

// Skipping to another track while held clears the hold: that track is the
// one to wait for now, and it is what the connection coming back starts.
func TestSkippingWhileOfflineHoldsTheNewTrack(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 4)
	c.SetOnline(false)
	c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: c.State().Epoch, Reason: "network"})
	c.Apply(Command{Kind: CmdNext})
	c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: c.State().Epoch, Reason: "network"})
	epoch := c.State().Epoch
	c.SetOnline(true)
	s := c.State()
	if s.Queue.Index != 1 || s.State != domain.StatePlaying || s.Epoch == epoch || len(s.Degraded) != 0 {
		t.Fatalf("after skipping offline: %+v", s)
	}
}

// A room's follower is held the same way while offline, not greyed out and
// stopped, and plays again when the connection is back (#7).
func TestAFollowerIsHeldOfflineAndPlaysAgainOnline(t *testing.T) {
	c, _ := newCore(t)
	room := tracks(3)
	c.Apply(Command{Kind: CmdFollow, Tracks: room, ExpectedID: "e1", PositionMs: 30_000, Playing: true})
	c.SetOnline(false)
	epoch := c.State().Epoch
	c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: epoch, Reason: "network"})
	s := c.State()
	if s.State != domain.StateStalled || len(s.Degraded) != 0 || !s.Queue.Items[0].Playable {
		t.Fatalf("follower not held: state %s degraded %v", s.State, s.Degraded)
	}
	c.SetOnline(true)
	s = c.State()
	if s.State != domain.StatePlaying || s.Epoch == epoch || s.Queue.Index != 0 {
		t.Fatalf("follower not restarted: %+v", s)
	}
	// The room's next state still puts it back in step.
	c.Apply(Command{Kind: CmdFollow, Tracks: room, StartIndex: 1, ExpectedID: "e2", Playing: true})
	if c.State().Queue.Index != 1 || c.State().State != domain.StatePlaying {
		t.Fatalf("did not follow the room after reconnecting: %+v", c.State())
	}
}

// Paused during an outage, then Play pressed while still offline: when the
// connection returns the track starts afresh, so a stall timer the engine
// began offline cannot fail it once the probe says the link works (#7).
func TestPlayPressedOfflineIsStartedAfreshOnReturn(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.SetOnline(false)
	c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: c.State().Epoch, Reason: "network"})
	c.Apply(Command{Kind: CmdToggle}) // pause
	c.Apply(Command{Kind: CmdToggle}) // play, still offline
	epoch := c.State().Epoch
	c.SetOnline(true)
	if c.State().Epoch == epoch || c.State().State != domain.StatePlaying || c.State().Queue.Index != 0 {
		t.Fatalf("not restarted on return: %+v", c.State())
	}
}

// A track still buffering from the outage — stalled, never reported failed —
// is started afresh when the connection returns, not left to a stall timer
// that began offline.
func TestAStalledTrackIsStartedAfreshOnReturn(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.SetOnline(false)
	c.HandleEngine(EngineEvent{Kind: EvStalled, Epoch: c.State().Epoch})
	epoch := c.State().Epoch
	c.SetOnline(true)
	s := c.State()
	if s.Epoch == epoch || s.State != domain.StatePlaying || s.Queue.Index != 0 {
		t.Fatalf("stalled track not restarted on return: %+v", s)
	}
	// A track playing fine through a short outage is left alone.
	c.SetOnline(false)
	epoch = c.State().Epoch
	c.SetOnline(true)
	if c.State().Epoch != epoch {
		t.Fatal("a playing track was restarted by a reconnect")
	}
}
