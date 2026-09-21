package session

import (
	"testing"

	"spotifier/internal/clock"
	"spotifier/internal/domain"
)

/*
A track the catalogue gave no length learns it from playback.

Videos often arrive without one, and the engine only announced the length when
a track first loaded — on the deck that was playing. With gapless or crossfade
the next track loads on the idle deck, that announcement was dropped, and the
track played to the end with no length in the transport bar. Position reports
come from whichever deck is actually playing, so they carry it too.
*/
func TestPositionReportFillsMissingDuration(t *testing.T) {
	h := NewHub(clock.System{}, DefaultSettings(), nil)
	dev := h.Register("d", "Device", Capabilities{})
	if _, err := h.Command(t.Context(), dev.ID, Command{
		Kind:   "play",
		Tracks: []domain.Track{{ID: "vid", Title: "Sahte Dualar", IsVideo: true}},
	}); err != nil {
		t.Fatalf("play: %v", err)
	}

	epoch := h.Projection().State.Epoch
	h.EngineEvent(t.Context(), dev.ID, EngineEvent{
		Kind: EvPosition, Epoch: epoch, PositionMs: 12_000, DurationMs: 214_000,
	})

	got := h.Projection().State.Queue.Items[0].DurationMs
	if got != 214_000 {
		t.Fatalf("duration %d, want 214000 from the position report", got)
	}
}

// A length the catalogue did supply is not overwritten by a report that
// disagrees by rounding.
func TestPositionReportKeepsKnownDuration(t *testing.T) {
	h := NewHub(clock.System{}, DefaultSettings(), nil)
	dev := h.Register("d", "Device", Capabilities{})
	if _, err := h.Command(t.Context(), dev.ID, Command{
		Kind:   "play",
		Tracks: []domain.Track{{ID: "song", Title: "Song", DurationMs: 200_000}},
	}); err != nil {
		t.Fatalf("play: %v", err)
	}
	h.EngineEvent(t.Context(), dev.ID, EngineEvent{
		Kind: EvPosition, Epoch: h.Projection().State.Epoch, PositionMs: 1000, DurationMs: 200_480,
	})
	if got := h.Projection().State.Queue.Items[0].DurationMs; got != 200_000 {
		t.Fatalf("duration %d, want the catalogue's 200000 kept", got)
	}
}
