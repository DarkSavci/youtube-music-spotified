package renderers

import (
	"encoding/json"
	"testing"

	"spotifier/internal/domain"
)

// The header's Mix and Shuffle buttons are read by name. A subtree search
// walked a Go map and returned either list depending on the run (#47).
func TestArtistRadioAndShuffleAreReadByName(t *testing.T) {
	doc := loadFixture(t, "artist")
	for range 50 {
		pc, _ := ctxFor("artist")
		ar, ok := ParseArtist(doc, "UCtest", pc)
		if !ok {
			t.Fatal("artist did not parse")
		}
		if ar.RadioID != "RDEMni3jl65KF37F9JYsJM8DGg" || ar.RadioSeed != "ifJxwoDmQqY" {
			t.Fatalf("radio = %q from %q, want the Mix button's list", ar.RadioID, ar.RadioSeed)
		}
		if ar.ShuffleID != "RDAOni3jl65KF37F9JYsJM8DGg" || ar.ShuffleSeed != "JhulBGMA7G4" {
			t.Fatalf("shuffle = %q from %q, want the Shuffle button's list", ar.ShuffleID, ar.ShuffleSeed)
		}
	}
}

// The Top songs heading links to every song, and the singles shelf to the
// whole discography (#48).
func TestArtistLinksToAllSongsAndDiscography(t *testing.T) {
	pc, _ := ctxFor("artist")
	ar, _ := ParseArtist(loadFixture(t, "artist"), "UCtest", pc)
	if ar.SongsID != "OLAK5uy_lNVBcjNtiCwq-n95uoxJ-Gd4vsfMkyZNs" {
		t.Errorf("songs = %q", ar.SongsID)
	}
	if ar.SinglesMore == nil || ar.SinglesMore.ID != "MPADUCRr1xG_2WIDs18a6cIiCxeA" || ar.SinglesMore.Params == "" {
		t.Errorf("singles more = %+v", ar.SinglesMore)
	}
	// The recorded Albums shelf has no "More" button: everything is on it.
	if ar.AlbumsMore != nil {
		t.Errorf("albums more = %+v, want none", ar.AlbumsMore)
	}
	if len(ar.Singles) == 0 || len(ar.Albums) == 0 {
		t.Fatalf("albums=%d singles=%d", len(ar.Albums), len(ar.Singles))
	}
}

// Popular is ordered by the play counts it shows. The recording itself is not:
// 295M sits above 397M in it.
func TestArtistPopularIsOrderedByPlays(t *testing.T) {
	pc, _ := ctxFor("artist")
	ar, _ := ParseArtist(loadFixture(t, "artist"), "UCtest", pc)
	if len(ar.TopTracks) < 2 {
		t.Fatalf("top tracks = %d", len(ar.TopTracks))
	}
	for i := 1; i < len(ar.TopTracks); i++ {
		prev, cur := PlayCount(ar.TopTracks[i-1].PlayCount), PlayCount(ar.TopTracks[i].PlayCount)
		if cur > prev {
			t.Errorf("%q (%s) after %q (%s)", ar.TopTracks[i].Title, ar.TopTracks[i].PlayCount,
				ar.TopTracks[i-1].Title, ar.TopTracks[i-1].PlayCount)
		}
	}
}

func TestPlayCount(t *testing.T) {
	for in, want := range map[string]int64{
		"1.9B plays":  1_900_000_000,
		"22M plays":   22_000_000,
		"850K views":  850_000,
		"1,234 plays": 1234,
		"":            0,
		"plays":       0,
	} {
		if got := PlayCount(in); got != want {
			t.Errorf("PlayCount(%q) = %d, want %d", in, got, want)
		}
	}
}

// A missing count leaves YouTube's order alone rather than guessing.
func TestSortByPlaysKeepsOrderWithoutCounts(t *testing.T) {
	tracks := []domain.Track{{ID: "a", PlayCount: "1M plays"}, {ID: "b"}, {ID: "c", PlayCount: "9M plays"}}
	sortByPlays(tracks)
	if tracks[0].ID != "a" || tracks[2].ID != "c" {
		t.Errorf("order changed: %s %s %s", tracks[0].ID, tracks[1].ID, tracks[2].ID)
	}
}

func TestHasWord(t *testing.T) {
	if !hasWord("singles & eps", "eps") || !hasWord("ep", "ep") {
		t.Error("missed a whole word")
	}
	if hasWord("deep cuts", "ep") {
		t.Error("matched inside a word")
	}
}

// Album cards on an artist page carry their year, which sorting by release
// needs.
func TestArtistAlbumsCarryYears(t *testing.T) {
	pc, _ := ctxFor("artist")
	ar, _ := ParseArtist(loadFixture(t, "artist"), "UCtest", pc)
	for _, al := range append(ar.Albums, ar.Singles...) {
		if !isYear(al.Year) {
			t.Errorf("%q has year %q", al.Title, al.Year)
		}
	}
}

// An artist's all-songs playlist puts the play count third and the album
// fourth. Only the third column was read, so every album there was lost.
func TestTrackReadsAlbumPastThePlayCount(t *testing.T) {
	const row = `{
	  "playlistItemData": {"videoId": "khnokW3Mw24"},
	  "flexColumns": [
	    {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "Instant Crush"}]}}},
	    {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "Daft Punk",
	      "navigationEndpoint": {"browseEndpoint": {"browseId": "UCRr1xG_2WIDs18a6cIiCxeA",
	        "browseEndpointContextSupportedConfigs": {"browseEndpointContextMusicConfig": {"pageType": "MUSIC_PAGE_TYPE_ARTIST"}}}}}]}}},
	    {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "1.2B plays"}]}}},
	    {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "Random Access Memories",
	      "navigationEndpoint": {"browseEndpoint": {"browseId": "MPREb_K8qWMWVqXGi",
	        "browseEndpointContextSupportedConfigs": {"browseEndpointContextMusicConfig": {"pageType": "MUSIC_PAGE_TYPE_ALBUM"}}}}}]}}}
	  ]
	}`
	n, err := Parse(json.RawMessage(row))
	if err != nil {
		t.Fatal(err)
	}
	tr, ok := ParseTrack(n)
	if !ok {
		t.Fatal("row did not parse")
	}
	if tr.PlayCount != "1.2B plays" {
		t.Errorf("plays = %q", tr.PlayCount)
	}
	if tr.Album == nil || tr.Album.ID != "MPREb_K8qWMWVqXGi" {
		t.Errorf("album = %+v", tr.Album)
	}
}
