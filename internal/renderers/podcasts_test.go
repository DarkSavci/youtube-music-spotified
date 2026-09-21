package renderers

import (
	"testing"

	"spotifier/internal/domain"
)

/*
An episode's subtitle is a bulleted list whose order changes by surface.

A search result reads "5d ago • HARMAN"; a show's own page reads
"575K views • 5d ago", because the show is already named by the page. Reading
by position put a view count where a publication date belongs, so the page
printed "575K views" as a publication time.
*/
func TestEpisodeSubtitleIsClassifiedByShapeNotPosition(t *testing.T) {
	cases := []struct {
		name      string
		subtitle  string
		published string
		plays     string
		show      string
	}{
		{"search result", "5d ago • HARMAN", "5d ago", "", "HARMAN"},
		{"show page", "575K views • 5d ago", "5d ago", "575K views", ""},
		{"absolute date", "Sep 7 • HARMAN", "Sep 7", "", "HARMAN"},
		{"views only", "670K views", "", "670K views", ""},
		{"show only", "HARMAN", "", "", "HARMAN"},
		{"all three", "1.2M views • 3 weeks ago • HARMAN", "3 weeks ago", "1.2M views", "HARMAN"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var ep domain.Episode
			applyEpisodeSubtitle(&ep, tc.subtitle)

			if ep.PublishedText != tc.published {
				t.Errorf("published = %q, want %q", ep.PublishedText, tc.published)
			}
			if ep.PlayCount != tc.plays {
				t.Errorf("plays = %q, want %q", ep.PlayCount, tc.plays)
			}
			got := ""
			if ep.Podcast != nil {
				got = ep.Podcast.Title
			}
			if got != tc.show {
				t.Errorf("show = %q, want %q", got, tc.show)
			}
			// A view count must never end up where the artist is shown.
			for _, a := range ep.Artists {
				if looksLikeMetadata(a.Name) {
					t.Errorf("metadata parsed as an artist: %q", a.Name)
				}
			}
		})
	}
}
