package session

import (
	"testing"

	"spotifier/internal/clock"
	"spotifier/internal/domain"
)

/*
A listening record has to be readable months later.

The play log is what "Your listening" and the generated mixes are built from,
long after the queue that produced it is gone. It used to store only the video
id, so every statistics page and every mix came back as a list of blank rows —
and nothing noticed, because a mix needs listening history to exist at all.
*/
func TestPlayLogKeepsTitleAndArtist(t *testing.T) {
	h := NewHub(clock.System{}, DefaultSettings(), nil)
	dev := h.Register("d", "Device", Capabilities{})

	track := domain.Track{
		ID:         "vid1",
		Title:      "Her Şeyi Yak",
		DurationMs: 200_000,
		Artists:    []domain.ArtistRef{{ID: "UCduman", Name: "Duman"}},
	}
	if _, err := h.Command(t.Context(), dev.ID, Command{
		Kind: "play", Tracks: []domain.Track{track}, StartIndex: 0, Origin: "album:X",
	}); err != nil {
		t.Fatalf("play: %v", err)
	}

	// Listen far enough in that the play counts, then finish it.
	h.EngineEvent(t.Context(), dev.ID, EngineEvent{
		Kind: EvPosition, Epoch: h.Projection().State.Epoch, PositionMs: 150_000,
	})
	entries := h.core.closeOutCurrent(true)
	if len(entries) == 0 {
		t.Fatal("a completed listen produced no log entry")
	}

	e := entries[0]
	if e.TrackID != "vid1" {
		t.Fatalf("track id %q", e.TrackID)
	}
	if e.Title != "Her Şeyi Yak" {
		t.Fatalf("title %q, want the track's own", e.Title)
	}
	if e.Artist != "Duman" || e.ArtistID != "UCduman" {
		t.Fatalf("artist %q/%q, want Duman/UCduman", e.Artist, e.ArtistID)
	}
}

// A track credited to nobody is recorded blank rather than crashing or
// inventing an artist.
func TestPlayLogSurvivesAnUncreditedTrack(t *testing.T) {
	h := NewHub(clock.System{}, DefaultSettings(), nil)
	dev := h.Register("d", "Device", Capabilities{})
	if _, err := h.Command(t.Context(), dev.ID, Command{
		Kind:   "play",
		Tracks: []domain.Track{{ID: "solo", Title: "Untitled", DurationMs: 10_000}},
	}); err != nil {
		t.Fatalf("play: %v", err)
	}
	h.EngineEvent(t.Context(), dev.ID, EngineEvent{
		Kind: EvPosition, Epoch: h.Projection().State.Epoch, PositionMs: 9_000,
	})
	for _, e := range h.core.closeOutCurrent(true) {
		if e.Title != "Untitled" || e.Artist != "" {
			t.Fatalf("got %+v", e)
		}
	}
}
