package session

import (
	"testing"

	"spotifier/internal/domain"
)

// With repeat one, nothing comes next: the engine is not told of a next
// track, so it cannot fade into one or start it when this one ends while the
// session replays the current track.
func TestRepeatOneNamesNoNextTrack(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.Apply(Command{Kind: CmdSetRepeat, Repeat: domain.RepeatOne})
	if next := c.Target().PreloadVideoID; next != "" {
		t.Fatalf("repeat one still names %q as next", next)
	}
	before := currentID(c)
	c.HandleEngine(EngineEvent{Kind: EvEnded, Epoch: c.State().Epoch})
	if currentID(c) != before {
		t.Fatalf("repeat one moved on to %q", currentID(c))
	}

	c.Apply(Command{Kind: CmdSetRepeat, Repeat: domain.RepeatOff})
	if c.Target().PreloadVideoID == "" {
		t.Fatal("with repeat off the next track is named again")
	}
}
