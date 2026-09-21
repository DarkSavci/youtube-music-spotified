package session

import (
	"testing"

	"spotifier/internal/domain"
)

// A paused track that finishes loading stays paused. Opening the app loads
// the last track paused; the engine reporting it loaded used to switch the
// session to playing, so it started by itself — and outside the path that
// sets up volume, so the controls did nothing until the next track.
func TestLoadingAPausedTrackDoesNotPlayIt(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	c.Apply(Command{Kind: CmdToggle}) // pause
	if c.State().State != domain.StatePaused {
		t.Fatalf("setup: %s", c.State().State)
	}
	epoch := c.State().Epoch
	c.HandleEngine(EngineEvent{Kind: EvLoaded, Epoch: epoch, DurationMs: 200_000})
	if c.State().State != domain.StatePaused || c.Target().Playing {
		t.Fatalf("loading a paused track made it %s", c.State().State)
	}
	c.HandleEngine(EngineEvent{Kind: EvStalled, Epoch: epoch})
	if c.State().State != domain.StatePaused || c.Target().Playing {
		t.Fatalf("a buffering report on a paused track made it %s", c.State().State)
	}
}

// A playing track that loads is still playing, and a stall still recovers.
func TestLoadingAPlayingTrackKeepsPlaying(t *testing.T) {
	c, _ := newCore(t)
	playN(t, c, 3)
	epoch := c.State().Epoch
	c.HandleEngine(EngineEvent{Kind: EvStalled, Epoch: epoch})
	c.HandleEngine(EngineEvent{Kind: EvLoaded, Epoch: epoch, DurationMs: 200_000})
	if c.State().State != domain.StatePlaying {
		t.Fatalf("got %s", c.State().State)
	}
}
