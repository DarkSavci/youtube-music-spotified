package api_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"spotifier/internal/api"
	"spotifier/internal/domain"
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
