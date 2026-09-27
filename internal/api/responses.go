package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"spotifier/internal/domain"
	"spotifier/internal/identity"
	"spotifier/internal/library"
	"spotifier/internal/respcache"
)

/*
Kept answers.

Every read route below asks YouTube something, and most of what it asks
barely changes. Deps.Responses keeps the answers (see package respcache):
repeat views, other windows and restarts read the kept copy, and a failing or
rate-limited upstream is covered by the last good one.

Keys are namespaced by who they belong to, so a change of account or a local
edit can drop exactly the right ones:

	cat|…  catalog: the same for anyone on this account's database
	me|…   the signed-in account's own state
	lib|…  the saved-library surfaces behind the sidebar
*/

// How long each kind of answer stays fresh. Past that it is still served
// while a background refresh replaces it.
var (
	policyAlbum     = respcache.Policy{Fresh: 7 * 24 * time.Hour}
	policyArtist    = respcache.Policy{Fresh: 12 * time.Hour}
	policyPlaylist  = respcache.Policy{Fresh: time.Hour}
	policyPodcast   = respcache.Policy{Fresh: time.Hour}
	policyHome      = respcache.Policy{Fresh: 30 * time.Minute}
	policyBrowse    = respcache.Policy{Fresh: 24 * time.Hour}
	policySearch    = respcache.Policy{Fresh: 30 * time.Minute, Keep: 7 * 24 * time.Hour}
	policyRadio     = respcache.Policy{Fresh: time.Hour, Keep: 7 * 24 * time.Hour}
	policyMe        = respcache.Policy{Fresh: time.Hour}
	policyChannels  = respcache.Policy{Fresh: 6 * time.Hour}
	policyLibrary   = respcache.Policy{Fresh: 30 * time.Minute}
	policyLiked     = respcache.Policy{Fresh: 10 * time.Minute}
	policyMixes     = respcache.Policy{Fresh: 24 * time.Hour, Keep: 7 * 24 * time.Hour}
	policyPermanent = respcache.Policy{Fresh: 365 * 24 * time.Hour, Keep: 365 * 24 * time.Hour}
	// Lyrics, found or not, are looked up again after a month: "no lyrics"
	// is sometimes only "not yet".
	policyLyrics = respcache.Policy{Fresh: 30 * 24 * time.Hour, Keep: 30 * 24 * time.Hour}
)

// likedFullSync is how often Liked Music is read in full, to catch songs
// unliked elsewhere; in between, only the new likes at the top are read.
const likedFullSync = 24 * time.Hour

// NewResponseCache builds the cache main wires into Deps.Responses. persist
// may be nil to keep answers in memory only.
func NewResponseCache(persist respcache.Persist, log *slog.Logger) *respcache.Cache {
	o := respcache.Options{ServeStale: coverableError, Log: log}
	if persist != nil {
		o.Persist = persist
	}
	return respcache.New(o)
}

// coverableError decides which failures a kept answer may stand in for. A
// signed-out session must reach the UI as itself, so it can prompt sign-in.
func coverableError(err error) bool {
	return !errors.Is(err, identity.ErrLoggedOut) && !errors.Is(err, context.Canceled)
}

// produced is what a route builds when it has to ask upstream: the status it
// writes and the value it encodes.
type produced struct {
	status int
	value  any
}

func okBody(v any) (produced, error) { return produced{status: http.StatusOK, value: v}, nil }

// serveKept answers from the kept copy when it can, and asks upstream through
// produce when it must. Without a cache it is exactly produce-then-write.
func (s *Server) serveKept(w http.ResponseWriter, r *http.Request, key string, p respcache.Policy,
	produce func(ctx context.Context) (produced, error)) {
	if s.deps.Responses == nil {
		out, err := produce(r.Context())
		if err != nil {
			s.fail(w, r, err)
			return
		}
		s.write(w, out.status, out.value)
		return
	}
	e, res, err := s.deps.Responses.Get(r.Context(), key, p, func(ctx context.Context) (respcache.Entry, error) {
		out, err := produce(ctx)
		if err != nil {
			return respcache.Entry{}, err
		}
		body, err := json.Marshal(out.value)
		if err != nil {
			return respcache.Entry{}, err
		}
		return respcache.Entry{Status: out.status, Body: body}, nil
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeKept(w, e, res)
}

// writeKept writes a kept answer as the route first wrote it, and says where
// it came from.
func writeKept(w http.ResponseWriter, e respcache.Entry, res respcache.Result) {
	w.Header().Set("X-Cache", string(res))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(e.Status)
	_, _ = w.Write(e.Body)
}

// libraryMeta is the local folder, pin and play data the library enriches
// with, or nil without a database.
func (s *Server) libraryMeta() library.Metadata {
	if s.deps.Control == nil {
		return nil
	}
	return s.deps.Control
}

// cacheKey joins parts with a separator no identifier contains.
func cacheKey(parts ...string) string { return strings.Join(parts, "|") }

// forget drops kept answers under the given prefixes; expire keeps them but
// makes the next read refresh them.
func (s *Server) forget(ctx context.Context, prefixes ...string) {
	if s.deps.Responses == nil {
		return
	}
	for _, p := range prefixes {
		s.deps.Responses.Invalidate(ctx, p)
	}
}

func (s *Server) expire(ctx context.Context, prefixes ...string) {
	if s.deps.Responses == nil {
		return
	}
	for _, p := range prefixes {
		s.deps.Responses.Expire(ctx, p)
	}
}

// playlistKeys are every kept form of one playlist: whole, or page by page.
func playlistKeys(id string) string { return cacheKey("cat", "playlist", id) + "|" }

// ---------- the saved library ----------

/*
keptLibrary is the Identity the sidebar's library reads through: its three
library surfaces and the Liked Music summary are kept answers, and everything
else goes straight to the account.

The merge, the local folder and pin data and the sort are applied fresh on
every read, so organising the sidebar or playing something shows at once;
only the part YouTube supplies is kept.
*/
type keptLibrary struct {
	identity.Identity
	s *Server
}

func (k keptLibrary) Playlists(ctx context.Context) ([]domain.LibraryItem, error) {
	return k.items(ctx, "playlists", k.Identity.Playlists)
}

func (k keptLibrary) Artists(ctx context.Context) ([]domain.LibraryItem, error) {
	return k.items(ctx, "artists", k.Identity.Artists)
}

func (k keptLibrary) Albums(ctx context.Context) ([]domain.LibraryItem, error) {
	return k.items(ctx, "albums", k.Identity.Albums)
}

func (k keptLibrary) LikedSongsSummary(ctx context.Context) (domain.Playlist, error) {
	read := k.Identity.LikedSongs
	if summary, ok := k.Identity.(interface {
		LikedSongsSummary(context.Context) (domain.Playlist, error)
	}); ok {
		read = summary.LikedSongsSummary
	}
	e, _, err := k.s.deps.Responses.Get(ctx, cacheKey("lib", "liked-summary"), policyLibrary,
		func(ctx context.Context) (respcache.Entry, error) {
			pl, err := read(ctx)
			if err != nil {
				return respcache.Entry{}, err
			}
			pl.Tracks = nil
			body, err := json.Marshal(pl)
			return respcache.Entry{Status: http.StatusOK, Body: body}, err
		})
	if err != nil {
		return domain.Playlist{}, err
	}
	var pl domain.Playlist
	err = json.Unmarshal(e.Body, &pl)
	return pl, err
}

func (k keptLibrary) items(ctx context.Context, surface string,
	read func(context.Context) ([]domain.LibraryItem, error)) ([]domain.LibraryItem, error) {
	e, _, err := k.s.deps.Responses.Get(ctx, cacheKey("lib", surface), policyLibrary,
		func(ctx context.Context) (respcache.Entry, error) {
			items, err := read(ctx)
			if err != nil {
				return respcache.Entry{}, err
			}
			body, err := json.Marshal(items)
			return respcache.Entry{Status: http.StatusOK, Body: body}, err
		})
	if err != nil {
		return nil, err
	}
	var items []domain.LibraryItem
	err = json.Unmarshal(e.Body, &items)
	return items, err
}

// ---------- Liked Music ----------

// likedPager is the incremental read the production Identity offers.
type likedPager interface {
	LikedSongsSince(ctx context.Context, known func(id string) bool) (domain.Playlist, bool, error)
}

var (
	likedKey     = cacheKey("me", "liked")
	likedSyncKey = cacheKey("me", "liked-full-sync")
)

/*
readLiked is Liked Music, read as little as possible.

The kept list is refreshed from its newest end: new likes are at the top, so
one page usually finds a song already known and the read stops there. Once a
day, or when the advertised count disagrees with what is kept, the whole list
is read again — that is what catches a song unliked on another device.
*/
func (s *Server) readLiked(ctx context.Context, id identity.Identity) (domain.Playlist, error) {
	full := func() (domain.Playlist, error) {
		pl, err := id.LikedSongs(ctx)
		if err == nil {
			s.deps.Responses.Put(ctx, likedSyncKey, policyPermanent, respcache.Entry{Status: http.StatusOK, Body: []byte("{}")})
		}
		return pl, err
	}
	pager, ok := id.(likedPager)
	if !ok {
		return full()
	}
	kept, have := s.deps.Responses.Peek(ctx, likedKey, policyLiked)
	sync, synced := s.deps.Responses.Peek(ctx, likedSyncKey, policyPermanent)
	if !have || !synced || s.deps.Responses.Now().Sub(sync.StoredAt) > likedFullSync {
		return full()
	}
	var prev domain.Playlist
	if err := json.Unmarshal(kept.Body, &prev); err != nil || len(prev.Tracks) == 0 {
		return full()
	}
	known := make(map[string]bool, len(prev.Tracks))
	for _, t := range prev.Tracks {
		known[t.ID] = true
	}
	head, reached, err := pager.LikedSongsSince(ctx, func(id string) bool { return known[id] })
	if err != nil {
		return domain.Playlist{}, err
	}
	if !reached {
		// Nothing we had is there any more: the list was rebuilt, so the
		// read already went through all of it.
		s.deps.Responses.Put(ctx, likedSyncKey, policyPermanent, respcache.Entry{Status: http.StatusOK, Body: []byte("{}")})
		return finishPlaylist(head), nil
	}
	merged := head
	seen := make(map[string]bool, len(head.Tracks)+len(prev.Tracks))
	merged.Tracks = nil
	for _, t := range append(head.Tracks, prev.Tracks...) {
		if seen[t.ID] {
			continue
		}
		seen[t.ID] = true
		merged.Tracks = append(merged.Tracks, t)
	}
	if merged.TrackCount > 0 && merged.TrackCount != len(merged.Tracks) {
		// Songs were unliked somewhere else; only a full read shows which.
		return full()
	}
	return finishPlaylist(merged), nil
}

func finishPlaylist(pl domain.Playlist) domain.Playlist {
	pl.DurationMs = 0
	for _, t := range pl.Tracks {
		pl.DurationMs += t.DurationMs
	}
	if pl.TrackCount == 0 {
		pl.TrackCount = len(pl.Tracks)
	}
	return pl
}

// unlikeKept removes a song from the kept Liked Music at once, since the
// incremental read would never notice it leaving.
func (s *Server) unlikeKept(ctx context.Context, trackID string) {
	if s.deps.Responses == nil {
		return
	}
	e, ok := s.deps.Responses.Peek(ctx, likedKey, policyLiked)
	if !ok {
		return
	}
	var pl domain.Playlist
	if json.Unmarshal(e.Body, &pl) != nil {
		return
	}
	out := pl.Tracks[:0]
	for _, t := range pl.Tracks {
		if t.ID != trackID {
			out = append(out, t)
		}
	}
	if len(out) == len(pl.Tracks) {
		return
	}
	pl.Tracks = out
	pl.TrackCount = len(out)
	pl = finishPlaylist(pl)
	body, err := json.Marshal(pl)
	if err != nil {
		return
	}
	s.deps.Responses.Put(ctx, likedKey, policyLiked, respcache.Entry{Status: http.StatusOK, Body: body, StoredAt: e.StoredAt})
}
