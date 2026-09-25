package session

import (
	"spotifier/internal/domain"
	"testing"
)

func TestVariantKeepsQueuePositionAndPreferences(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.Apply(Command{Kind: CmdSetShuffle, Shuffle: true})
	c.Apply(Command{Kind: CmdSetRepeat, Repeat: domain.RepeatAll})
	c.Apply(Command{Kind: CmdSetVolume, Volume: .2})
	c.Apply(Command{Kind: CmdSeek, PositionMs: 42000})
	c.Apply(Command{Kind: CmdToggle})
	before := c.State()
	old := before.Queue.Current().ID
	variant := *before.Queue.Current()
	variant.ID = "new-video"
	variant.IsVideo = true
	reject, _ := c.Apply(Command{Kind: CmdVariant, ExpectedID: old, Tracks: []domain.Track{variant}})
	after := c.State()
	if reject != RejectNone || len(after.Queue.Items) != 3 || after.Queue.Index != before.Queue.Index || after.PositionMs != 42000 || after.State != domain.StatePaused || after.Repeat != domain.RepeatAll || !after.Shuffle || after.Volume != .2 || after.Epoch <= before.Epoch {
		t.Fatalf("bad variant state: %+v (%s)", after, reject)
	}
	c.HandleEngine(EngineEvent{Kind: EvEnded, Epoch: before.Epoch})
	if c.State().Queue.Current().ID != variant.ID {
		t.Fatal("stale outgoing event advanced queue")
	}
	c.Apply(Command{Kind: CmdSetShuffle, Shuffle: false})
	if c.State().Queue.Current().ID != variant.ID || len(c.State().Queue.Items) != 3 {
		t.Fatal("unshuffle lost variant")
	}
	reject, _ = c.Apply(Command{Kind: CmdVariant, ExpectedID: old, Tracks: []domain.Track{variant}})
	if reject == RejectNone {
		t.Fatal("stale switch accepted")
	}
	c.Apply(Command{Kind: CmdFollow, Tracks: tracks(1), Playing: false})
	reject, _ = c.Apply(Command{Kind: CmdVariant, ExpectedID: c.State().Queue.Current().ID, Tracks: []domain.Track{variant}})
	if reject != RejectNotOwner {
		t.Fatal("guest changed host version")
	}
}

func TestVariantCarriesPartialListenAndDoesNotResumeEndedTrack(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 1)
	before := c.State()
	c.HandleEngine(EngineEvent{Kind: EvPosition, Epoch: before.Epoch, PositionMs: 1000})
	variant := *c.State().Queue.Current()
	variant.ID = "clip"
	reject, logs := c.Apply(Command{Kind: CmdVariant, ExpectedID: before.Queue.Current().ID, Tracks: []domain.Track{variant}})
	if reject != RejectNone || len(logs) != 0 || c.playedMs != 1000 {
		t.Fatalf("partial listen lost: %s %v %d", reject, logs, c.playedMs)
	}
	c.HandleEngine(EngineEvent{Kind: EvEnded, Epoch: c.State().Epoch})
	variant.ID = "song"
	_, _ = c.Apply(Command{Kind: CmdVariant, ExpectedID: "clip", Tracks: []domain.Track{variant}})
	if c.playIntent() {
		t.Fatal("switching an ended track resumed playback")
	}
	if c.playedMs != 0 {
		t.Fatal("already logged listening time was carried into another version")
	}
}
