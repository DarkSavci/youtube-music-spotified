package renderers

import (
	"encoding/json"
	"testing"
)

func mustParse(t *testing.T, s string) Node {
	t.Helper()
	n, err := Parse(json.RawMessage(s))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return n
}

func TestNilNodeIsSafe(t *testing.T) {
	var n Node
	// Every accessor on a missing branch must yield a zero value, so chained
	// lookups through absent nodes never panic.
	if n.Child("a").Child("b").Str("c") != "" {
		t.Error("chained lookup through nil should be empty")
	}
	if n.Int("x") != 0 || n.Bool("x") || n.List("x") != nil || n.At("x", 3) != nil {
		t.Error("nil node accessors should all be zero")
	}
	if n.Text("x") != "" || n.FindArtwork() != nil || n.BrowseID() != "" {
		t.Error("nil node derived accessors should be zero")
	}
}

func TestAtIsBoundsChecked(t *testing.T) {
	n := mustParse(t, `{"items":[{"a":1}]}`)
	if n.At("items", 0) == nil {
		t.Error("index 0 should resolve")
	}
	for _, i := range []int{-1, 1, 99} {
		if n.At("items", i) != nil {
			t.Errorf("index %d should be nil, not panic", i)
		}
	}
}

func TestTextJoinsAllRuns(t *testing.T) {
	// Artist credits arrive as multiple runs with separators between them;
	// taking only runs[0] silently truncates them.
	n := mustParse(t, `{"t":{"runs":[{"text":"Daft Punk"},{"text":" & "},{"text":"Pharrell"}]}}`)
	if got := n.Text("t"); got != "Daft Punk & Pharrell" {
		t.Errorf("got %q, want all runs joined", got)
	}
	simple := mustParse(t, `{"t":{"simpleText":"Around the World"}}`)
	if got := simple.Text("t"); got != "Around the World" {
		t.Errorf("simpleText: got %q", got)
	}
	if mustParse(t, `{"t":{"runs":[]}}`).Text("t") != "" {
		t.Error("empty runs should be empty string")
	}
	if mustParse(t, `{"t":"not an object"}`).Text("t") != "" {
		t.Error("unexpected shape should be empty, not panic")
	}
}

func TestArtworkSortsAscendingByWidth(t *testing.T) {
	n := mustParse(t, `{"thumbnail":{"thumbnails":[
		{"url":"big","width":544,"height":544},
		{"url":"small","width":60,"height":60},
		{"url":"mid","width":226,"height":226}]}}`)
	set := n.FindArtwork()
	if len(set) != 3 {
		t.Fatalf("got %d artworks, want 3", len(set))
	}
	for i := 1; i < len(set); i++ {
		if set[i].Width < set[i-1].Width {
			t.Fatalf("not ascending: %v", set)
		}
	}
	if got := set.AtLeast(200); got.URL != "mid" {
		t.Errorf("AtLeast(200) = %q, want mid", got.URL)
	}
	if got := set.AtLeast(9999); got.URL != "big" {
		t.Errorf("AtLeast past the largest should clamp, got %q", got.URL)
	}
}

func TestFindSearchesAnyDepth(t *testing.T) {
	// Nesting shifts between responses, so lookups search rather than assert.
	n := mustParse(t, `{"a":{"b":{"c":[{"d":{"watchEndpoint":{"videoId":"abc123"}}}]}}}`)
	if got := n.VideoID(); got != "abc123" {
		t.Errorf("VideoID through deep nesting = %q", got)
	}
	if Find(n, "nonexistent") != nil {
		t.Error("missing key should be nil")
	}
}

func TestDurationMs(t *testing.T) {
	cases := map[string]int64{
		"3:45":    225000,
		"0:30":    30000,
		"1:07:10": 4030000,
		"":        0,
		"garbage": 0,
		"1:2:3:4": 0,
		"-1:00":   0,
	}
	for in, want := range cases {
		if got := DurationMs(in); got != want {
			t.Errorf("DurationMs(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestRendererTypesCounts(t *testing.T) {
	n := mustParse(t, `{"a":{"musicShelfRenderer":{"x":1}},
		"b":[{"musicShelfRenderer":{}},{"buttonRenderer":{}}]}`)
	counts := RendererTypes(n)
	if counts["musicShelfRenderer"] != 2 {
		t.Errorf("musicShelfRenderer = %d, want 2", counts["musicShelfRenderer"])
	}
	if counts["buttonRenderer"] != 1 {
		t.Errorf("buttonRenderer = %d, want 1", counts["buttonRenderer"])
	}
}
