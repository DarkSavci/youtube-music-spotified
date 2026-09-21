package renderers

import "testing"

func runsOf(texts ...string) Node {
	runs := make([]any, len(texts))
	for i, t := range texts {
		runs[i] = map[string]any{"text": t}
	}
	return Node{"runs": runs}
}

// A card's subtitle line is not an artist's name: the type label and view
// count around the name were ending up in Top artists.
func TestCardArtistsDropsLabelsAndCounts(t *testing.T) {
	cases := []struct {
		name     string
		subtitle Node
		want     string
	}{
		{"song label", runsOf("Song", " • ", "Duman"), "Duman"},
		{"video views", runsOf("Dolu Kadehi Ters Tut", " • ", "192K views"), "Dolu Kadehi Ters Tut"},
		{"one run", runsOf("Song • Duman • 3:20"), "Duman"},
		{"album year", runsOf("Album • Daft Punk • 2001"), "Daft Punk"},
	}
	for _, c := range cases {
		got := cardArtists(c.subtitle)
		if len(got) != 1 || got[0].Name != c.want {
			t.Errorf("%s: got %+v, want %q", c.name, got, c.want)
		}
	}
}
