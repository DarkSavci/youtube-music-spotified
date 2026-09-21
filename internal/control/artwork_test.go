package control_test

import (
	"context"
	"testing"
	"time"

	"spotifier/internal/control"
)

// The play log keeps each track's cover, so mixes built from it — On Repeat
// — have artwork to show rather than an empty tile.
func TestTopTracksCarryArtwork(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	p := play("e1", "t1", "Duman", "UCd", time.Minute, 200_000)
	p.Artwork = "https://lh3.googleusercontent.com/cover=w226-h226"
	older := play("e2", "t1", "Duman", "UCd", 2*time.Minute, 200_000) // from before covers were kept
	if err := s.RecordPlays(ctx, control.DefaultUserID, []control.Play{p, older}); err != nil {
		t.Fatal(err)
	}
	top, err := s.OnRepeat(ctx, control.DefaultUserID, 10)
	if err != nil || len(top) != 1 {
		t.Fatalf("%v %v", top, err)
	}
	if top[0].Artwork != p.Artwork {
		t.Fatalf("artwork %q", top[0].Artwork)
	}
}
