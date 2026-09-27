package identity

import (
	"bytes"
	"errors"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"

	"spotifier/internal/domain"
	"spotifier/internal/renderers"
)

// withoutHeaders removes every header renderer, which is how a Liked Music
// page that carries its tracks but no header looks.
func withoutHeaders(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, sub := range t {
			switch k {
			case "musicResponsiveHeaderRenderer", "musicDetailHeaderRenderer", "musicImmersiveHeaderRenderer",
				"musicEditablePlaylistDetailHeaderRenderer", "musicVisualHeaderRenderer", "musicHeaderRenderer":
				continue
			}
			out[k] = withoutHeaders(sub)
		}
		return out
	case renderers.Node:
		return withoutHeaders(map[string]any(t))
	case []any:
		out := make([]any, len(t))
		for n, sub := range t {
			out[n] = withoutHeaders(sub)
		}
		return out
	}
	return v
}

func playlistDoc(t *testing.T) renderers.Node {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/fixtures/playlist.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := renderers.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestLikedSongsWithoutAHeaderStillRead(t *testing.T) {
	doc := renderers.Node(withoutHeaders(map[string]any(playlistDoc(t))).(map[string]any))
	pl, err := ParseLikedSongs(doc, renderers.ParseContext{})
	if err != nil {
		t.Fatalf("header-less liked page refused: %v", err)
	}
	if pl.ID != "LM" || pl.Title != "Liked Music" || len(pl.Tracks) == 0 {
		t.Fatalf("got id=%q title=%q tracks=%d", pl.ID, pl.Title, len(pl.Tracks))
	}
}

func TestUnreadableLikedSongsReportTheirShapeOnce(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })
	likedShapeOnce = sync.Once{}

	// The page a refused request can come back as: no header, no tracks.
	doc := renderers.Node{
		"responseContext": map[string]any{},
		"contents": map[string]any{"messageRenderer": map[string]any{
			"text": map[string]any{"runs": []any{map[string]any{"text": "private words"}}},
		}},
	}
	for range 2 {
		if _, err := ParseLikedSongs(doc, renderers.ParseContext{}); !errors.Is(err, ErrLikedShape) {
			t.Fatalf("err = %v, want ErrLikedShape", err)
		}
	}
	out := buf.String()
	if strings.Count(out, "unreadable shape") != 1 {
		t.Fatalf("shape reported %d times, want once:\n%s", strings.Count(out, "unreadable shape"), out)
	}
	if !strings.Contains(out, "contents") || !strings.Contains(out, "messageRenderer=1") {
		t.Fatalf("shape report lacks keys or renderers: %s", out)
	}
	if strings.Contains(out, "private words") {
		t.Fatal("shape report leaked page content")
	}
}

func TestLibraryArtistsLinkToTheArtistsChannel(t *testing.T) {
	doc := renderers.Node{"contents": []any{map[string]any{
		"musicResponsiveListItemRenderer": map[string]any{
			"flexColumns": []any{map[string]any{"musicResponsiveListItemFlexColumnRenderer": map[string]any{
				"text": map[string]any{"runs": []any{map[string]any{"text": "Some Artist"}}},
			}}},
			"navigationEndpoint": map[string]any{"browseEndpoint": map[string]any{
				"browseId": "MPLAUC_GTBDSR3bd4tXhPZuGwNbQ",
				"browseEndpointContextSupportedConfigs": map[string]any{"browseEndpointContextMusicConfig": map[string]any{
					"pageType": "MUSIC_PAGE_TYPE_LIBRARY_ARTIST",
				}},
			}},
		},
	}}}
	items := LibraryItemsFrom(doc, domain.LibArtist, renderers.ParseContext{})
	if len(items) != 1 || items[0].ID != "UC_GTBDSR3bd4tXhPZuGwNbQ" || items[0].Kind != domain.LibArtist {
		t.Fatalf("got %+v", items)
	}
}
