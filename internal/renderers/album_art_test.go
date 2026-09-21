package renderers

import (
	"testing"

	"spotifier/internal/domain"
)

/*
An album's artwork is its cover, never its artist's face.

The album header carries two images: the cover, and the artist's avatar beside
their name (the "strapline"). The artwork was taken as the first image found
anywhere in the header, and the header is a Go map whose iteration order is
randomised — so on some loads the album page showed the artist's round avatar
and read as an artist page. The loop is what makes that visible; one pass can
pass by luck.
*/
func TestAlbumArtworkIsTheCover(t *testing.T) {
	doc := loadFixture(t, "album")
	h := findHeader(doc)
	if h == nil {
		t.Fatal("no header")
	}
	cover := artworkOf(Find(h.Child("thumbnail"), "thumbnails"))
	avatar := artworkOf(Find(h.Child("straplineThumbnail"), "thumbnails"))
	if len(cover) == 0 || len(avatar) == 0 {
		t.Skip("fixture lacks one of the two images; nothing to tell apart")
	}

	for i := 0; i < 60; i++ {
		al, ok := ParseAlbum(doc, "MPREtest", ParseContext{Surface: "album"})
		if !ok {
			t.Fatal("album did not parse")
		}
		if len(al.Artwork) == 0 || al.Artwork[0].URL != cover[0].URL {
			t.Fatalf("attempt %d: artwork %q, want the cover %q (the avatar is %q)",
				i, first(al.Artwork), cover[0].URL, avatar[0].URL)
		}
	}
}

func first(a domain.ArtworkSet) string {
	if len(a) == 0 {
		return ""
	}
	return a[0].URL
}
