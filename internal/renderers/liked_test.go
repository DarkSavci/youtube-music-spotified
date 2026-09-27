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
	"unicode/utf8"
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

	// Neither header, tracks nor a message: the throttle's shape.
	doc := Node{
		"responseContext": map[string]any{},
		"contents": map[string]any{"sectionListRenderer": map[string]any{"contents": []any{
			map[string]any{"musicShelfRenderer": map[string]any{"title": map[string]any{"runs": []any{map[string]any{"text": "private words"}}}}},
		}}},
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
	if !strings.Contains(out, "contents") || !strings.Contains(out, "sectionListRenderer=1") || !strings.Contains(out, "message=false") {
		t.Fatalf("shape report lacks keys, renderers or the message flag: %s", out)
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

func messagePage(text, subtext string, signIn bool) Node {
	m := map[string]any{
		"text": map[string]any{"runs": []any{map[string]any{"text": text}}},
		"subtext": map[string]any{"messageSubtextRenderer": map[string]any{
			"text": map[string]any{"runs": []any{map[string]any{"text": subtext}}},
		}},
	}
	if signIn {
		m["button"] = map[string]any{"buttonRenderer": map[string]any{
			"navigationEndpoint": map[string]any{"signInEndpoint": map[string]any{}},
		}}
	}
	return Node{"contents": map[string]any{"sectionListRenderer": map[string]any{"contents": []any{
		map[string]any{"itemSectionRenderer": map[string]any{"contents": []any{map[string]any{"messageRenderer": m}}}},
	}}}}
}

// A sign-in prompt is a sign-in problem, not a throttle.
func TestLikedMusicSignInPromptIsSignedOut(t *testing.T) {
	likedShapeOnce = sync.Once{}
	_, err := ParseLikedPlaylist(messagePage("Your likes, in one place", "", true), ParseContext{})
	if !errors.Is(err, ErrLikedSignedOut) || errors.Is(err, ErrLikedShape) {
		t.Fatalf("err = %v, want ErrLikedSignedOut", err)
	}
	likedShapeOnce = sync.Once{}
	_, err = ParseLikedPlaylist(messagePage("Sign in to see your likes", "", false), ParseContext{})
	if !errors.Is(err, ErrLikedSignedOut) {
		t.Fatalf("worded prompt err = %v, want ErrLikedSignedOut", err)
	}
}

// Any other message page, such as the one an account with no likes gets, is
// an empty Liked Music, and the shape report still says a message was there.
func TestLikedMusicMessagePageIsAnEmptyList(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })
	likedShapeOnce = sync.Once{}

	pl, err := ParseLikedPlaylist(messagePage("Songs you like will show here", "Tap the like button", false), ParseContext{})
	if err != nil {
		t.Fatalf("err = %v, want an empty list", err)
	}
	if pl.ID != "LM" || pl.Title != LikedTitle || len(pl.Tracks) != 0 || pl.TrackCount != 0 {
		t.Fatalf("got %+v", pl)
	}
	out := buf.String()
	if !strings.Contains(out, "message=true") || !strings.Contains(out, "Songs you like will show here") {
		t.Fatalf("shape report lacks the message: %s", out)
	}
}

// A message that is not the empty state is an error the UI can retry, not an
// empty library: a throttle or a fault can arrive dressed as a message.
func TestLikedMusicOtherMessageIsAnError(t *testing.T) {
	likedShapeOnce = sync.Once{}
	_, err := ParseLikedPlaylist(messagePage("Something went wrong", "Try again later", false), ParseContext{})
	var msg *LikedMessageError
	if !errors.As(err, &msg) || !errors.Is(err, ErrLikedMessage) || errors.Is(err, ErrLikedShape) {
		t.Fatalf("err = %v, want a LikedMessageError", err)
	}
	if msg.Text != "Something went wrong Try again later" {
		t.Fatalf("text = %q", msg.Text)
	}
}

func TestLikedMusicEmptyStateWordings(t *testing.T) {
	for _, text := range []string{
		"Songs you like will show here",
		"You haven\u2019t liked any songs yet",
		"No liked songs",
	} {
		likedShapeOnce = sync.Once{}
		pl, err := ParseLikedPlaylist(messagePage(text, "", false), ParseContext{})
		if err != nil || pl.Title != LikedTitle || len(pl.Tracks) != 0 {
			t.Fatalf("%q: got %+v, %v", text, pl, err)
		}
	}
}

// Long messages are cut by characters, so a multi-byte one is never split.
func TestLikedMusicMessageIsCutByCharacters(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })
	likedShapeOnce = sync.Once{}

	long := strings.Repeat("şarkı ", 60)
	_, err := ParseLikedPlaylist(messagePage(long, "", false), ParseContext{})
	var msg *LikedMessageError
	if !errors.As(err, &msg) {
		t.Fatalf("err = %v", err)
	}
	if !utf8.ValidString(msg.Text) || utf8.RuneCountInString(msg.Text) != maxMessage+1 || !strings.HasSuffix(msg.Text, "…") {
		t.Fatalf("text not cut to %d characters: %d %q", maxMessage, utf8.RuneCountInString(msg.Text), msg.Text)
	}
	if !utf8.ValidString(buf.String()) || !strings.Contains(buf.String(), strings.TrimSuffix(msg.Text, "…")) {
		t.Fatalf("log line not cut the same way: %s", buf.String())
	}
}
