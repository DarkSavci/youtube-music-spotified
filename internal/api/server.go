// Package api exposes the Go core over HTTP for the UI process.
//
// The UI always talks to this interface and never knows whether the far end is
// a sidecar on localhost or, later, a hosted deployment of the Catalog and
// Control planes. That is the whole reason routes are
// grouped by plane below: the Identity routes are the ones that can never move.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"spotifier/internal/audiocache"
	"strconv"
	"sync"
	"time"

	"spotifier/internal/account"
	"spotifier/internal/catalog"
	"spotifier/internal/control"
	"spotifier/internal/domain"
	"spotifier/internal/identity"
	"spotifier/internal/innertube"
	"spotifier/internal/library"
	"spotifier/internal/loudness"
	"spotifier/internal/lyrics"
	"spotifier/internal/mixes"
	"spotifier/internal/obs"
	"spotifier/internal/report"
	"spotifier/internal/resolver"
	"spotifier/internal/session"
)

// Deps are the modules a Server exposes.
type Deps struct {
	Catalog catalog.Catalog

	// Account holds the signed-in state and everything derived from it. It is
	// read per request rather than captured here, because signing in happens
	// while the process is running. Nil, or holding a signed-out State, leaves
	// catalog browsing working and the Identity routes reporting "signed out".
	//
	// Named for what it carries: "Session" in this codebase means the
	// listening session, not an authentication one.
	Account *account.Store

	Recorder *obs.Recorder
	Log      *slog.Logger

	// Resolver turns a Track into something playable. Nil means playback is
	// unavailable while browsing still works.
	Resolver resolver.Resolver

	// URLs keeps resolutions across restarts, so a replay within a URL's
	// lifetime skips yt-dlp. Nil keeps them in memory only.
	URLs URLStore

	// Audio keeps tracks on disk, so they start without being resolved. Nil
	// means every play resolves and streams from upstream.
	Audio *audiocache.Cache

	// Control owns the Play log, folders and everything derived from them.
	// Nil means the statistics surfaces are unavailable; nothing else changes.
	Control *control.Store

	// Mixes generates playlists from the Play log. Nil means the generated
	// shelves are absent; browsing is unaffected.
	Mixes *mixes.Generator

	// Lyrics resolves a Track's words. Nil means the lyrics panel reports
	// that lyrics are unavailable rather than the route disappearing.
	Lyrics *lyrics.Service

	// Loudness reports how loud a Track is, so the client can correct for it
	// before playing rather than measuring after. Nil means the client falls
	// back to measuring, which is what it did before this existed.
	Loudness *loudness.Service

	// Session is authoritative playback state. Nil leaves the client driving
	// playback locally, which still works but cannot hand off between devices.
	Session *session.Hub

	// Report tells YouTube what was played. Nil, or switched off, means the
	// account never learns this player exists — which is the default.
	Report *report.Reporter

	// Resume remembers where the listener left off. Nil means the queue is
	// forgotten when the process ends, which is what happens without a
	// database to write it to.
	Resume *session.Keeper
}

// Server routes HTTP to the core modules.
type Server struct {
	deps Deps
	mux  *http.ServeMux

	streams  *streamCache
	prefetch *prefetcher
	autoplay *autoplay
	// lastFailure is each track's most recent resolution error, for
	// diagnosing a failed track without resolving it again.
	lastFailure sync.Map
	// fills counts the downloads under way for each track.
	fills sync.Map

	// Resolutions in progress, so concurrent askers share one subprocess
	// rather than each starting their own. See resolveCached.
	pendingMu sync.Mutex
	pending   map[string]*pendingResolve
	// Separate client from the API one: audio transfers are long-lived and
	// must not be cut short by a timeout sized for JSON requests.
	streamClient *http.Client
}

func New(d Deps) *Server {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	s := &Server{
		deps:     d,
		mux:      http.NewServeMux(),
		streams:  newStreamCache(),
		prefetch: newPrefetcher(),
		autoplay: newAutoplay(),
		// No total deadline — a three-hour mix is one transfer — but a
		// connection that never answers, or answers and then stops, must not
		// hang playback: dial, handshake and headers are bounded here, and
		// every body is read through a stall guard.
		streamClient: &http.Client{Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 15 * time.Second,
			IdleConnTimeout:       90 * time.Second,
			MaxIdleConnsPerHost:   8,
			ForceAttemptHTTP2:     true,
		}},
	}
	s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// The UI runs from a different origin in development.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.mux.ServeHTTP(w, r)
}

func (s *Server) routes() {
	// Catalog plane — public metadata, no credentials, cacheable, and the part
	// that could later be served centrally.
	s.mux.HandleFunc("GET /v1/home", s.handleHome)
	s.mux.HandleFunc("GET /v1/browse/{surface}", s.handleBrowse)
	s.mux.HandleFunc("GET /v1/search", s.handleSearch)
	s.mux.HandleFunc("GET /v1/suggest", s.handleSuggest)
	s.mux.HandleFunc("GET /v1/albums/{id}", s.handleAlbum)
	s.mux.HandleFunc("GET /v1/artists/{id}", s.handleArtist)
	s.mux.HandleFunc("GET /v1/playlists/{id}", s.handlePlaylist)
	s.mux.HandleFunc("GET /v1/radio/{id}", s.handleRadio)
	s.mux.HandleFunc("POST /v1/session/radio", s.handleStartRadio)
	s.mux.HandleFunc("GET /v1/podcasts/{id}", s.handlePodcast)
	s.mux.HandleFunc("GET /v1/tracks/{id}/lyrics", s.handleLyrics)
	s.mux.HandleFunc("GET /v1/tracks/{id}/loudness", s.handleLoudness)
	s.mux.HandleFunc("GET /v1/tracks/{id}/health", s.handleTrackHealth)

	// Identity plane — the user's own account. These never move off the Device.
	s.mux.HandleFunc("GET /v1/me", s.handleMe)
	s.mux.HandleFunc("GET /v1/me/library", s.handleLibrary)
	s.mux.HandleFunc("GET /v1/me/liked", s.handleLiked)
	s.mux.HandleFunc("GET /v1/me/history", s.handleHistory)
	s.mux.HandleFunc("POST /v1/me/tracks/{id}/rating", s.handleRate)
	s.mux.HandleFunc("POST /v1/me/artists/{id}/follow", s.handleFollow)
	s.mux.HandleFunc("POST /v1/me/playlists", s.handleCreatePlaylist)
	s.mux.HandleFunc("DELETE /v1/me/playlists/{id}", s.handleDeletePlaylist)
	s.mux.HandleFunc("POST /v1/me/playlists/{id}/tracks", s.handleAddToPlaylist)
	s.mux.HandleFunc("DELETE /v1/me/playlists/{id}/tracks", s.handleRemoveFromPlaylist)
	// The shell calls this after a sign-in writes new credentials. Without it
	// the file changes and nothing reads it again until a restart, which is
	// exactly what made signing in look like it did nothing.
	s.mux.HandleFunc("POST /v1/auth/reload", s.handleAuthReload)
	s.mux.HandleFunc("POST /v1/auth/sign-out", s.handleAuthSignOut)

	// Playback. Resolution and byte transfer both stay on the Device: the
	// stream URL is bound to this machine's address, so a proxy here preserves
	// that binding rather than breaking it.
	s.mux.HandleFunc("GET /v1/resolve/{id}", s.handleResolve)
	s.mux.HandleFunc("GET /v1/stream/{id}", s.handleStream)
	s.mux.HandleFunc("POST /v1/prefetch/{id}", s.handlePrefetch)
	s.mux.HandleFunc("GET /v1/cache", s.handleCache)
	s.mux.HandleFunc("DELETE /v1/cache", s.handleCache)

	// Control plane — ours, not YouTube's. No credentials involved, which is
	// why these could later be served centrally.
	s.mux.HandleFunc("POST /v1/me/plays", s.handleRecordPlays)
	s.mux.HandleFunc("GET /v1/me/stats/tracks", s.handleTopTracks)
	s.mux.HandleFunc("GET /v1/me/stats/artists", s.handleTopArtists)
	s.mux.HandleFunc("GET /v1/me/stats/on-repeat", s.handleOnRepeat)
	s.mux.HandleFunc("GET /v1/me/stats/albums", s.handleTopAlbums)
	s.mux.HandleFunc("GET /v1/me/stats/summary", s.handleStatsSummary)
	s.mux.HandleFunc("GET /v1/me/stats/lookup", s.handleStatsLookup)
	s.mux.HandleFunc("GET /v1/me/stats/detail", s.handleStatsDetail)
	s.mux.HandleFunc("GET /v1/artists/{id}/affinity", s.handleAffinity)
	s.mux.HandleFunc("GET /v1/me/mixes", s.handleMixes)
	s.mux.HandleFunc("GET /v1/me/folders", s.handleFolders)
	s.mux.HandleFunc("POST /v1/me/folders", s.handleCreateFolder)
	s.mux.HandleFunc("DELETE /v1/me/folders/{id}", s.handleDeleteFolder)
	s.mux.HandleFunc("POST /v1/me/library/organise", s.handleOrganise)

	// Session: projections stream out, commands come in. The same transport
	// serves the local device and, later, a remote one.
	s.mux.HandleFunc("POST /v1/session/register", s.handleSessionRegister)
	s.mux.HandleFunc("POST /v1/session/command", s.handleSessionCommand)
	s.mux.HandleFunc("POST /v1/session/engine-event", s.handleSessionEngineEvent)
	s.mux.HandleFunc("POST /v1/session/capabilities", s.handleSessionCapabilities)
	s.mux.HandleFunc("POST /v1/session/settings", s.handleSessionSettings)
	s.mux.HandleFunc("GET /v1/session/events", s.handleSessionEvents)
	s.mux.HandleFunc("GET /v1/session", s.handleSessionSnapshot)

	// Diagnostics.
	s.mux.HandleFunc("GET /v1/health", s.handleHealth)
}

// ---------- helpers ----------

func (s *Server) write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		s.deps.Log.Error("encode response", "err", err)
	}
}

type apiError struct {
	Error string `json:"error"`
	// Reauth tells the UI to prompt for sign-in. Only a confirmed logged-out
	// session sets it — never a network failure, or an offline user is sent
	// through a needless login.
	Reauth bool `json:"reauth,omitempty"`
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, identity.ErrLoggedOut):
		s.write(w, http.StatusUnauthorized, apiError{Error: "signed out", Reauth: true})
	case errors.Is(err, context.Canceled):
		// The client went away; nothing to report.
	case errors.Is(err, resolver.ErrRateLimited):
		// 429 rather than 502: the request was fine and the track is fine, so
		// the client must wait rather than treat the track as broken.
		s.deps.Log.Warn("upstream rate limited", "path", r.URL.Path)
		s.write(w, http.StatusTooManyRequests,
			apiError{Error: "rate limited by YouTube; wait a few minutes"})
	default:
		s.deps.Log.Warn("request failed", "path", r.URL.Path, "err", err)
		s.write(w, http.StatusBadGateway, apiError{Error: err.Error()})
	}
}

// account reads the live signed-in state. Every Identity-plane handler goes
// through here, so a sign-in takes effect on the next request rather than on
// the next restart.
func (s *Server) account() account.State {
	if s.deps.Account == nil {
		return account.State{}
	}
	return s.deps.Account.Current()
}

// requireIdentity guards the routes that need a signed-in session, and returns
// the Identity so the caller cannot accidentally read a different snapshot.
func (s *Server) requireIdentity(w http.ResponseWriter) (identity.Identity, bool) {
	id := s.account().Identity
	if id == nil {
		s.write(w, http.StatusUnauthorized, apiError{Error: "signed out", Reauth: true})
		return nil, false
	}
	return id, true
}

// ---------- catalog ----------

func (s *Server) handleHome(w http.ResponseWriter, r *http.Request) {
	page, err := s.deps.Catalog.Home(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, normalizeBrowsePage(page))
}

func (s *Server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	page, err := s.deps.Catalog.Browse(r.Context(), r.PathValue("surface"), r.URL.Query().Get("params"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, normalizeBrowsePage(page))
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		s.write(w, http.StatusOK, normalizeSearch(domain.SearchResults{Query: ""}))
		return
	}
	res, err := s.deps.Catalog.Search(r.Context(), q, domain.SearchFilter(r.URL.Query().Get("filter")))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, normalizeSearch(res))
}

func (s *Server) handleSuggest(w http.ResponseWriter, r *http.Request) {
	out, err := s.deps.Catalog.Suggest(r.Context(), r.URL.Query().Get("q"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if out == nil {
		out = []string{}
	}
	s.write(w, http.StatusOK, out)
}

func (s *Server) handleAlbum(w http.ResponseWriter, r *http.Request) {
	al, err := s.deps.Catalog.Album(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, normalizeAlbum(al))
}

func (s *Server) handleArtist(w http.ResponseWriter, r *http.Request) {
	ar, err := s.deps.Catalog.Artist(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, normalizeArtist(ar))
}

func (s *Server) handlePlaylist(w http.ResponseWriter, r *http.Request) {
	pl, err := s.deps.Catalog.Playlist(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, normalizePlaylist(pl))
}

// ---------- identity ----------

type meResponse struct {
	State   string             `json:"state"`
	Account *innertube.Account `json:"account,omitempty"`
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	client := s.account().Client
	if client == nil {
		s.write(w, http.StatusOK, meResponse{State: string(innertube.LoggedOut)})
		return
	}
	state, acct, err := client.SessionState(r.Context())
	if err != nil && state == innertube.Unknown {
		// Cannot verify is not the same as expired; report it as such so the
		// UI does not prompt for sign-in.
		s.write(w, http.StatusOK, meResponse{State: string(innertube.Unknown)})
		return
	}
	s.write(w, http.StatusOK, meResponse{State: string(state), Account: acct})
}

// handleAuthReload re-reads the credentials file written by the shell.
//
// It carries no credentials itself — the file is the channel, and the core
// only ever reads it from the local filesystem. That keeps the secret out of
// the request and out of any log that records one.
func (s *Server) handleAuthReload(w http.ResponseWriter, r *http.Request) {
	if s.deps.Account == nil {
		s.write(w, http.StatusOK, map[string]any{"signedIn": false})
		return
	}
	if err := s.deps.Account.Reload(); err != nil {
		s.deps.Log.Warn("credential reload failed", "err", err)
		s.write(w, http.StatusOK, map[string]any{"signedIn": false, "error": err.Error()})
		return
	}
	signedIn := s.deps.Account.SignedIn()
	s.deps.Log.Info("credentials reloaded", "signedIn", signedIn)
	s.write(w, http.StatusOK, map[string]any{"signedIn": signedIn})
}

// handleAuthSignOut drops the signed-in state without restarting the core.
func (s *Server) handleAuthSignOut(w http.ResponseWriter, r *http.Request) {
	if s.deps.Account != nil {
		s.deps.Account.Clear()
	}
	s.write(w, http.StatusOK, map[string]any{"signedIn": false})
}

/*
handleLyrics returns a Track's words.

The Track's title, artist and duration come from the query rather than being
looked up: the client already has them, and the timed source keys on them
rather than on a video id. Looking them up again would cost a round trip to
tell us what the caller already knew.

"No lyrics" is a 404 with a body the client renders as a message, not an
error — most tracks have none, and treating that as a failure would put an
alarming banner on a perfectly normal state.
*/
// handlePodcast reads a show and its episodes.
func (s *Server) handlePodcast(w http.ResponseWriter, r *http.Request) {
	pod, err := s.deps.Catalog.Podcast(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, normalizePodcast(pod))
}

// handleRadio returns the endless queue YouTube generates from a seed Track.
//
// Already used internally to build generated mixes; exposed because "go to
// song radio" is the one menu action that turns a single track into
// listening, and rebuilding that client-side would mean a second recommender.
func (s *Server) handleRadio(w http.ResponseWriter, r *http.Request) {
	tracks, err := s.deps.Catalog.Radio(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, nonNilTracks(tracks))
}

func (s *Server) handleLyrics(w http.ResponseWriter, r *http.Request) {
	if s.deps.Lyrics == nil {
		s.write(w, http.StatusServiceUnavailable, apiError{Error: "lyrics unavailable"})
		return
	}
	q := r.URL.Query()
	track := domain.Track{
		Title: q.Get("title"),
		ID:    r.PathValue("id"),
	}
	if artist := q.Get("artist"); artist != "" {
		track.Artists = []domain.ArtistRef{{Name: artist}}
	}
	if album := q.Get("album"); album != "" {
		track.Album = &domain.AlbumRef{Name: album}
	}
	if ms, err := strconv.ParseInt(q.Get("durationMs"), 10, 64); err == nil {
		track.DurationMs = ms
	}

	// Timed lyrics reach a third party, so they are requested explicitly by
	// the client rather than decided here.
	preferTimed := q.Get("timed") == "1"

	got, err := s.deps.Lyrics.Lyrics(r.Context(), track, preferTimed)
	if errors.Is(err, lyrics.ErrNotFound) {
		s.write(w, http.StatusNotFound, apiError{Error: "no lyrics for this track"})
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, got)
}

func (s *Server) handleLibrary(w http.ResponseWriter, r *http.Request) {
	lib := s.account().Library
	if lib == nil {
		s.write(w, http.StatusUnauthorized, apiError{Error: "signed out", Reauth: true})
		return
	}
	q := r.URL.Query()
	items, err := lib.List(r.Context(),
		library.Filter(q.Get("filter")),
		library.Sort(q.Get("sort")))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if items == nil {
		items = []domain.LibraryItem{}
	}
	s.write(w, http.StatusOK, items)
}

func (s *Server) handleLiked(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireIdentity(w)
	if !ok {
		return
	}
	pl, err := id.LikedSongs(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, normalizePlaylist(pl))
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireIdentity(w)
	if !ok {
		return
	}
	tracks, err := id.History(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if tracks == nil {
		tracks = []domain.Track{}
	}
	if limit, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && limit > 0 && limit < len(tracks) {
		tracks = tracks[:limit]
	}
	s.write(w, http.StatusOK, tracks)
}

func (s *Server) handleRate(w http.ResponseWriter, r *http.Request) {
	id, ok := s.requireIdentity(w)
	if !ok {
		return
	}
	var body struct {
		Rating string `json:"rating"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.write(w, http.StatusBadRequest, apiError{Error: "invalid body"})
		return
	}
	if err := id.Rate(r.Context(), r.PathValue("id"), identity.Rating(body.Rating)); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------- diagnostics ----------

type healthResponse struct {
	OK     bool   `json:"ok"`
	Uptime string `json:"uptime"`

	// HaveCredentials means credentials are loaded and well-formed. It is
	// deliberately NOT called "signedIn": an expired session still parses, so
	// this being true says nothing about whether the session is live. Liveness
	// is /v1/me, which runs the canary. Conflating the two sends a user
	// debugging an empty library down the wrong path.
	HaveCredentials bool `json:"haveCredentials"`

	UnknownNodes []obs.UnknownNode `json:"unknownNodes"`
}

var started = time.Now()

// handleHealth exposes the parser-health signal. Renderer-node rot is the
// standing operational risk, so this is the highest-leverage diagnostic in the
// product: it turns "a page looks wrong" into a named node type and a count.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	var unknown []obs.UnknownNode
	if s.deps.Recorder != nil {
		unknown = s.deps.Recorder.UnknownNodes()
	}
	if unknown == nil {
		unknown = []obs.UnknownNode{}
	}
	s.write(w, http.StatusOK, healthResponse{
		OK:              true,
		Uptime:          time.Since(started).Round(time.Second).String(),
		HaveCredentials: s.account().Client != nil && s.account().Client.Authenticated(),
		UnknownNodes:    unknown,
	})
}
