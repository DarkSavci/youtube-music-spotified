package session

import "testing"

// A skip is the listener choosing a track now: it cuts. Only a track ending
// on its own crossfades into the next.
func TestSkipCutsButAnEndingCrossfades(t *testing.T) {
	c, _ := newCore(t)
	c.settings.CrossfadeMs = 6000
	playN(t, c, 4)

	if !c.Target().UserChange {
		t.Error("a track the listener picked was not marked as their change")
	}
	c.Apply(Command{Kind: CmdNext})
	if !c.Target().UserChange {
		t.Error("a skip was not marked as the listener's change")
	}
	c.HandleEngine(EngineEvent{Kind: EvEnded, Epoch: c.State().Epoch})
	if c.Target().UserChange {
		t.Error("a track ending on its own was marked as a skip")
	}
	c.Apply(Command{Kind: CmdPrev})
	if !c.Target().UserChange {
		t.Error("going back was not marked as the listener's change")
	}
	// The configured transition still stands for the next natural change.
	if tr := c.Target().Transition; tr.Kind != "crossfade" {
		t.Errorf("transition became %q", tr.Kind)
	}
}
