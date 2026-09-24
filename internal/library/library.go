// Package library produces the merged sidebar list.
//
// YouTube Music has no unified library. It has four separate surfaces behind
// four identifiers, each with its own shape, and no notion of folders, of when
// an item was saved, or of when it was last played. Spotify's sidebar is one
// sorted list of everything with all three.
//
// Closing that gap is this module's whole job, and it is why the deletion test
// puts it among the deepest in the system: remove it and the fan-out, the
// merge, the de-duplication and two joins spread into the sidebar component and
// every caller that wants a saved item.
//
// It composes the Identity plane (what YouTube knows) with the Control plane
// (what only we know). Control is optional: before it exists, the interface is
// already whole and the sorts that depend on it simply return unordered.
package library

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"spotifier/internal/domain"
	"spotifier/internal/identity"
)

// Filter narrows the merged list to one kind.
type Filter string

const (
	FilterAll       Filter = ""
	FilterPlaylists Filter = "playlists"
	FilterArtists   Filter = "artists"
	FilterAlbums    Filter = "albums"
)

// Sort orders the merged list.
//
// Recents and RecentlyAdded need Control-plane data. Without it they degrade to
// the underlying order rather than failing, so the UI can offer them from day
// one and they simply become useful later.
type Sort string

const (
	SortRecents       Sort = "recents"        // last played — needs the Play log
	SortRecentlyAdded Sort = "recently_added" // first seen — needs our own record
	SortAlphabetical  Sort = "alphabetical"
	SortCreator       Sort = "creator"
)

// Metadata supplies the facts YouTube Music does not have.
//
// Implemented by the Control plane. A nil Metadata is valid and means "we have
// no record yet", which is the correct state before Control exists and for
// items saved before the user installed the app.
type Metadata interface {
	// Enrich fills AddedAt, FolderID, Pinned and LastPlayedAt in place.
	Enrich(ctx context.Context, items []domain.LibraryItem) error
}

// Library reads the merged library.
type Library interface {
	List(ctx context.Context, f Filter, s Sort) ([]domain.LibraryItem, error)
}

// Service is the default Library.
type Service struct {
	id   identity.Identity
	meta Metadata // may be nil
}

// New builds a Library. meta may be nil until the Control plane exists.
func New(id identity.Identity, meta Metadata) *Service {
	return &Service{id: id, meta: meta}
}

var _ Library = (*Service)(nil)

// List fans out across YouTube's separate library surfaces, merges them into
// one shape, enriches with our own data, and sorts.
//
// A surface that fails does not fail the whole list. A partial library is far
// more useful than an error page, and the failure is visible because the item
// simply is not there.
func (s *Service) List(ctx context.Context, f Filter, srt Sort) ([]domain.LibraryItem, error) {
	type result struct {
		items []domain.LibraryItem
		err   error
	}

	sources := map[Filter]func(context.Context) ([]domain.LibraryItem, error){
		FilterPlaylists: s.id.Playlists,
		FilterArtists:   s.id.Artists,
		FilterAlbums:    s.id.Albums,
	}

	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		merged   []domain.LibraryItem
		firstErr error
	)
	for kind, fetch := range sources {
		if f != FilterAll && f != kind {
			continue
		}
		wg.Add(1)
		go func(fetch func(context.Context) ([]domain.LibraryItem, error)) {
			defer wg.Done()
			items, err := fetch(ctx)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				return
			}
			merged = append(merged, items...)
		}(fetch)
	}
	wg.Wait()

	// Every source failing is a real failure; some failing is a partial list.
	if len(merged) == 0 && firstErr != nil {
		return nil, firstErr
	}

	merged = dedupe(merged)

	// Liked Music is pinned at the top, as Spotify pins Liked Songs. It is a
	// playlist everywhere else in the system, so it is only special here.
	if f == FilterAll || f == FilterPlaylists {
		found := false
		for n := range merged {
			if merged[n].Kind == domain.LibPlaylist && merged[n].ID == "LM" {
				merged[n].Pinned = true
				found = true
			}
		}
		if !found {
			read := s.id.LikedSongs
			if summary, ok := s.id.(interface {
				LikedSongsSummary(context.Context) (domain.Playlist, error)
			}); ok {
				read = summary.LikedSongsSummary
			}
			if liked, err := read(ctx); err == nil && liked.Title != "" {
				merged = append([]domain.LibraryItem{{
					ID: liked.ID, Kind: domain.LibPlaylist, Title: liked.Title,
					Subtitle: pluralSongs(liked.TrackCount), Artwork: liked.Artwork, Pinned: true,
				}}, merged...)
			}
		}
	}

	if s.meta != nil {
		// Enrichment is best-effort: missing folder or play data must not cost
		// the user their library.
		_ = s.meta.Enrich(ctx, merged)
	}

	sortItems(merged, srt)
	return merged, nil
}

// dedupe removes repeats, which occur because an album saved from an artist
// page appears on both surfaces. First occurrence wins.
func dedupe(items []domain.LibraryItem) []domain.LibraryItem {
	seen := make(map[string]bool, len(items))
	out := items[:0]
	for _, it := range items {
		key := string(it.Kind) + ":" + it.ID
		if it.ID == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, it)
	}
	return out
}

// sortItems orders the merged list. Pinned items stay at the top under every
// ordering.
func sortItems(items []domain.LibraryItem, s Sort) {
	byTime := func(a, b *time.Time) (int, bool) {
		switch {
		case a == nil && b == nil:
			return 0, false // nothing to compare; fall through to a stable tiebreak
		case a == nil:
			return 1, true // unknown sorts last
		case b == nil:
			return -1, true
		case a.After(*b):
			return -1, true
		case a.Before(*b):
			return 1, true
		}
		return 0, false
	}

	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.Pinned != b.Pinned {
			return a.Pinned
		}
		switch s {
		case SortAlphabetical:
			return strings.ToLower(a.Title) < strings.ToLower(b.Title)
		case SortCreator:
			ai, bi := strings.ToLower(a.Subtitle), strings.ToLower(b.Subtitle)
			if ai != bi {
				return ai < bi
			}
			return strings.ToLower(a.Title) < strings.ToLower(b.Title)
		case SortRecentlyAdded:
			if c, decided := byTime(a.AddedAt, b.AddedAt); decided {
				return c < 0
			}
			return strings.ToLower(a.Title) < strings.ToLower(b.Title)
		case SortRecents:
			if c, decided := byTime(a.LastPlayedAt, b.LastPlayedAt); decided {
				return c < 0
			}
			return strings.ToLower(a.Title) < strings.ToLower(b.Title)
		}
		return false
	})
}

func pluralSongs(n int) string {
	if n == 1 {
		return "1 song"
	}
	return itoa(n) + " songs"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
