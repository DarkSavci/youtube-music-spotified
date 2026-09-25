package renderers

import "testing"

func TestTrackVersionsOnlyExplicitPair(t *testing.T) {
	doc := loadFixture(t, "next")
	wrapper := Find(doc, "playlistPanelVideoWrapperRenderer")
	nodes := FindAll(wrapper, NodeQueueItem)
	if len(nodes) < 2 {
		t.Fatal("fixture needs song/video pair")
	}
	id := nodes[0].VideoID()
	versions := ParseTrackVersions(doc, id)
	var song, video bool
	for _, tr := range versions {
		if tr.IsVideo {
			video = true
		} else {
			song = true
		}
	}
	if len(versions) != 2 || !song || !video {
		t.Fatalf("missing explicit pair: %+v", versions)
	}
	if len(ParseTrackVersions(doc, "nonexistent")) != 0 {
		t.Fatal("recommendations used as an unrelated counterpart")
	}
}
