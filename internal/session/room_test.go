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

func TestRoomMirrorsQueueAndLeavingCanRestorePersonalSession(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.Apply(Command{Kind: CmdSeek, PositionMs: 12345})
	original := c.State().Queue.Current().ID
	roomTracks := tracks(5)
	r, _ := c.Apply(Command{Kind: CmdFollow, Tracks: roomTracks, StartIndex: 2, PositionMs: 4000, Playing: true})
	if r != RejectNone || len(c.State().Queue.Items) != 5 || c.State().Queue.Index != 2 {
		t.Fatal("room queue was not mirrored")
	}
	c.HandleEngine(EngineEvent{Kind: EvEnded, Epoch: c.State().Epoch})
	if c.State().Queue.Index != 2 {
		t.Fatal("local engine advanced a room")
	}
	c.Apply(Command{Kind: CmdSetVolume, Volume: .3})
	c.Apply(Command{Kind: CmdLeaveRoom})
	if len(c.State().Queue.Items) != 3 || c.State().Queue.Current().ID != original || c.State().PositionMs != 12345 || c.State().State != domain.StatePaused || c.State().Volume != .3 {
		t.Fatalf("personal queue not restored safely: %+v", c.State())
	}
}

func TestRepeatedRoomSongInvalidatesOldEngineEvents(t *testing.T) {
	c, _ := newCore(t)
	same := tracks(1)
	c.Apply(Command{Kind: CmdFollow, Tracks: same, ExpectedID: "first-entry", Playing: true})
	oldEpoch := c.State().Epoch
	c.Apply(Command{Kind: CmdFollow, Tracks: same, ExpectedID: "second-entry", Playing: true})
	c.HandleEngine(EngineEvent{Kind: EvEnded, Epoch: oldEpoch})
	if c.State().Epoch == oldEpoch || c.State().State != domain.StatePlaying {
		t.Fatal("previous occurrence stopped the new room entry")
	}
}

func TestLeavingKeepsTheCurrentOwnerAndMovesVersionForward(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.state.OwnerDeviceID = "desk"
	c.Apply(Command{Kind: CmdFollow, Tracks: tracks(2), Playing: true})
	// Another device took over while the room played, e.g. this one left.
	c.state.OwnerDeviceID = "phone"
	during := c.State().Version
	c.Apply(Command{Kind: CmdLeaveRoom})
	if c.State().OwnerDeviceID != "phone" {
		t.Fatalf("leaving restored a departed owner: %q", c.State().OwnerDeviceID)
	}
	if c.State().Version <= during {
		t.Fatalf("version went back from %d to %d", during, c.State().Version)
	}
}

func TestFollowingAnEmptyRoomAgainChangesNothing(t *testing.T) {
	c, _ := newCore(t)
	c.Apply(Command{Kind: CmdFollow})
	epoch, version := c.State().Epoch, c.State().Version
	for i := 0; i < 3; i++ {
		c.Apply(Command{Kind: CmdFollow})
	}
	if c.State().Epoch != epoch || c.State().Version != version {
		t.Fatalf("empty room resync moved epoch %d->%d, version %d->%d", epoch, c.State().Epoch, version, c.State().Version)
	}
}

func TestLeavingCanKeepTheRoomQueuePlaying(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.Apply(Command{Kind: CmdFollow, Tracks: tracks(5), StartIndex: 2, ExpectedID: "entry", PositionMs: 4000, Playing: true})
	epoch, version := c.State().Epoch, c.State().Version
	c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: epoch, PositionMs: 9000})
	r, _ := c.Apply(Command{Kind: CmdLeaveRoom, KeepQueue: true})
	s := c.State()
	if r != RejectNone || len(s.Queue.Items) != 5 || s.Queue.Index != 2 || s.State != domain.StatePlaying {
		t.Fatalf("room queue not kept: %+v", s)
	}
	if s.Epoch != epoch {
		t.Fatalf("keeping the queue restarted the song: epoch %d -> %d", epoch, s.Epoch)
	}
	if s.Version <= version || c.following || c.beforeRoom != nil {
		t.Fatal("still following the room after leaving")
	}
	if pos := c.positionNow(); pos < 9000 {
		t.Fatalf("position went back to %d", pos)
	}
	// Now an ordinary session: the local engine advances it again.
	c.HandleEngine(EngineEvent{Kind: EvEnded, Epoch: c.State().Epoch})
	if c.State().Queue.Index != 3 {
		t.Fatalf("kept queue did not advance: index %d", c.State().Queue.Index)
	}
}

func TestKeepingAnEmptyRoomQueueRestoresThePersonalOne(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	original := c.State().Queue.Current().ID
	c.Apply(Command{Kind: CmdFollow})
	c.Apply(Command{Kind: CmdLeaveRoom, KeepQueue: true})
	s := c.State()
	if len(s.Queue.Items) != 3 || s.Queue.Current().ID != original || s.State != domain.StatePaused {
		t.Fatalf("empty room left nothing, personal queue should return: %+v", s)
	}
}

func TestKeptRoomQueueHonoursShuffle(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.Apply(Command{Kind: CmdSetShuffle, Shuffle: true})
	room := tracks(8)
	c.Apply(Command{Kind: CmdFollow, Tracks: room, StartIndex: 2, Playing: true})
	epoch := c.State().Epoch
	c.Apply(Command{Kind: CmdLeaveRoom, KeepQueue: true})
	s := c.State()
	if !s.Shuffle || s.Queue.Current().ID != room[2].ID || s.Epoch != epoch || len(s.Queue.Items) != 8 {
		t.Fatalf("shuffle leave changed the song or lost tracks: %+v", s)
	}
	if s.Queue.Index != 0 {
		t.Fatalf("shuffle is on but the kept queue is still in room order (index %d)", s.Queue.Index)
	}
	// Turning shuffle off must bring back the room's order.
	c.Apply(Command{Kind: CmdSetShuffle, Shuffle: false})
	s = c.State()
	if s.Shuffle || s.Queue.Index != 2 || s.Queue.Current().ID != room[2].ID {
		t.Fatalf("unshuffle did not restore room order: index %d", s.Queue.Index)
	}
	for i, tr := range s.Queue.Items {
		if tr.ID != room[i].ID {
			t.Fatalf("room order not restored at %d", i)
		}
	}
}
