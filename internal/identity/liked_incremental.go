package identity

import (
	"context"
	"fmt"

	"spotifier/internal/domain"
	"spotifier/internal/renderers"
)

// likedPageLimit bounds an incremental read the same way a full one is
// bounded: YouTube caps Liked Music at 5,000 songs, 100 to a page.
const likedPageLimit = 60

// likedOverlap is how many songs already known in a row end an incremental
// read. One is not enough: a song liked again moves to the top, and stopping
// there would miss what was liked before it. A run this long is the old list
// continuing.
const likedOverlap = 5

/*
LikedSongsSince reads Liked Music from its newest end and stops once it is
reading songs already known.

Liked Music lists the newest like first, so everything liked since the last
read is at the top. Reading until a run of known songs turns up costs one page
in the usual case, where a full read is one page per hundred songs, every time.

The returned Playlist carries the header (title, artwork, the advertised count
when YouTube gives one) and the songs read before the known run, in order —
including any known song that moved up, so the caller can put it back on top.
reachedKnown reports whether the run was found; when it was not, the read went
to the end and the Playlist is the whole list. TrackCount is zero when YouTube
did not say, so the caller can tell a real count from one derived from the
first page.
*/
func (i *InnerTube) LikedSongsSince(ctx context.Context, known func(id string) bool) (pl domain.Playlist, reachedKnown bool, err error) {
	doc, err := i.browse(ctx, SurfaceLikedSongs)
	if err != nil {
		return domain.Playlist{}, false, err
	}
	pl, err = ParseLikedSongs(doc, i.ctxFor("liked"))
	if err != nil {
		return domain.Playlist{}, false, err
	}
	pl.ID = "LM"
	if pl.Title == "" {
		pl.Title = "Liked Music"
	}
	tok := renderers.PlaylistNext(doc)
	if tok != "" && pl.TrackCount == len(pl.Tracks) {
		pl.TrackCount = 0 // derived from the first page, not advertised
	}

	page := pl.Tracks
	pl.Tracks = nil
	run := 0
	seen := map[string]bool{}
	for n := 0; ; n++ {
		for _, t := range page {
			if known(t.ID) {
				run++
				if run >= likedOverlap {
					// Drop the known run itself; the caller has it already.
					pl.Tracks = pl.Tracks[:len(pl.Tracks)-(run-1)]
					return pl, true, nil
				}
			} else {
				run = 0
			}
			pl.Tracks = append(pl.Tracks, t)
		}
		if tok == "" || n >= likedPageLimit {
			// The list ended inside a known run shorter than the window: the
			// whole list has been read, which is also a complete answer.
			return pl, false, nil
		}
		if seen[tok] {
			return domain.Playlist{}, false, fmt.Errorf("repeated playlist continuation")
		}
		seen[tok] = true
		next, err := i.call(ctx, "browse", map[string]any{"continuation": tok})
		if err != nil {
			return domain.Playlist{}, false, err
		}
		page, tok = renderers.ParsePlaylistContinuation(next)
	}
}
