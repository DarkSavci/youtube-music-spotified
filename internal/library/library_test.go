package library_test

import (
	"context"
	"os"
	"testing"
	"time"

	"spotifier/internal/domain"
	"spotifier/internal/identity"
	"spotifier/internal/library"
)

// stubIdentity lets the merge be tested without fixtures or a network, so the
// merge rules themselves are what is under test.
type stubIdentity struct {
	identity.Identity
	playlists, artists, albums []domain.LibraryItem
	liked                      domain.Playlist
	failArtists                bool
}

func (s *stubIdentity) Playlists(context.Context) ([]domain.LibraryItem, error) {
	return s.playlists, nil
}
func (s *stubIdentity) Artists(context.Context) ([]domain.LibraryItem, error) {
	if s.failArtists {
		return nil, context.DeadlineExceeded
	}
	return s.artists, nil
}
func (s *stubIdentity) Albums(context.Context) ([]domain.LibraryItem, error) { return s.albums, nil }
func (s *stubIdentity) LikedSongs(context.Context) (domain.Playlist, error)  { return s.liked, nil }

func item(id, title string, k domain.LibraryItemKind) domain.LibraryItem {
	return domain.LibraryItem{ID: id, Title: title, Kind: k}
}

func newStub() *stubIdentity {
	return &stubIdentity{
		playlists: []domain.LibraryItem{item("p1", "Zebra mix", domain.LibPlaylist)},
		artists:   []domain.LibraryItem{item("a1", "Aphex Twin", domain.LibArtist)},
		albums: []domain.LibraryItem{
			item("al1", "Discovery", domain.LibAlbum),
			item("al1", "Discovery", domain.LibAlbum), // same album via two surfaces
		},
		liked: domain.Playlist{ID: "LM", Title: "Liked Music", TrackCount: 42},
	}
}

func TestMergeAcrossSurfaces(t *testing.T) {
	l := library.New(newStub(), nil)
	items, err := l.List(context.Background(), library.FilterAll, library.SortAlphabetical)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	// 3 unique + Liked Music, with the duplicate album collapsed.
	if len(items) != 4 {
		t.Fatalf("got %d items, want 4: %+v", len(items), items)
	}
	if !items[0].Pinned || items[0].Title != "Liked Music" {
		t.Errorf("Liked Music should be pinned first, got %+v", items[0])
	}
	if items[0].Subtitle != "42 songs" {
		t.Errorf("liked subtitle = %q", items[0].Subtitle)
	}
	kinds := map[domain.LibraryItemKind]int{}
	for _, it := range items {
		kinds[it.Kind]++
	}
	if kinds[domain.LibAlbum] != 1 {
		t.Errorf("duplicate album not collapsed: %v", kinds)
	}
}

// One failing surface must degrade to a partial library, not an error page.
func TestPartialLibraryOnSourceFailure(t *testing.T) {
	stub := newStub()
	stub.failArtists = true
	l := library.New(stub, nil)
	items, err := l.List(context.Background(), library.FilterAll, library.SortAlphabetical)
	if err != nil {
		t.Fatalf("a single failing surface should not fail the list: %v", err)
	}
	for _, it := range items {
		if it.Kind == domain.LibArtist {
			t.Error("artists failed but appeared anyway")
		}
	}
	if len(items) == 0 {
		t.Error("expected a partial library")
	}
}

func TestFilterNarrowsSurfaces(t *testing.T) {
	l := library.New(newStub(), nil)
	items, err := l.List(context.Background(), library.FilterArtists, library.SortAlphabetical)
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range items {
		if it.Kind != domain.LibArtist {
			t.Errorf("filter=artists returned a %s", it.Kind)
		}
	}
}

// Sorts that need Control-plane data must degrade to a stable order rather
// than failing, so the UI can offer them before Control exists.
func TestControlBackedSortsDegradeCleanly(t *testing.T) {
	l := library.New(newStub(), nil)
	for _, s := range []library.Sort{library.SortRecents, library.SortRecentlyAdded} {
		items, err := l.List(context.Background(), library.FilterAll, s)
		if err != nil {
			t.Fatalf("sort %s: %v", s, err)
		}
		if len(items) == 0 {
			t.Fatalf("sort %s produced nothing", s)
		}
		if !items[0].Pinned {
			t.Errorf("sort %s dropped the pin to top", s)
		}
	}
}

// With Control data present, the same sort actually orders.
type stubMeta struct{ when map[string]time.Time }

func (m *stubMeta) Enrich(_ context.Context, items []domain.LibraryItem) error {
	for i := range items {
		if t, ok := m.when[items[i].ID]; ok {
			tt := t
			items[i].AddedAt = &tt
		}
	}
	return nil
}

func TestRecentlyAddedUsesControlData(t *testing.T) {
	now := time.Now()
	meta := &stubMeta{when: map[string]time.Time{
		"p1":  now.Add(-1 * time.Hour),
		"a1":  now.Add(-48 * time.Hour),
		"al1": now.Add(-10 * time.Minute),
	}}
	l := library.New(newStub(), meta)
	items, err := l.List(context.Background(), library.FilterAll, library.SortRecentlyAdded)
	if err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, it := range items {
		if !it.Pinned {
			order = append(order, it.ID)
		}
	}
	want := []string{"al1", "p1", "a1"} // newest first
	for i := range want {
		if i >= len(order) || order[i] != want[i] {
			t.Fatalf("order = %v, want %v", order, want)
		}
	}
}

func TestLibraryAgainstFixtures(t *testing.T) {
	if _, err := os.Stat("../../testdata/fixtures/library_playlists.json"); err != nil {
		t.Skip("personal fixtures not recorded on this machine")
	}
	f := identity.NewFixture("../../testdata/fixtures", nil)
	l := library.New(f, nil)
	items, err := l.List(context.Background(), library.FilterAll, library.SortAlphabetical)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	kinds := map[domain.LibraryItemKind]int{}
	for _, it := range items {
		kinds[it.Kind]++
	}
	t.Logf("merged library: %d items %v", len(items), kinds)
	if len(items) == 0 {
		t.Error("no items merged from fixtures")
	}
}
