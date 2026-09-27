package renderers

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"

	"spotifier/internal/domain"
)

// LikedTitle is Liked Music's name, which a page without its header lacks.
const LikedTitle = "Liked Music"

// ErrLikedShape means Liked Music came back with neither its header nor its
// track list. It has only been seen in the bursts where YouTube also answers
// the library with HTTP 429, so it is a sign of throttling to wait out rather
// than a parser to fix.
var ErrLikedShape = errors.New("liked music came back without its header or tracks (YouTube is likely throttling this account)")

// ErrLikedSignedOut means Liked Music was asked for without a signed-in
// session, or YouTube answered with a prompt to sign in. Either way the answer
// is to sign in, not to wait.
var ErrLikedSignedOut = errors.New("liked music needs a signed-in account")

// ErrLikedMessage matches a LikedMessageError.
var ErrLikedMessage = errors.New("youtube returned a message instead of liked music")

// LikedMessageError is Liked Music answered with a message page rather than
// the playlist, carrying YouTube's own wording, which is generic text rather
// than anything from the account.
type LikedMessageError struct{ Text string }

func (e *LikedMessageError) Error() string {
	if e.Text == "" {
		return "YouTube returned a message instead of Liked Music"
	}
	return "YouTube returned a message instead of Liked Music: " + e.Text
}

func (e *LikedMessageError) Is(target error) bool { return target == ErrLikedMessage }

// IsLikedID reports whether a playlist id is Liked Music, with or without the
// browse prefix.
func IsLikedID(id string) bool { return id == "LM" || id == "VLLM" }

// likedShapeOnce keeps the shape report to one per run.
var likedShapeOnce sync.Once

// ParseLikedPlaylist reads the first page of Liked Music.
//
// A page with the playlist's track list but no header still reads, under its
// known name. A page with neither returns ErrLikedShape and is reported once,
// by its shape only: size, top-level keys and renderer counts, never content.
func ParseLikedPlaylist(doc Node, pc ParseContext) (domain.Playlist, error) {
	pl, ok := ParsePlaylistTitled(doc, "VLLM", LikedTitle, pc)
	if !ok {
		text, found := pageMessage(doc)
		likedShapeOnce.Do(func() { logLikedShape(doc, found, text) })
		switch {
		case found && signInPrompt(doc, text):
			return domain.Playlist{}, ErrLikedSignedOut
		case found:
			return domain.Playlist{}, &LikedMessageError{Text: text}
		}
		return domain.Playlist{}, ErrLikedShape
	}
	pl.ID = "LM"
	return pl, nil
}

// maxMessage bounds how much of a message page is kept: it is a sentence or
// two of YouTube's wording, and nothing more is wanted in a log or an error.
const maxMessage = 200

// pageMessage reads the text of a message page's first messageRenderer: its
// text, then its subtext.
func pageMessage(doc Node) (string, bool) {
	m := Find(doc, "messageRenderer")
	if m == nil {
		return "", false
	}
	var parts []string
	for _, key := range []string{"text", "subtext"} {
		if t := strings.TrimSpace(textOf(m.Child(key))); t != "" {
			parts = append(parts, t)
		}
	}
	if sub := Find(m, "messageSubtextRenderer"); sub != nil {
		if t := strings.TrimSpace(textOf(sub.Child("text"))); t != "" {
			parts = append(parts, t)
		}
	}
	text := strings.Join(parts, " ")
	if len(text) > maxMessage {
		text = text[:maxMessage]
	}
	return text, true
}

// signInPrompt reports whether a message page asks the listener to sign in:
// a sign-in button, or wording that says so.
func signInPrompt(doc Node, text string) bool {
	if Find(doc, "signInEndpoint") != nil {
		return true
	}
	lower := strings.ToLower(text)
	return strings.Contains(lower, "sign in") || strings.Contains(lower, "signed in")
}

func logLikedShape(doc Node, message bool, text string) {
	keys := make([]string, 0, len(doc))
	for k := range doc {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	types := RendererTypes(map[string]any(doc))
	names := make([]string, 0, len(types))
	for name := range types {
		names = append(names, name)
	}
	sort.Slice(names, func(a, b int) bool {
		if types[names[a]] != types[names[b]] {
			return types[names[a]] > types[names[b]]
		}
		return names[a] < names[b]
	})
	if len(names) > 15 {
		names = names[:15]
	}
	top := make([]string, len(names))
	for n, name := range names {
		top[n] = fmt.Sprintf("%s=%d", name, types[name])
	}
	size := 0
	if raw, err := json.Marshal(doc); err == nil {
		size = len(raw)
	}
	slog.Warn("liked music came back in an unreadable shape", "bytes", size, "keys", keys, "renderers", top,
		"message", message, "messageText", text)
}
