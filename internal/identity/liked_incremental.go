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

/*
LikedSongsSince reads Liked Music from its newest end and stops at the first
song already known.

Liked Music lists the newest like first, so everything liked since the last
read is at the top. Reading until a known song turns up costs one page in the
usual case, where a full read is one page per hundred songs, every time.

The returned Playlist carries the header (title, artwork, the advertised count
when YouTube gives one) and only the new songs. reachedKnown reports whether a
known song was found; when it was not, the read went to the end and the
Playlist is the whole list. TrackCount is zero when YouTube did not say, so
the caller can tell a real count from one derived from the first page.
*/
func (i *InnerTube) LikedSongsSince(ctx context.Context, known func(id string) bool) (pl domain.Playlist, reachedKnown bool, err error) {
	doc, err := i.browse(ctx, SurfaceLikedSongs)
	if err != nil {
		return domain.Playlist{}, false, err
	}
	pl, ok := renderers.ParsePlaylist(doc, SurfaceLikedSongs, i.ctxFor("liked"))
	if !ok {
		return domain.Playlist{}, false, fmt.Errorf("identity: liked songs did not parse")
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
	seen := map[string]bool{}
	for n := 0; ; n++ {
		for _, t := range page {
			if known(t.ID) {
				return pl, true, nil
			}
			pl.Tracks = append(pl.Tracks, t)
		}
		if tok == "" || n >= likedPageLimit {
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
