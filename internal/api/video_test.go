package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"spotifier/internal/api"
	"spotifier/internal/catalog"
	"spotifier/internal/domain"
	"spotifier/internal/lyrics"
	"spotifier/internal/resolver"
	"testing"
	"time"
)

type videoResolver struct {
	url   string
	calls int
}

func (v *videoResolver) Name() string { return "video-test" }
func (v *videoResolver) Resolve(context.Context, string) (domain.Stream, resolver.Quality, error) {
	panic("video requested audio")
}
func (v *videoResolver) ResolveVideo(_ context.Context, id string) (domain.Stream, error) {
	v.calls++
	return domain.Stream{Kind: domain.StreamURL, VideoID: id, URL: v.url, SizeBytes: 100, ExpiresAt: time.Now().Add(time.Hour)}, nil
}
func TestVideoRelayRangesAndSeparateCache(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "bytes=10-99" {
			t.Errorf("unexpected range %q", r.Header.Get("Range"))
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", "bytes 10-99/100")
		w.WriteHeader(206)
		w.Write(make([]byte, 90))
	}))
	defer upstream.Close()
	resolver := &videoResolver{url: upstream.URL}
	srv := api.New(api.Deps{Resolver: resolver})
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest("GET", "/v1/video-stream/abcdefghijk", nil)
		req.Header.Set("Range", "bytes=10-")
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, req)
		body, _ := io.ReadAll(w.Result().Body)
		if w.Code != 206 || len(body) != 90 || w.Header().Get("Content-Type") != "video/mp4" {
			t.Fatalf("bad video response %d %d", w.Code, len(body))
		}
	}
	if resolver.calls != 1 {
		t.Fatalf("re-resolved each range: %d", resolver.calls)
	}
}

type versionCatalog struct {
	catalog.Catalog
	items []domain.Track
}

func (c versionCatalog) TrackVersions(context.Context, string) ([]domain.Track, error) {
	return c.items, nil
}

type songLyrics struct{ videoPlain bool }

func (songLyrics) Name() string { return "test" }
func (p songLyrics) Lyrics(_ context.Context, t domain.Track) (domain.Lyrics, error) {
	if t.ID != "song1234567" {
		if p.videoPlain {
			return domain.Lyrics{Source: "video", Plain: "Video words"}, nil
		}
		return domain.Lyrics{}, lyrics.ErrNotFound
	}
	return domain.Lyrics{Source: "test", Synced: true, Lines: []domain.LyricLine{{AtMs: 1000, Text: "Test line"}}}, nil
}
func TestVideoLyricsCounterpartTiming(t *testing.T) {
	for _, tc := range []struct {
		name     string
		duration int64
		video    bool
		status   int
		synced   bool
	}{
		{"similar", 122000, true, 200, true}, {"long edit", 145000, true, 200, false},
		{"unknown length", 0, true, 200, false}, {"unrelated song", 120000, false, 404, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := api.New(api.Deps{Catalog: versionCatalog{items: []domain.Track{
				{ID: "clip1234567", IsVideo: tc.video, DurationMs: tc.duration, Playable: true},
				{ID: "song1234567", DurationMs: 120000, Playable: true},
			}}, Lyrics: &lyrics.Service{Primary: songLyrics{}}})
			w := httptest.NewRecorder()
			srv.ServeHTTP(w, httptest.NewRequest("GET", fmt.Sprintf("/v1/tracks/clip1234567/lyrics?durationMs=%d&timed=1", tc.duration), nil))
			if w.Code != tc.status {
				t.Fatalf("status %d", w.Code)
			}
			if w.Code != 200 {
				return
			}
			var got domain.Lyrics
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got.Plain != "Test line" || got.TrackID != "clip1234567" || got.Synced != tc.synced {
				t.Fatalf("bad fallback: %+v", got)
			}
			if !tc.synced && len(got.Lines) > 0 {
				t.Fatal("different edit has seekable lyrics")
			}
		})
	}
}

func TestVideoPlainLyricsPreferSongTimings(t *testing.T) {
	srv := api.New(api.Deps{Catalog: versionCatalog{items: []domain.Track{
		{ID: "clip1234567", IsVideo: true, DurationMs: 196000, Playable: true},
		{ID: "song1234567", DurationMs: 190000, Playable: true},
	}}, Lyrics: &lyrics.Service{Primary: songLyrics{videoPlain: true}}})
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, httptest.NewRequest("GET", "/v1/tracks/clip1234567/lyrics?durationMs=196000&timed=1", nil))
	var got domain.Lyrics
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || !got.Synced || got.Source != "test" {
		t.Fatalf("did not prefer song timing: %d %+v", w.Code, got)
	}
}
