package renderers

import (
	"strings"
	"testing"

	"spotifier/internal/domain"
)

/*
An albums search must yield albums.

Clicking "Dünya Yalan Söylüyor" from search opened the artist's page, because
two things conspired on a single row:

  - the row carries a play button, so it has a videoId, and ParseTrack claimed
    it before anything asked what the row actually was;
  - the row links its artist in the subtitle, and the fallback read the
    identifier with a deep search that walks a Go map — whose iteration order
    is randomised — so it returned the album's MPRE id or the artist's UC id
    depending on the run.

The loop is what makes the second one visible: one pass can pass by luck.
*/
func TestAlbumSearchYieldsAlbums(t *testing.T) {
	doc := loadFixture(t, "search_albums")

	for attempt := 0; attempt < 50; attempt++ {
		res := ParseSearch(doc, "daft punk", ParseContext{Surface: "search:albums"})

		var items []domain.ShelfItem
		for _, sh := range res.Shelves {
			items = append(items, sh.Items...)
		}
		if len(items) == 0 {
			t.Fatal("albums search parsed no items at all")
		}

		for _, it := range items {
			if it.Kind != domain.KindAlbum {
				t.Fatalf("attempt %d: got a %s on an albums search", attempt, it.Kind)
			}
			if !strings.HasPrefix(it.Album.ID, "MPRE") && !strings.HasPrefix(it.Album.ID, "OLAK") {
				t.Fatalf("attempt %d: album %q has id %q, which is not an album identifier",
					attempt, it.Album.Title, it.Album.ID)
			}
			if it.Album.Title == "" {
				t.Fatalf("attempt %d: album %q has no title", attempt, it.Album.ID)
			}
		}
	}
}

// The row's own navigation endpoint is the row's identity; a deep search is
// not, because the subtitle links elsewhere.
func TestOwnTargetIgnoresSubtitleLinks(t *testing.T) {
	doc := loadFixture(t, "search_albums")
	rows := FindAll(doc, NodeListItem)
	if len(rows) == 0 {
		t.Fatal("no rows in fixture")
	}

	for _, r := range rows {
		id, pageType := r.OwnTarget()
		if !strings.HasPrefix(id, "MPRE") {
			t.Fatalf("own target is %q, want the album", id)
		}
		if !strings.Contains(pageType, "ALBUM") {
			t.Fatalf("own page type is %q, want an album", pageType)
		}
	}
}
