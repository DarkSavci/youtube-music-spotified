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

// LikedMessageError is Liked Music answered with a message page that is
// neither a sign-in prompt nor the empty state, carrying YouTube's generic
// wording. It is an error, not an empty list: a throttle or a fault dressed
// as a message must not pass for a library with no likes.
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
// known name. A page without the track list is reported once, by its shape
// (size, top-level keys, renderer counts and any message's wording, never
// other content), and then read as:
//   - a sign-in prompt: ErrLikedSignedOut;
//   - the empty state ("Songs you like will show here"): an empty Liked Music;
//   - any other message: a LikedMessageError with YouTube's wording;
//   - nothing at all: ErrLikedShape, the throttle's shape.
func ParseLikedPlaylist(doc Node, pc ParseContext) (domain.Playlist, error) {
	pl, ok := ParsePlaylistTitled(doc, "VLLM", LikedTitle, pc)
	if !ok {
		text, found := pageMessage(doc)
		likedShapeOnce.Do(func() { logLikedShape(doc, found, text) })
		switch {
		case found && signInPrompt(doc, text):
			return domain.Playlist{}, ErrLikedSignedOut
		case found && emptyState(text):
			// An account with no likes gets a message where the tracks
			// would be: an empty Liked Music, no different from any other.
			// The shape line above keeps a real problem diagnosable.
			return domain.Playlist{ID: "LM", Title: LikedTitle}, nil
		case found:
			return domain.Playlist{}, &LikedMessageError{Text: text}
		}
		return domain.Playlist{}, ErrLikedShape
	}
	pl.ID = "LM"
	return pl, nil
}

// maxMessage bounds how much of a message page is kept, in characters: it is
// a sentence or two of YouTube's wording, and nothing more is wanted in a log
// or an error.
const maxMessage = 120

// emptyWording is how YouTube words Liked Music with nothing in it. Requests
// ask for English (innertube.WithLocale), so English is all there is to match.
var emptyWording = []string{
	"songs you like will show here",
	"will show here",
	"haven't liked",
	"have not liked",
	"no liked songs",
	"no likes yet",
}

// emptyState reports whether a message is Liked Music's empty state.
func emptyState(text string) bool {
	lower := strings.ToLower(strings.ReplaceAll(text, "\u2019", "'"))
	for _, w := range emptyWording {
		if strings.Contains(lower, w) {
			return true
		}
	}
	return false
}

// truncate keeps the first n characters of s, never splitting one.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

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
	return truncate(strings.Join(parts, " "), maxMessage), true
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
