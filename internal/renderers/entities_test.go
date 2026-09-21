package renderers

import (
	"strings"
	"testing"
)

func TestParseAlbumFixture(t *testing.T) {
	doc := loadFixture(t, "album")
	pc, rec := ctxFor("album")
	al, ok := ParseAlbum(doc, "MPREb_test", pc)
	if !ok {
		t.Fatal("album did not parse")
	}
	t.Logf("album %q | artists=%d year=%q tracks=%d duration=%dms artwork=%d",
		al.Title, len(al.Artists), al.Year, len(al.Tracks), al.DurationMs, len(al.Artwork))
	for _, u := range rec.UnknownNodes() {
		t.Logf("  unknown: %s x%d", u.Type, u.Count)
	}
	if al.Title == "" {
		t.Error("no title")
	}
	if len(al.Tracks) == 0 {
		t.Error("no tracks")
	}
	if len(al.Artwork) == 0 {
		t.Error("no artwork")
	}
	// Album rows omit their own album; the parser backfills it so the UI can
	// render a consistent row shape everywhere.
	for _, tr := range al.Tracks {
		if tr.Album == nil {
			t.Errorf("track %q has no album backfilled", tr.Title)
			break
		}
		if len(tr.Artists) == 0 {
			t.Errorf("track %q has no artists", tr.Title)
			break
		}
	}
}

func TestParseArtistFixture(t *testing.T) {
	doc := loadFixture(t, "artist")
	pc, rec := ctxFor("artist")
	ar, ok := ParseArtist(doc, "UCtest", pc)
	if !ok {
		t.Fatal("artist did not parse")
	}
	t.Logf("artist %q | subs=%q top=%d albums=%d singles=%d related=%d desc=%dch artwork=%d",
		ar.Name, ar.Subscribers, len(ar.TopTracks), len(ar.Albums),
		len(ar.Singles), len(ar.Related), len(ar.Description), len(ar.Artwork))
	for _, u := range rec.UnknownNodes() {
		t.Logf("  unknown: %s x%d", u.Type, u.Count)
	}
	if ar.Name == "" {
		t.Error("no name")
	}
	if len(ar.TopTracks) == 0 && len(ar.Albums) == 0 {
		t.Error("artist has neither top tracks nor albums")
	}
}

func TestParsePlaylistFixture(t *testing.T) {
	doc := loadFixture(t, "playlist")
	pc, rec := ctxFor("playlist")
	pl, ok := ParsePlaylist(doc, "VLtest", pc)
	if !ok {
		t.Fatal("playlist did not parse")
	}
	t.Logf("playlist %q | owner=%q tracks=%d count=%d duration=%dms artwork=%d",
		pl.Title, pl.Owner, len(pl.Tracks), pl.TrackCount, pl.DurationMs, len(pl.Artwork))
	for _, u := range rec.UnknownNodes() {
		t.Logf("  unknown: %s x%d", u.Type, u.Count)
	}
	if pl.Title == "" {
		t.Error("no title")
	}
	if len(pl.Tracks) == 0 {
		t.Error("no tracks")
	}
}

func TestParseWatchQueueFixture(t *testing.T) {
	doc := loadFixture(t, "next")
	tracks, lyricsID := ParseWatchQueue(doc)
	t.Logf("queue: %d tracks, lyricsID=%q", len(tracks), lyricsID)
	if len(tracks) == 0 {
		t.Error("no queue tracks")
	}
}

func TestLeadingIntAndYear(t *testing.T) {
	for in, want := range map[string]int{"12 songs": 12, "1,234 songs": 1234, "songs": 0, "": 0} {
		if got := leadingInt(in); got != want {
			t.Errorf("leadingInt(%q)=%d want %d", in, got, want)
		}
	}
	for _, y := range []string{"1995", "2026"} {
		if !isYear(y) {
			t.Errorf("isYear(%q) should be true", y)
		}
	}
	for _, y := range []string{"123", "abcd", "9999", "12345"} {
		if isYear(y) {
			t.Errorf("isYear(%q) should be false", y)
		}
	}
}

func TestParseLyrics(t *testing.T) {
	doc := loadFixture(t, "lyrics")
	text, source := ParseLyrics(doc)

	if text == "" {
		t.Fatal("no lyrics text parsed")
	}
	if !strings.Contains(text, "\n") {
		t.Fatalf("lyrics came back as a single line: %.80q", text)
	}
	if source == "" {
		t.Fatal("no attribution parsed; the providers require it to be shown")
	}
	t.Logf("%d chars from %q", len(text), source)
}

// The lyrics tab is found by page type because its title is localised.
func TestWatchQueueFindsLyricsTabRegardlessOfLanguage(t *testing.T) {
	doc := loadFixture(t, "next")
	_, lyricsID := ParseWatchQueue(doc)
	if lyricsID == "" {
		t.Fatal("no lyrics browseId found in a response that has a lyrics tab")
	}
	if !strings.HasPrefix(lyricsID, "MPLY") {
		t.Fatalf("lyricsID = %q, want an MPLY… identifier", lyricsID)
	}
}

/*
Timed lyrics arrive only for a mobile client, as a bare array.

The web client is served the same words with no timings, which is why timed
lyrics looked unavailable from YouTube. The payload is an array rather than an
object, so the ordinary object search cannot see it at all.
*/
func TestParseTimedLyrics(t *testing.T) {
	const payload = `{
	  "contents": {
	    "elementRenderer": {
	      "timedLyricsData": [
	        {"cueRange": {"startTimeMilliseconds": "0", "endTimeMilliseconds": "19830"},
	         "lyricLine": "\u266a"},
	        {"cueRange": {"startTimeMilliseconds": "19830", "endTimeMilliseconds": "24930"},
	         "lyricLine": "When you were here before"},
	        {"cueRange": {"startTimeMilliseconds": "24930", "endTimeMilliseconds": "29000"},
	         "lyricLine": "Couldn't look you in the eye"}
	      ]
	    }
	  }
	}`

	doc, err := Parse([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	lines, _ := ParseTimedLyrics(doc)

	if len(lines) != 3 {
		t.Fatalf("parsed %d lines, want 3: %+v", len(lines), lines)
	}
	if lines[1].AtMs != 19830 || lines[1].Text != "When you were here before" {
		t.Fatalf("second line = %+v", lines[1])
	}
	// Times must be in order, or the view shows lines before they are sung.
	for i := 1; i < len(lines); i++ {
		if lines[i].AtMs < lines[i-1].AtMs {
			t.Fatalf("lines out of order: %+v", lines)
		}
	}
	// An instrumental marker is a real line: it is time passing.
	if lines[0].Text == "" {
		t.Fatal("dropped the instrumental marker")
	}
}

// A web-client response has no timings, and must not be mistaken for one.
func TestParseTimedLyricsIgnoresAnUntimedResponse(t *testing.T) {
	doc := loadFixture(t, "lyrics")
	if lines, _ := ParseTimedLyrics(doc); len(lines) != 0 {
		t.Fatalf("found %d timed lines in an untimed response", len(lines))
	}
}
