package renderers

import "testing"

// A queue entry can carry the song and its music-video version side by side
// (a wrapper with a counterpart). That is one entry, not two: reading both
// put every such song in the queue twice, once as the video.
func TestWatchQueueSkipsVideoCounterparts(t *testing.T) {
	doc := loadFixture(t, "next")
	tracks, _ := ParseWatchQueue(doc)
	counterparts := 0
	walkCounterparts(doc, &counterparts)
	if counterparts == 0 {
		t.Skip("fixture has no counterpart to test against")
	}
	primaries := len(FindAll(doc, NodeQueueItem)) - counterparts
	if len(tracks) != primaries {
		t.Fatalf("parsed %d entries, want %d (counterparts excluded)", len(tracks), primaries)
	}
}

func walkCounterparts(v any, n *int) {
	switch x := v.(type) {
	case Node:
		walkCounterparts(map[string]any(x), n)
	case map[string]any:
		for k, c := range x {
			if k == "counterpart" {
				*n += len(FindAll(c, NodeQueueItem))
				continue
			}
			walkCounterparts(c, n)
		}
	case []any:
		for _, c := range x {
			walkCounterparts(c, n)
		}
	}
}
