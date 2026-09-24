package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"regexp"
	"time"

	"spotifier/internal/domain"
	"spotifier/internal/resolver"
)

var videoIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

func (s *Server) handleTrackVersions(w http.ResponseWriter, r *http.Request) {
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
func (s *Server) resolveVideo(ctx context.Context, id string, refresh bool) (domain.Stream, error) {
	s.videoMu.Lock()
	defer s.videoMu.Unlock()
	if entry, ok := s.videos[id]; ok && !refresh && entry.usable(time.Now()) {
		return entry.stream, nil
	}
	provider, ok := s.deps.Resolver.(interface {
		ResolveVideo(context.Context, string) (domain.Stream, error)
	})
	if !ok {
		return domain.Stream{}, errors.New("video playback is unavailable with this resolver")
	}
	st, err := provider.ResolveVideo(ctx, id)
	if err != nil {
		return domain.Stream{}, err
	}
	if len(s.videos) >= 32 {
		for key := range s.videos {
			delete(s.videos, key)
			break
		}
	}
	s.videos[id] = resolvedEntry{stream: st, at: time.Now()}
	return st, nil
}

func (s *Server) handleVideoStream(w http.ResponseWriter, r *http.Request) {
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
