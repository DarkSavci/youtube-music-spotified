package renderers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"spotifier/internal/domain"
)

func loadFixture(t *testing.T, name string) Node {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "fixtures", name+".json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("fixture %s not recorded: %v", name, err)
	}
	n, err := Parse(json.RawMessage(b))
	if err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
	return n
}

// Tracks must parse out of a real songs-filtered search, with artists, album
// and duration correctly separated out of the flat subtitle run list.
func TestParseTrackFromSearchFixture(t *testing.T) {
	doc := loadFixture(t, "search_songs")
	rows := FindAll(doc, NodeListItem)
	if len(rows) == 0 {
		t.Fatal("no list items in fixture")
	}

	var parsed, withArtist, withAlbum, withDuration, withArtwork int
	for _, r := range rows {
		tr, ok := ParseTrack(r)
		if !ok {
			continue
		}
		parsed++
		if tr.ID == "" || tr.Title == "" {
			t.Errorf("parsed track missing id/title: %+v", tr)
		}
		if len(tr.Artists) > 0 {
			withArtist++
		}
		if tr.Album != nil {
			withAlbum++
		}
		if tr.DurationMs > 0 {
			withDuration++
		}
		if len(tr.Artwork) > 0 {
			withArtwork++
		}
	}
	t.Logf("parsed %d/%d rows | artists %d | album %d | duration %d | artwork %d",
		parsed, len(rows), withArtist, withAlbum, withDuration, withArtwork)

	if parsed < len(rows)/2 {
		t.Errorf("parsed only %d of %d rows", parsed, len(rows))
	}
	// These are the fields the UI actually renders; a regression here is a
	// blank column, which is exactly what fixture tests exist to catch.
	if withArtist < parsed {
		t.Errorf("only %d/%d tracks got artists", withArtist, parsed)
	}
	if withDuration < parsed {
		t.Errorf("only %d/%d tracks got a duration", withDuration, parsed)
	}
	if withArtwork < parsed {
		t.Errorf("only %d/%d tracks got artwork", withArtwork, parsed)
	}
}

// A duration run must never be mistaken for an artist name, and multiple
// artists must all survive.
func TestParseTrackSubtitleClassification(t *testing.T) {
	doc := loadFixture(t, "search_songs")
	rows := FindAll(doc, NodeListItem)

	multi := 0
	for _, r := range rows {
		tr, ok := ParseTrack(r)
		if !ok {
			continue
		}
		if len(tr.Artists) > 1 {
			multi++
		}
		for _, a := range tr.Artists {
			if reDuration.MatchString(a.Name) {
				t.Errorf("duration %q parsed as an artist on %q", a.Name, tr.Title)
			}
			if looksLikeMetadata(a.Name) {
				t.Errorf("metadata %q parsed as an artist on %q", a.Name, tr.Title)
			}
		}
		if tr.Album != nil && reDuration.MatchString(tr.Album.Name) {
			t.Errorf("duration parsed as album on %q", tr.Title)
		}
	}
	t.Logf("%d tracks credited multiple artists", multi)
}

func TestParseCardFromShelfFixtures(t *testing.T) {
	for _, fx := range []string{"home", "explore", "new_releases"} {
		t.Run(fx, func(t *testing.T) {
			doc := loadFixture(t, fx)
			cards := FindAll(doc, NodeTwoRowItem)
			if len(cards) == 0 {
				t.Skip("no cards in this fixture")
			}
			kinds := map[string]int{}
			parsed := 0
			for _, c := range cards {
				item, ok := ParseCard(c)
				if !ok {
					continue
				}
				parsed++
				kinds[string(item.Kind)]++
			}
			t.Logf("%s: parsed %d/%d cards %v", fx, parsed, len(cards), kinds)
			if parsed < len(cards)/2 {
				t.Errorf("parsed only %d of %d cards", parsed, len(cards))
			}
		})
	}
}

func TestParseQueueTrackFromNextFixture(t *testing.T) {
	doc := loadFixture(t, "next")
	rows := FindAll(doc, NodeQueueItem)
	if len(rows) == 0 {
		t.Skip("no queue items in fixture")
	}
	parsed := 0
	for _, r := range rows {
		if tr, ok := ParseQueueTrack(r); ok {
			parsed++
			if tr.DurationMs == 0 {
				t.Errorf("queue track %q has no duration", tr.Title)
			}
		}
	}
	t.Logf("parsed %d/%d queue rows", parsed, len(rows))
	if parsed == 0 {
		t.Error("no queue rows parsed")
	}
}

// The awkward fixtures must not panic or produce garbage.
func TestAwkwardFixturesDegradeCleanly(t *testing.T) {
	for _, fx := range []string{"search_empty", "search_unicode"} {
		t.Run(fx, func(t *testing.T) {
			doc := loadFixture(t, fx)
			for _, r := range FindAll(doc, NodeListItem) {
				if tr, ok := ParseTrack(r); ok && tr.ID == "" {
					t.Error("ok=true but empty id")
				}
			}
		})
	}
}

/*
Album names live in the third column on some surfaces.

A playlist row carries its album there with a browse endpoint, while an album
or artist row puts a play count in the same place and Liked Music repeats the
title. Reading that column as one fixed thing left every playlist row without
an album, and the column on screen empty.
*/
func TestTrackAlbumComesFromTheThirdColumn(t *testing.T) {
	for _, tc := range []struct {
		fixture   string
		wantAlbum bool
		wantPlays bool
	}{
		{"playlist", true, false},
		{"liked", true, false},
		{"album", false, true},
		{"artist", false, true},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			doc := loadFixture(t, tc.fixture)
			rows := FindAll(doc, NodeListItem)
			if len(rows) == 0 {
				t.Skip("no rows in this fixture")
			}
			var got domain.Track
			for _, n := range rows {
				if tr, ok := ParseTrack(n); ok {
					got = tr
					break
				}
			}
			if got.ID == "" {
				t.Fatal("no track parsed")
			}
			if tc.wantAlbum && (got.Album == nil || got.Album.Name == "") {
				t.Fatalf("no album parsed for %s: %+v", tc.fixture, got.Album)
			}
			if tc.wantAlbum && got.Album.ID == "" {
				t.Fatalf("album has no identifier, so it cannot be opened: %+v", got.Album)
			}
			if tc.wantPlays && got.PlayCount == "" {
				t.Fatalf("no play count parsed for %s", tc.fixture)
			}
			// A play count must never be mistaken for an album name.
			if got.Album != nil && strings.Contains(got.Album.Name, "plays") {
				t.Fatalf("play count parsed as an album: %+v", got.Album)
			}
		})
	}
}
