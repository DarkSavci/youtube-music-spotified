package control_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"spotifier/internal/control"
	"spotifier/internal/domain"
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

// Pins and folders kept under an artist's library id ("MPLA" + the channel id)
// follow the artist to the channel id the library now reports. Where both ids
// have a row, the two merge.
func TestReopenMovesLibraryArtistRowsToTheChannelID(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "test.db")
	s, err := control.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	folder, err := s.CreateFolder(ctx, control.DefaultUserID, "Rock")
	if err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(s.SetPinned(ctx, control.DefaultUserID, "artist", "MPLAUConlyold", true))
	must(s.SetFolder(ctx, control.DefaultUserID, "artist", "MPLAUConlyold", folder))
	// Both keys: the old row is pinned, the new one is in a folder.
	must(s.SetPinned(ctx, control.DefaultUserID, "artist", "MPLAUCboth", true))
	must(s.SetFolder(ctx, control.DefaultUserID, "artist", "UCboth", folder))
	// Not the artist form: left alone.
	must(s.SetPinned(ctx, control.DefaultUserID, "artist", "MPLAxyz", true))
	s.Close()

	for range 2 { // the second open finds nothing to move
		s, err = control.Open(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		items := []domain.LibraryItem{
			{ID: "UConlyold", Kind: domain.LibArtist},
			{ID: "UCboth", Kind: domain.LibArtist},
			{ID: "MPLAxyz", Kind: domain.LibArtist},
		}
		must(s.Enrich(ctx, items))
		s.Close()
		if !items[0].Pinned || items[0].FolderID != folder {
			t.Fatalf("old-only row not moved: %+v", items[0])
		}
		if !items[1].Pinned || items[1].FolderID != folder {
			t.Fatalf("rows not merged: %+v", items[1])
		}
		if !items[2].Pinned {
			t.Fatalf("a non-artist MPLA id was touched: %+v", items[2])
		}
	}
}
