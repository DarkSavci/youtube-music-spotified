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
	"math"
	"net"
	"net/http"
	"spotifier/internal/audiocache"
	"strconv"
	"strings"
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
	"spotifier/internal/ratelimit"
	"spotifier/internal/renderers"
	"spotifier/internal/report"
	"spotifier/internal/resolver"
	"spotifier/internal/respcache"
	"spotifier/internal/session"
)

// Deps are the modules a Server exposes.
type Deps struct {
	AccountScope string
	Catalog      catalog.Catalog

	// StreamGovernor carries the cooldown after YouTube rate-limits stream
	// resolution; APIGovernor is the one InnerTube calls go through. Both
	// optional: nil never cools down, which is what tests get.
	StreamGovernor *ratelimit.Governor
	APIGovernor    *ratelimit.Governor

	// ClientToken, when set, is a per-launch secret the desktop shell attaches
	// to its own requests. The video routes require it, so a web page cannot
	// drive them through the open CORS policy.
	ClientToken string

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

	// Responses keeps answers read from YouTube (see responses.go). Nil asks
	// upstream on every request, which is what the tests expect.
	Responses *respcache.Cache
}

// Server routes HTTP to the core modules.
type Server struct {
	deps Deps
	mux  *http.ServeMux

	videoMu      sync.Mutex
	videos       map[string]resolvedEntry
	videoFlights map[string]*videoFlight
	streams      *streamCache
	prefetch     *prefetcher
	autoplay     *autoplay
	// failures remembers resolutions that failed, so asking again within a
	// while answers from memory instead of running yt-dlp.
	failures failureMemo
	// streamGov carries the cooldown after YouTube rate-limits stream
	// resolution. Nil (in tests) never cools down.
	streamGov *ratelimit.Governor
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
		videos:   make(map[string]resolvedEntry),
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
	s.streamGov = d.StreamGovernor
	// Speculative work stops the moment YouTube says to slow down, whichever
	// kind of call it said it to.
	d.APIGovernor.OnCooldown(s.prefetch.backOff)
	d.StreamGovernor.OnCooldown(s.prefetch.backOff)
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
	// Calls this request makes to YouTube are logged against its route.
	if _, pattern := s.mux.Handler(r); pattern != "" {
		r = r.WithContext(innertube.WithRoute(r.Context(), pattern))
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
	s.mux.HandleFunc("GET /v1/video-stream/{id}", s.handleVideoStream)
	s.mux.HandleFunc("GET /v1/tracks/{id}/versions", s.handleTrackVersions)
	s.mux.HandleFunc("GET /v1/radio/{id}", s.handleRadio)
	s.mux.HandleFunc("POST /v1/session/radio", s.handleStartRadio)
	s.mux.HandleFunc("GET /v1/podcasts/{id}", s.handlePodcast)
	s.mux.HandleFunc("GET /v1/tracks/{id}/lyrics", s.handleLyrics)
	s.mux.HandleFunc("GET /v1/tracks/{id}/loudness", s.handleLoudness)
	s.mux.HandleFunc("GET /v1/tracks/{id}/health", s.handleTrackHealth)

	// Identity plane — the user's own account. These never move off the Device.
	s.mux.HandleFunc("GET /v1/me", s.handleMe)
	s.mux.HandleFunc("GET /v1/me/channels", s.handleChannels)
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
	// RateLimited marks a 429 the UI must wait out rather than retry, with
	// RetryAfter in seconds (also sent as the Retry-After header).
	RateLimited bool `json:"rateLimited,omitempty"`
	RetryAfter  int  `json:"retryAfter,omitempty"`
}

// rateLimited reports whether err means YouTube asked us to slow down: the
// governor's refusal or a 429 it passed on, or yt-dlp's bot check.
func rateLimited(err error) bool {
	if errors.Is(err, ratelimit.ErrRateLimited) || errors.Is(err, resolver.ErrRateLimited) {
		return true
	}
	var h *innertube.HTTPError
	return errors.As(err, &h) && (h.Status == http.StatusTooManyRequests)
}

// retryAfter is how long the client should wait: what the refusal says, else
// whatever cooldown is running, else a minute.
func retryAfter(err error) time.Duration {
	if d := ratelimit.RetryAfterOf(err); d > 0 {
		return d
	}
	for _, g := range []*ratelimit.Governor{ratelimit.API, ratelimit.Streams} {
		if cooling, left := g.Cooling(); cooling {
			return left
		}
	}
	return time.Minute
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, identity.ErrLoggedOut), errors.Is(err, renderers.ErrLikedSignedOut):
		s.write(w, http.StatusUnauthorized, apiError{Error: "signed out", Reauth: true})
	case errors.Is(err, context.Canceled):
		// The client went away; nothing to report.
	case rateLimited(err):
		// 429 rather than 502: the request was fine and the track is fine, so
		// the client must wait rather than treat the track as broken — and
		// must not retry, which is what kept a rate limit going.
		wait := retryAfter(err)
		s.deps.Log.Warn("upstream rate limited", "path", r.URL.Path, "retryAfter", wait)
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
		s.write(w, http.StatusTooManyRequests,
			apiError{Error: "rate limited by YouTube; wait a few minutes", RateLimited: true, RetryAfter: int(math.Ceil(wait.Seconds()))})
	case errors.Is(err, renderers.ErrLikedMessage):
		// YouTube's generic wording, shown as it is, as an error the UI can
		// retry: it is not an empty library.
		s.deps.Log.Warn("liked music message page", "path", r.URL.Path, "err", err)
		s.write(w, http.StatusBadGateway, apiError{Error: err.Error()})
	case errors.Is(err, renderers.ErrLikedShape):
		// Liked Music without its header or tracks only comes back while
		// YouTube throttles the account. That throttle arrives as a 200 the
		// governor never sees as one, so the cooldown is started here: every
		// call waits, not just this one.
		wait := s.deps.APIGovernor.CoolDown(0)
		if wait <= 0 {
			wait = retryAfter(err)
		}
		s.deps.Log.Warn("liked music throttled", "path", r.URL.Path, "retryAfter", wait)
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
		s.write(w, http.StatusTooManyRequests, apiError{
			Error:       "YouTube is throttling this account's Liked Music; wait a few minutes",
			RateLimited: true,
			RetryAfter:  int(math.Ceil(wait.Seconds())),
		})
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
	s.serveKept(w, r, cacheKey("cat", "home"), policyHome, func(ctx context.Context) (produced, error) {
		page, err := s.deps.Catalog.Home(ctx)
		if err != nil {
			return produced{}, err
		}
		return okBody(normalizeBrowsePage(page))
	})
}

func (s *Server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	surface, params := r.PathValue("surface"), r.URL.Query().Get("params")
	policy := policyBrowse
	if !strings.HasPrefix(surface, "FEmusic_") {
		// An artist's discography and the like change as the artist does.
		policy = policyArtist
	}
	s.serveKept(w, r, cacheKey("cat", "browse", surface, params), policy, func(ctx context.Context) (produced, error) {
		page, err := s.deps.Catalog.Browse(ctx, surface, params)
		if err != nil {
			return produced{}, err
		}
		return okBody(normalizeBrowsePage(page))
	})
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		s.write(w, http.StatusOK, normalizeSearch(domain.SearchResults{Query: ""}))
		return
	}
	filter := r.URL.Query().Get("filter")
	s.serveKept(w, r, cacheKey("cat", "search", strings.ToLower(strings.TrimSpace(q)), filter), policySearch,
		func(ctx context.Context) (produced, error) {
			res, err := s.deps.Catalog.Search(ctx, q, domain.SearchFilter(filter))
			if err != nil {
				return produced{}, err
			}
			return okBody(normalizeSearch(res))
		})
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
	id := r.PathValue("id")
	s.serveKept(w, r, cacheKey("cat", "album", id), policyAlbum, func(ctx context.Context) (produced, error) {
		al, err := s.deps.Catalog.Album(ctx, id)
		if err != nil {
			return produced{}, err
		}
		return okBody(normalizeAlbum(al))
	})
}

func (s *Server) handleArtist(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.serveKept(w, r, cacheKey("cat", "artist", id), policyArtist, func(ctx context.Context) (produced, error) {
		ar, err := s.deps.Catalog.Artist(ctx, id)
		if err != nil {
			return produced{}, err
		}
		return okBody(normalizeArtist(ar))
	})
}

func (s *Server) handlePlaylist(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if r.URL.Query().Get("paged") == "1" {
		cont := r.URL.Query().Get("continuation")
		s.serveKept(w, r, playlistKeys(id)+cacheKey("page", cont), policyPlaylist, func(ctx context.Context) (produced, error) {
			if pages, ok := s.deps.Catalog.(interface {
				PlaylistPage(context.Context, string, string) (domain.PlaylistPage, error)
			}); ok {
				page, err := pages.PlaylistPage(ctx, id, cont)
				if err != nil {
					return produced{}, err
				}
				page.Playlist = normalizePlaylist(page.Playlist)
				return produced{status: http.StatusOK, value: page}, nil
			}
			// Fixture adapters have a finite, already complete list.
			pl, err := s.deps.Catalog.Playlist(ctx, id)
			if err != nil {
				return produced{}, err
			}
			return produced{status: http.StatusOK, value: domain.PlaylistPage{Playlist: normalizePlaylist(pl)}}, nil
		})
		return
	}
	s.serveKept(w, r, playlistKeys(id)+"whole", policyPlaylist, func(ctx context.Context) (produced, error) {
		pl, err := s.deps.Catalog.Playlist(ctx, id)
		if err != nil {
			return produced{}, err
		}
		return okBody(normalizePlaylist(pl))
	})
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
	if s.deps.Responses == nil {
		state, acct, err := client.SessionState(r.Context())
		if err != nil && state == innertube.Unknown {
			// Cannot verify is not the same as expired; report it as such so
			// the UI does not prompt for sign-in.
			s.write(w, http.StatusOK, meResponse{State: string(innertube.Unknown)})
			return
		}
		s.write(w, http.StatusOK, meResponse{State: string(state), Account: acct})
		return
	}
	// "Cannot verify" is never kept: the last verified answer covers it, and
	// without one it is reported as unknown rather than as an error.
	e, res, err := s.deps.Responses.Get(r.Context(), cacheKey("me", "state"), policyMe,
		func(ctx context.Context) (respcache.Entry, error) {
			state, acct, err := client.SessionState(ctx)
			if err != nil && state == innertube.Unknown {
				return respcache.Entry{}, err
			}
			body, err := json.Marshal(meResponse{State: string(state), Account: acct})
			return respcache.Entry{Status: http.StatusOK, Body: body}, err
		})
	if err != nil {
		s.write(w, http.StatusOK, meResponse{State: string(innertube.Unknown)})
		return
	}
	writeKept(w, e, res)
}

func (s *Server) handleChannels(w http.ResponseWriter, r *http.Request) {
	client := s.account().Client
	if client == nil {
		s.write(w, http.StatusUnauthorized, map[string]string{"error": "Sign in first"})
		return
	}
	s.serveKept(w, r, cacheKey("me", "channels"), policyChannels, func(ctx context.Context) (produced, error) {
		channels, err := client.Channels(ctx)
		if err != nil {
			return produced{}, err
		}
		return okBody(channels)
	})
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
	// Tracks that failed signed out (age checks, account-only formats) may
	// play now.
	s.failures.clear()
	s.deps.Log.Info("credentials reloaded", "signedIn", signedIn)
	// Whatever was kept for the previous session is not this one's.
	s.forget(r.Context(), "me|", "lib|", cacheKey("cat", "home"))
	s.write(w, http.StatusOK, map[string]any{"signedIn": signedIn})
}

// handleAuthSignOut drops the signed-in state without restarting the core.
func (s *Server) handleAuthSignOut(w http.ResponseWriter, r *http.Request) {
	if s.deps.Account != nil {
		s.deps.Account.Clear()
	}
	s.forget(r.Context(), "me|", "lib|", cacheKey("cat", "home"))
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
	id := r.PathValue("id")
	s.serveKept(w, r, cacheKey("cat", "podcast", id), policyPodcast, func(ctx context.Context) (produced, error) {
		pod, err := s.deps.Catalog.Podcast(ctx, id)
		if err != nil {
			return produced{}, err
		}
		return okBody(normalizePodcast(pod))
	})
}

// handleRadio returns the endless queue YouTube generates from a seed Track.
//
// Already used internally to build generated mixes; exposed because "go to
// song radio" is the one menu action that turns a single track into
// listening, and rebuilding that client-side would mean a second recommender.
func (s *Server) handleRadio(w http.ResponseWriter, r *http.Request) {
	// ?list= names a generated queue other than the song's own radio (an
	// artist's mix); the path is then the song that list starts from.
	id := r.PathValue("id")
	if list := r.URL.Query().Get("list"); list != "" {
		mix := domain.MixSeed{VideoID: id, PlaylistID: list, Params: r.URL.Query().Get("params")}
		s.serveKept(w, r, cacheKey("cat", "radio", id, list, mix.Params), policyRadio, func(ctx context.Context) (produced, error) {
			tracks, _, err := s.deps.Catalog.MixPage(ctx, mix, "")
			if err != nil {
				return produced{}, err
			}
			return okBody(nonNilTracks(tracks))
		})
		return
	}
	s.serveKept(w, r, cacheKey("cat", "radio", id), policyRadio, func(ctx context.Context) (produced, error) {
		tracks, err := s.deps.Catalog.Radio(ctx, id)
		if err != nil {
			return produced{}, err
		}
		return okBody(nonNilTracks(tracks))
	})
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

	key := cacheKey("cat", "lyrics", track.ID, q.Get("timed"), q.Get("video"),
		q.Get("title"), q.Get("artist"), q.Get("album"), q.Get("durationMs"))
	s.serveKept(w, r, key, policyLyrics, func(ctx context.Context) (produced, error) {
		got, err := s.deps.Lyrics.Lyrics(ctx, track, preferTimed)
		if q.Get("video") == "1" && (errors.Is(err, lyrics.ErrNotFound) || (err == nil && preferTimed && !got.Synced)) {
			if fallback, fallbackErr := s.videoLyrics(ctx, track, preferTimed); fallbackErr == nil && (err != nil || fallback.Synced) {
				got, err = fallback, nil
			}
		}
		if errors.Is(err, lyrics.ErrNotFound) {
			// Most songs have none. That is an answer, and it is kept.
			return produced{status: http.StatusNotFound, value: apiError{Error: "no lyrics for this track"}}, nil
		}
		if err != nil {
			return produced{}, err
		}
		return okBody(got)
	})
}

func (s *Server) handleLibrary(w http.ResponseWriter, r *http.Request) {
	lib := s.account().Library
	if lib == nil {
		s.write(w, http.StatusUnauthorized, apiError{Error: "signed out", Reauth: true})
		return
	}
	// With answers kept, the library reads its YouTube surfaces through them
	// and still merges, enriches and sorts on every request.
	if _, isService := lib.(*library.Service); isService && s.deps.Responses != nil {
		if id := s.account().Identity; id != nil {
			lib = library.New(keptLibrary{Identity: id, s: s}, s.libraryMeta())
		}
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
	if s.deps.Responses == nil {
		pl, err := id.LikedSongs(r.Context())
		if err != nil {
			s.fail(w, r, err)
			return
		}
		s.write(w, http.StatusOK, normalizePlaylist(pl))
		return
	}
	s.serveKept(w, r, likedKey, policyLiked, func(ctx context.Context) (produced, error) {
		pl, err := s.readLiked(ctx, id)
		if err != nil {
			return produced{}, err
		}
		return okBody(normalizePlaylist(pl))
	})
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
	// A like lands at the top of Liked Music, which the next read picks up
	// in one page; an unlike is applied to the kept list directly.
	if identity.Rating(body.Rating) == identity.RatingLike {
		s.expire(r.Context(), likedKey)
	} else {
		s.unlikeKept(r.Context(), r.PathValue("id"))
	}
	s.expire(r.Context(), playlistKeys("LM"), playlistKeys("VLLM"), cacheKey("lib", "liked-summary"))
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
