package renderers

import (
	"encoding/json"
	"os"
	"testing"

	"spotifier/internal/obs"
)

func TestSearchHistoryReadsQueriesAndRemovalTokens(t *testing.T) {
	got := ParseSearchHistory(loadFixture(t, "search_history"))
	want := []struct{ query, token string }{
		{"daft punk", "TOKEN_DAFT_PUNK"},
		{"Nils Frahm", "TOKEN_NILS_FRAHM"},
		// No search endpoint: the display text is the query.
		{"şarkı sözleri", "TOKEN_UNICODE"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d entries %+v, want %d (duplicate and blank dropped)", len(got), got, len(want))
	}
	for i, w := range want {
		if got[i].Query != w.query || got[i].Token != w.token {
			t.Errorf("entry %d = %+v, want %q/%q", i, got[i], w.query, w.token)
		}
	}
}

func TestSearchHistoryOfOrdinarySuggestionsIsEmpty(t *testing.T) {
	// The answer to a typed prefix carries suggestions, not history.
	if got := ParseSearchHistory(loadFixture(t, "suggestions")); len(got) != 0 {
		t.Fatalf("suggestions read as history: %+v", got)
	}
	if got := ParseSearchHistory(Node{"responseContext": map[string]any{}}); len(got) != 0 {
		t.Fatalf("signed-out answer read as history: %+v", got)
	}
}

// A real answer, kept out of the repository because it is someone's own
// searches: SPOTIFIER_PRIVATE_SUGGEST_EMPTY names the file to check against.
func TestSearchHistoryAgainstARecordedAnswer(t *testing.T) {
	path := os.Getenv("SPOTIFIER_PRIVATE_SUGGEST_EMPTY")
	if path == "" {
		t.Skip("no recorded answer given")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := Parse(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	items := FindAll(doc, NodeHistorySuggestion)
	got := ParseSearchHistory(doc)
	if len(items) == 0 || len(got) == 0 {
		t.Fatalf("%d history items, %d parsed", len(items), len(got))
	}
	for _, e := range got {
		if e.Query == "" || e.Token == "" {
			t.Fatalf("entry without query or token: query=%t token=%t", e.Query != "", e.Token != "")
		}
	}
	t.Logf("%d of %d entries read", len(got), len(items))
}

func TestRemoteQueueReadsEntriesAndTheCurrentOne(t *testing.T) {
	rec := obs.NewRecorder()
	q, ok := ParseRemoteQueue(loadFixture(t, "remote_queue"), ParseContext{Surface: SurfaceRemoteQueue, Recorder: rec})
	if !ok {
		t.Fatal("queue not recognised")
	}
	var ids []string
	for _, tr := range q.Tracks {
		ids = append(ids, tr.ID)
	}
	// The video counterpart is the same entry as its song, the entry
	// without a title cannot be played, and the automix preview is not an
	// entry at all.
	want := []string{"aaaaaaaaaa1", "bbbbbbbbbb2", "cccccccccc3"}
	if len(ids) != len(want) {
		t.Fatalf("ids %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("ids %v, want %v", ids, want)
		}
	}
	// The other device was on the video of the second entry: that entry is
	// current, ahead of the currentVideoEndpoint fallback.
	if q.Index != 1 {
		t.Fatalf("index %d, want 1", q.Index)
	}
	if q.Title != "Liked Music" {
		t.Fatalf("title %q", q.Title)
	}
	first := q.Tracks[0]
	if first.Title != "Song One" || len(first.Artists) == 0 || first.Artists[0].Name != "Artist One" || first.DurationMs != 201000 {
		t.Fatalf("first track %+v", first)
	}
	if len(rec.UnknownNodes()) != 0 {
		t.Fatalf("a readable queue reported as unknown: %+v", rec.UnknownNodes())
	}
}

// The queue is expected in the shape every other `next` answer has, so a
// real one must read the same entries the watch queue does.
func TestRemoteQueueReadsARealNextAnswerLikeTheWatchQueue(t *testing.T) {
	doc := loadFixture(t, "next")
	want, _ := ParseWatchQueue(doc)
	q, ok := ParseRemoteQueue(doc, ParseContext{})
	if !ok || len(q.Tracks) != len(want) || len(want) == 0 {
		t.Fatalf("ok=%t: %d tracks, watch queue has %d", ok, len(q.Tracks), len(want))
	}
	for i := range want {
		if q.Tracks[i].ID != want[i].ID {
			t.Fatalf("entry %d: %s, want %s", i, q.Tracks[i].ID, want[i].ID)
		}
	}
}

func TestRemoteQueueFallsBackToTheCurrentVideo(t *testing.T) {
	doc := Node{
		"contents": map[string]any{"playlistPanelRenderer": map[string]any{"contents": []any{
			queueItem("aaaaaaaaaa1", "One", false),
			queueItem("bbbbbbbbbb2", "Two", false),
		}}},
		"currentVideoEndpoint": map[string]any{"watchEndpoint": map[string]any{"videoId": "bbbbbbbbbb2"}},
	}
	q, ok := ParseRemoteQueue(doc, ParseContext{})
	if !ok || q.Index != 1 || len(q.Tracks) != 2 {
		t.Fatalf("ok=%t index=%d tracks=%d", ok, q.Index, len(q.Tracks))
	}
	delete(doc, "currentVideoEndpoint")
	if q, _ := ParseRemoteQueue(doc, ParseContext{}); q.Index != 0 {
		t.Fatalf("no marker: index %d, want 0", q.Index)
	}
}

func TestRemoteQueueSelectedEntryAfterAnUnreadableOne(t *testing.T) {
	doc := Node{"playlistPanelRenderer": map[string]any{"contents": []any{
		map[string]any{"playlistPanelVideoRenderer": map[string]any{"videoId": "broken00000"}},
		queueItem("aaaaaaaaaa1", "One", false),
		queueItem("bbbbbbbbbb2", "Two", true),
	}}}
	q, _ := ParseRemoteQueue(doc, ParseContext{})
	if len(q.Tracks) != 2 || q.Index != 1 || q.Tracks[q.Index].ID != "bbbbbbbbbb2" {
		t.Fatalf("got %+v", q)
	}
}

func TestRemoteQueueEmptyAndUnknownShapes(t *testing.T) {
	rec := obs.NewRecorder()
	pc := ParseContext{Surface: SurfaceRemoteQueue, Recorder: rec}

	// An empty queue panel: nothing on the other device.
	q, ok := ParseRemoteQueue(Node{"playlistPanelRenderer": map[string]any{"contents": []any{}}}, pc)
	if !ok || len(q.Tracks) != 0 || q.Index != 0 {
		t.Fatalf("empty panel: ok=%t %+v", ok, q)
	}
	if len(rec.UnknownNodes()) != 0 {
		t.Fatalf("an empty queue reported as unknown: %+v", rec.UnknownNodes())
	}

	// Nothing this knows: empty, and noted for parser health.
	q, ok = ParseRemoteQueue(Node{"somethingNewRenderer": map[string]any{"items": []any{}}}, pc)
	if ok || len(q.Tracks) != 0 {
		t.Fatalf("unknown shape: ok=%t %+v", ok, q)
	}
	// Entries that no longer read.
	q, ok = ParseRemoteQueue(Node{"playlistPanelRenderer": map[string]any{"contents": []any{
		map[string]any{"playlistPanelVideoRenderer": map[string]any{"headline": "?"}},
	}}}, pc)
	if ok || len(q.Tracks) != 0 {
		t.Fatalf("garbled entries: ok=%t %+v", ok, q)
	}
	unknown := rec.UnknownNodes()
	if len(unknown) != 2 {
		t.Fatalf("parser health: %+v", unknown)
	}
	for _, u := range unknown {
		if u.Surface != SurfaceRemoteQueue {
			t.Fatalf("reported against %q", u.Surface)
		}
	}
}

func queueItem(id, title string, selected bool) map[string]any {
	return map[string]any{"playlistPanelVideoRenderer": map[string]any{
		"title":              map[string]any{"runs": []any{map[string]any{"text": title}}},
		"videoId":            id,
		"selected":           selected,
		"navigationEndpoint": map[string]any{"watchEndpoint": map[string]any{"videoId": id}},
	}}
}
