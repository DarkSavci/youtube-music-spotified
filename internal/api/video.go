package api

import (
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"spotifier/internal/domain"
	"spotifier/internal/lyrics"
	"spotifier/internal/resolver"
)

var videoIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// A video's decorated title and different duration may not match lyrics
// providers. Only use an explicitly linked song, never a search guess.
func (s *Server) videoLyrics(ctx context.Context, track domain.Track, timed bool) (domain.Lyrics, error) {
	provider, ok := s.deps.Catalog.(interface {
		TrackVersions(context.Context, string) ([]domain.Track, error)
	})
	if !ok {
		return domain.Lyrics{}, lyrics.ErrNotFound
	}
	versions, err := provider.TrackVersions(ctx, track.ID)
	if err != nil {
		return domain.Lyrics{}, err
	}
	video := false
	for _, version := range versions {
		if version.ID == track.ID && version.IsVideo {
			video = true
		}
	}
	if !video {
		return domain.Lyrics{}, lyrics.ErrNotFound
	}
	for _, song := range versions {
		if song.IsVideo || song.ID == track.ID || !song.Playable {
			continue
		}
		got, err := s.deps.Lyrics.Lyrics(ctx, song, timed)
		if err != nil {
			continue
		}
		if strings.TrimSpace(got.Plain) == "" {
			lines := make([]string, 0, len(got.Lines))
			for _, line := range got.Lines {
				lines = append(lines, line.Text)
			}
			got.Plain = strings.Join(lines, "\n")
		}
		got.TrackID = track.ID
		difference := track.DurationMs - song.DurationMs
		// Similar-length versions can share timings. Longer edits keep words
		// without seeking or highlighting against a different timeline.
		tolerance := max(int64(3000), min(int64(10000), song.DurationMs/20))
		if track.DurationMs <= 0 || song.DurationMs <= 0 || difference < -tolerance || difference > tolerance {
			got.Synced, got.Lines = false, nil
		}
		return got, nil
	}
	return domain.Lyrics{}, lyrics.ErrNotFound
}

func (s *Server) handleTrackVersions(w http.ResponseWriter, r *http.Request) {
	if !s.allowVideoRequest(w, r) {
		return
	}
	id := r.PathValue("id")
	if !videoIDPattern.MatchString(id) {
		http.Error(w, "invalid video id", http.StatusBadRequest)
		return
	}
	provider, ok := s.deps.Catalog.(interface {
		TrackVersions(context.Context, string) ([]domain.Track, error)
	})
	if !ok {
		s.write(w, http.StatusOK, []domain.Track{})
		return
	}
	tracks, err := provider.TrackVersions(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.write(w, http.StatusOK, nonNilTracks(tracks))
}

// Picture resolutions have their own bounded cache: they must never replace
// audio URLs or populate the offline audio cache under the same video id.
type videoFlight struct {
	done   chan struct{}
	stream domain.Stream
	err    error
}

func (s *Server) resolveVideo(ctx context.Context, id string, refresh bool) (domain.Stream, error) {
	s.videoMu.Lock()
	if entry, ok := s.videos[id]; ok && !refresh && entry.usable(time.Now()) {
		s.videoMu.Unlock()
		return entry.stream, nil
	}
	if flight := s.videoFlights[id]; flight != nil {
		s.videoMu.Unlock()
		select {
		case <-ctx.Done():
			return domain.Stream{}, ctx.Err()
		case <-flight.done:
			return flight.stream, flight.err
		}
	}
	if s.videoFlights == nil {
		s.videoFlights = map[string]*videoFlight{}
	}
	flight := &videoFlight{done: make(chan struct{})}
	s.videoFlights[id] = flight
	s.videoMu.Unlock()
	// Always settle the flight, even if the resolver panics, so requests
	// waiting on it are not left hanging.
	settled := false
	defer func() {
		if !settled {
			flight.err = errors.New("video resolution did not complete")
			s.settleVideo(id, flight)
		}
	}()
	provider, ok := s.deps.Resolver.(interface {
		ResolveVideo(context.Context, string) (domain.Stream, error)
	})
	if !ok {
		flight.err = errors.New("video playback is unavailable with this resolver")
	} else {
		// Other requests share this result, so one of them going away must
		// not cancel it for the rest. It still needs a bound of its own.
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
		defer cancel()
		flight.stream, flight.err = provider.ResolveVideo(rctx, id)
		if flight.err == nil && flight.stream.URL == "" {
			flight.err = errors.New("video resolution returned no stream")
		}
	}
	settled = true
	s.settleVideo(id, flight)
	return flight.stream, flight.err
}

// settleVideo publishes a finished flight: caches a success and wakes waiters.
func (s *Server) settleVideo(id string, flight *videoFlight) {
	s.videoMu.Lock()
	defer s.videoMu.Unlock()
	if flight.err == nil {
		if len(s.videos) >= 32 {
			for key := range s.videos {
				delete(s.videos, key)
				break
			}
		}
		s.videos[id] = resolvedEntry{stream: flight.stream, at: time.Now()}
	}
	delete(s.videoFlights, id)
	close(flight.done)
}

// ClientTokenHeader carries Deps.ClientToken on the desktop shell's requests.
const ClientTokenHeader = "X-Spotifier-Client"

// Browser pages outside the app must not be able to start local video jobs.
func (s *Server) allowVideoRequest(w http.ResponseWriter, r *http.Request) bool {
	if token := s.deps.ClientToken; token != "" {
		// The desktop shell adds the header at the network layer, so it
		// reaches <video> requests too; no web page can learn the value.
		if subtle.ConstantTimeCompare([]byte(r.Header.Get(ClientTokenHeader)), []byte(token)) == 1 {
			return true
		}
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return false
	}
	// Without a token (a core run by hand for development), fall back to
	// what the browser reports. "null" is never trusted: sandboxed and data:
	// frames on any site send it.
	origin := r.Header.Get("Origin")
	// Electron's file:// renderer omits Origin even for CORS requests.
	// Ordinary cross-site web CORS fetches include Origin; no-cors embeds
	// must still be rejected so arbitrary pages cannot start a video job.
	desktopCORS := origin == "" && r.Header.Get("Sec-Fetch-Mode") == "cors"
	if desktopCORS || (origin == "" && r.Header.Get("Sec-Fetch-Site") != "cross-site") {
		return true
	}
	if u, err := url.Parse(origin); err == nil && (u.Scheme == "http" || u.Scheme == "https") && (u.Host == r.Host || u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1") {
		return true
	}
	http.Error(w, "origin not allowed", http.StatusForbidden)
	return false
}

func (s *Server) handleVideoStream(w http.ResponseWriter, r *http.Request) {
	if !s.allowVideoRequest(w, r) {
		return
	}
	id := r.PathValue("id")
	if !videoIDPattern.MatchString(id) {
		http.Error(w, "invalid video id", http.StatusBadRequest)
		return
	}
	for attempt := 0; attempt < 2; attempt++ {
		st, err := s.resolveVideo(r.Context(), id, attempt > 0)
		if err != nil {
			status := http.StatusBadGateway
			if errors.Is(err, resolver.ErrRateLimited) {
				status = http.StatusTooManyRequests
			}
			http.Error(w, "Video could not be loaded. Audio playback is still available.", status)
			return
		}
		ctx, cancel := context.WithCancel(r.Context())
		resp, err := s.fetchUpstream(ctx, st.URL, boundedRange(r.Header.Get("Range"), st.SizeBytes))
		if err != nil {
			cancel()
			http.Error(w, "Video stream unavailable", http.StatusBadGateway)
			return
		}
		if (resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusGone) && attempt == 0 {
			resp.Body.Close()
			cancel()
			continue
		}
		for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"} {
			if v := resp.Header.Get(h); v != "" {
				w.Header().Set(h, v)
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, stallGuard(resp.Body, cancel))
		resp.Body.Close()
		cancel()
		return
	}
}
