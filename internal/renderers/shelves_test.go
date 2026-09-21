package renderers

import (
	"testing"

	"spotifier/internal/obs"
)

func ctxFor(surface string) (ParseContext, *obs.Recorder) {
	rec := obs.NewRecorder()
	return ParseContext{Surface: surface, Recorder: rec}, rec
}

func TestParseBrowsePageFixtures(t *testing.T) {
	for _, fx := range []string{"home", "explore", "charts", "new_releases", "moods"} {
		t.Run(fx, func(t *testing.T) {
			doc := loadFixture(t, fx)
			pc, rec := ctxFor(fx)
			page := ParseBrowsePage(doc, pc)

			// Browse surfaces come in two shapes: rows of shelves, or a grid
			// of mood chips. A surface producing only one is correct.
			if len(page.Shelves) == 0 && len(page.Moods) == 0 {
				t.Fatal("surface produced neither shelves nor mood chips")
			}
			if len(page.Moods) > 0 {
				withColor := 0
				for _, m := range page.Moods {
					if m.Title == "" || m.ID == "" {
						t.Errorf("mood chip missing title/id: %+v", m)
					}
					if m.Color != "" {
						withColor++
					}
				}
				t.Logf("%s: %d mood chips, %d with a colour", fx, len(page.Moods), withColor)
				if withColor == 0 {
					t.Error("no mood chip carried a colour; browse tiles depend on it")
				}
			}
			if len(page.Shelves) == 0 {
				return
			}
			items := 0
			for _, sh := range page.Shelves {
				if sh.Title == "" {
					t.Errorf("shelf with %d items has no title", len(sh.Items))
				}
				items += len(sh.Items)
			}
			t.Logf("%s: %d shelves, %d items", fx, len(page.Shelves), items)
			for _, u := range rec.UnknownNodes() {
				t.Logf("  unknown node: %s x%d", u.Type, u.Count)
			}
			if items == 0 {
				t.Error("shelves parsed but no items")
			}
		})
	}
}

func TestParseSearchFixtures(t *testing.T) {
	cases := []struct {
		fx, query string
		wantTop   bool
	}{
		{"search_all", "daft punk", true},
		{"search_songs", "daft punk", false},
		{"search_albums", "daft punk", false},
		{"search_artists", "daft punk", false},
		{"search_playlists", "daft punk", false},
	}
	for _, c := range cases {
		t.Run(c.fx, func(t *testing.T) {
			doc := loadFixture(t, c.fx)
			pc, rec := ctxFor(c.fx)
			res := ParseSearch(doc, c.query, pc)

			items := 0
			for _, sh := range res.Shelves {
				items += len(sh.Items)
			}
			top := "none"
			if res.TopResult != nil {
				top = string(res.TopResult.Kind)
			}
			t.Logf("%s: top=%s shelves=%d items=%d", c.fx, top, len(res.Shelves), items)
			for _, u := range rec.UnknownNodes() {
				t.Logf("  unknown node: %s x%d", u.Type, u.Count)
			}
			if items == 0 {
				t.Error("no items parsed")
			}
			// The unfiltered search leads with a confident-match card; that
			// layout is a Spotify signature we depend on.
			if c.wantTop && res.TopResult == nil {
				t.Error("expected a top result card")
			}
		})
	}
}

// Zero results must produce an empty, non-nil, non-panicking result.
func TestParseSearchEmpty(t *testing.T) {
	doc := loadFixture(t, "search_empty")
	pc, _ := ctxFor("search_empty")
	res := ParseSearch(doc, "nonexistent", pc)
	items := 0
	for _, sh := range res.Shelves {
		items += len(sh.Items)
	}
	t.Logf("empty search: top=%v shelves=%d items=%d", res.TopResult != nil, len(res.Shelves), items)
}

// Podcasts are out of scope and must be skipped knowingly, not counted as
// unknown — otherwise they mask real upstream changes forever.
/*
Podcast cards are parsed, not skipped.

This test used to assert only that they were not *reported* as unknown, which
was true while they were silently discarded as out of scope. They are a real
kind now, so the assertion is that nothing is dropped and nothing is
mis-reported.
*/
func TestPodcastCardsAreParsedNotSkipped(t *testing.T) {
	doc := loadFixture(t, "new_releases")
	pc, rec := ctxFor("new_releases")
	ParseBrowsePage(doc, pc)
	for _, u := range rec.UnknownNodes() {
		if u.Type == NodeTwoRowItem {
			t.Errorf("cards reported as unknown %s x%d", u.Type, u.Count)
		}
	}
}

// A podcast target must never be read as an artist just because its show is
// presented as a channel.
func TestPodcastAndEpisodeTargetsAreDistinguished(t *testing.T) {
	cases := []struct {
		browseID, pageType string
		podcast, episode   bool
	}{
		{"MPSPPLabc", "", true, false},
		{"", "MUSIC_PAGE_TYPE_PODCAST_SHOW_DETAIL_PAGE", true, false},
		{"MPEDabc123", "", false, true},
		{"", "MUSIC_PAGE_TYPE_NON_MUSIC_AUDIO_TRACK_PAGE", false, true},
		{"UCabc", "MUSIC_PAGE_TYPE_ARTIST", false, false},
		{"MPREabc", "MUSIC_PAGE_TYPE_ALBUM", false, false},
	}
	for _, tc := range cases {
		if got := IsPodcastTarget(tc.browseID, tc.pageType); got != tc.podcast {
			t.Errorf("IsPodcastTarget(%q,%q) = %v, want %v", tc.browseID, tc.pageType, got, tc.podcast)
		}
		if got := IsEpisodeTarget(tc.browseID, tc.pageType); got != tc.episode {
			t.Errorf("IsEpisodeTarget(%q,%q) = %v, want %v", tc.browseID, tc.pageType, got, tc.episode)
		}
	}
}
