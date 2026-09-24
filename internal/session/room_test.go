package session

import (
	"spotifier/internal/domain"
	"testing"
)

func TestFollowingRoomOwnsTransportButNotVolume(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.Apply(Command{Kind: CmdSetRepeat, Repeat: domain.RepeatAll})
	c.Apply(Command{Kind: CmdSetVolume, Volume: .2})
	r, _ := c.Apply(Command{Kind: CmdFollow, Tracks: tracks(1), PositionMs: 42000, Playing: false})
	if r != RejectNone || !c.following || len(c.State().Queue.Items) != 1 || c.State().State != domain.StatePaused || c.State().Volume != .2 || c.Target().PreloadVideoID != "" {
		t.Fatalf("bad room state: %+v", c.State())
	}
	for _, kind := range []CommandKind{CmdPlay, CmdToggle, CmdNext, CmdPrev, CmdSeek, CmdEnqueue, CmdTransfer} {
		if r, _ := c.Apply(Command{Kind: kind}); r != RejectNotOwner {
			t.Fatalf("guest command %s not rejected", kind)
		}
	}
	c.HandleEngine(EngineEvent{Kind: EvLoaded, Epoch: c.State().Epoch})
	if c.State().State != domain.StatePaused {
		t.Fatal("paused room started when loading finished")
	}
	c.Apply(Command{Kind: CmdSetVolume, Volume: .4})
	if c.State().Volume != .4 {
		t.Fatal("guest lost volume control")
	}
	c.Apply(Command{Kind: CmdFollow, Tracks: tracks(1), PositionMs: 45000, Playing: true})
	oldEpoch := c.State().Epoch
	c.HandleEngine(EngineEvent{Kind: EvEnded, Epoch: oldEpoch})
	if c.State().State != domain.StatePaused || c.State().Epoch != oldEpoch {
		t.Fatal("room must wait for host instead of repeating/advancing")
	}
	c.Apply(Command{Kind: CmdLeaveRoom})
	if c.following || c.State().State != domain.StatePaused || c.State().Repeat != domain.RepeatAll {
		t.Fatal("leaving must pause and retain preferences")
	}
	if r, _ := c.Apply(Command{Kind: CmdPlay, Tracks: tracks(2)}); r != RejectNone {
		t.Fatal("local playback did not unlock")
	}
}

func TestRoomFailureWaitsAndNewTrackInvalidatesOldEvents(t *testing.T) {
	c, _ := newCore(t)
	c.Apply(Command{Kind: CmdFollow, Tracks: tracks(1), Playing: true})
	old := c.State().Epoch
	c.HandleEngine(EngineEvent{Kind: EvFailed, Epoch: old, Reason: "unavailable"})
	if c.State().State != domain.StatePaused || c.State().Queue.Current().Playable {
		t.Fatal("failed track must remain stopped")
	}
	next := tracks(2)[1:]
	c.Apply(Command{Kind: CmdFollow, Tracks: next, PositionMs: 10000, Playing: true})
	c.HandleEngine(EngineEvent{Kind: EvEnded, Epoch: old})
	if c.State().Queue.Current().ID != next[0].ID || c.State().State != domain.StatePlaying {
		t.Fatal("old track event changed new room track")
	}
	if logs := c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: c.State().Epoch, PositionMs: 11000}); len(logs) != 0 {
		t.Fatal("sync seek must not invent listening history")
	}
}

func TestRoomSeekDoesNotCountAsListenedTime(t *testing.T) {
	c, _ := newCore(t)
	c.Apply(Command{Kind: CmdFollow, Tracks: tracks(1), PositionMs: 50000, Playing: true})
	c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: c.State().Epoch, PositionMs: 51000})
	c.Apply(Command{Kind: CmdFollow, Tracks: tracks(1), PositionMs: 100000, Playing: true})
	c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: c.State().Epoch, PositionMs: 101000})
	if c.playedMs != 2000 {
		t.Fatalf("seek counted as listening: %d", c.playedMs)
	}
}
