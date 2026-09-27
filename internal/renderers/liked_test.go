package renderers

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
)

func fixtureDoc(t *testing.T, name string) Node {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/fixtures/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

// stripKeys copies v without the given keys, at any depth.
func stripKeys(v any, drop map[string]bool) any {
	switch t := v.(type) {
	case Node:
		return stripKeys(map[string]any(t), drop)
	case map[string]any:
		out := map[string]any{}
		for k, sub := range t {
			if !drop[k] {
				out[k] = stripKeys(sub, drop)
			}
		}
		return out
	case []any:
		out := make([]any, len(t))
		for n, sub := range t {
			out[n] = stripKeys(sub, drop)
		}
		return out
	}
	return v
}

var headers = map[string]bool{
	"musicResponsiveHeaderRenderer": true, "musicDetailHeaderRenderer": true,
	"musicImmersiveHeaderRenderer": true, "musicEditablePlaylistDetailHeaderRenderer": true,
	"musicVisualHeaderRenderer": true, "musicHeaderRenderer": true,
}

func TestLikedMusicWithoutAHeaderReadsUnderItsName(t *testing.T) {
	doc := Node(stripKeys(fixtureDoc(t, "playlist"), headers).(map[string]any))
	pl, err := ParseLikedPlaylist(doc, ParseContext{})
	if err != nil {
		t.Fatal(err)
	}
	if pl.ID != "LM" || pl.Title != LikedTitle || len(pl.Tracks) == 0 {
		t.Fatalf("got id=%q title=%q tracks=%d", pl.ID, pl.Title, len(pl.Tracks))
	}
}

// Tracks from another kind of shelf are not the playlist's own list, so a
// header-less page holding only those does not pass for Liked Music.
func TestHeaderlessFallbackNeedsThePlaylistShelf(t *testing.T) {
	doc := stripKeys(fixtureDoc(t, "playlist"), headers).(map[string]any)
	raw := strings.ReplaceAll(mustJSON(t, doc), `"musicPlaylistShelfRenderer"`, `"musicShelfRenderer"`)
	other, err := Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	likedShapeOnce = sync.Once{}
	if _, err := ParseLikedPlaylist(other, ParseContext{}); !errors.Is(err, ErrLikedShape) {
		t.Fatalf("err = %v, want ErrLikedShape", err)
	}
}

func TestUnreadableLikedMusicReportsItsShapeOnce(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })
	likedShapeOnce = sync.Once{}

	doc := Node{
		"responseContext": map[string]any{},
		"contents": map[string]any{"messageRenderer": map[string]any{
			"text": map[string]any{"runs": []any{map[string]any{"text": "private words"}}},
		}},
	}
	for range 2 {
		if _, err := ParseLikedPlaylist(doc, ParseContext{}); !errors.Is(err, ErrLikedShape) {
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

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
