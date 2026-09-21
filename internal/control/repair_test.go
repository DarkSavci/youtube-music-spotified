package control_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"spotifier/internal/control"
)

// Plays recorded with a search card's whole subtitle as the artist split one
// artist across several Top artists rows. Reopening the store mends them.
func TestReopenRepairsSubtitleArtists(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "test.db")
	s, err := control.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	err = s.RecordPlays(ctx, control.DefaultUserID, []control.Play{
		play("e1", "t1", "Song • Duman", "", time.Minute, 60_000),
		play("e2", "t2", "Duman", "UCduman", time.Minute, 60_000),
		play("e3", "t3", "Dolu Kadehi Ters Tut • 192K views", "", time.Minute, 60_000),
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Close()

	s, err = control.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	top, err := s.TopArtists(ctx, control.DefaultUserID, control.Last(time.Hour), 10)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for _, a := range top {
		got[a.Artist] = a.Plays
	}
	if len(top) != 2 || got["Duman"] != 2 || got["Dolu Kadehi Ters Tut"] != 1 {
		t.Fatalf("top artists = %+v", top)
	}
}
