package api

import (
	"context"
	"errors"
	"io"
	"net/http"
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
