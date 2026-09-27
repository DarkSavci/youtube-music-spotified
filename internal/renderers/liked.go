package renderers

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
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
		likedShapeOnce.Do(func() { logLikedShape(doc) })
		return domain.Playlist{}, ErrLikedShape
	}
	pl.ID = "LM"
	return pl, nil
}

func logLikedShape(doc Node) {
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
	slog.Warn("liked music came back in an unreadable shape", "bytes", size, "keys", keys, "renderers", top)
}
