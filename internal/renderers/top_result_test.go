package renderers

import (
	"testing"

	"spotifier/internal/domain"
)

// The top result is what the card itself points at — a song plays, an album
// opens — not whichever link a search of the card turns up first. Its
// subtitle links the artist, and a map walk found that about half the time,
// so a song or album top result opened the artist.
func TestTopResultIsWhatTheCardPointsAt(t *testing.T) {
	cases := []struct {
		fixture string
		kind    domain.ShelfItemKind
		id      string
	}{
		{"search_empty", domain.KindTrack, "pgRIJ5efW4g"},
		{"search_unicode", domain.KindAlbum, "MPREb_CEsAJuezLwa"},
		{"search_all", domain.KindArtist, "UCRr1xG_2WIDs18a6cIiCxeA"},
	}
	for _, c := range cases {
		doc := loadFixture(t, c.fixture)
		for attempt := range 60 {
			res := ParseSearch(doc, "q", ParseContext{})
			top := res.TopResult
			if top == nil {
				t.Fatalf("%s: no top result", c.fixture)
			}
			id := ""
			switch top.Kind {
			case domain.KindTrack:
				id = top.Track.ID
			case domain.KindAlbum:
				id = top.Album.ID
			case domain.KindArtist:
				id = top.Artist.ID
			}
			if top.Kind != c.kind || id != c.id {
				t.Fatalf("%s attempt %d: got %s %s, want %s %s", c.fixture, attempt, top.Kind, id, c.kind, c.id)
			}
		}
	}
}
