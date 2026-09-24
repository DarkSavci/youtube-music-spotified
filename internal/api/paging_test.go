package api_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"spotifier/internal/api"
	"spotifier/internal/domain"
	"testing"
)

type pagedCatalog struct {
	emptyCatalog
	calls []string
}

func (c *pagedCatalog) Playlist(context.Context, string) (domain.Playlist, error) {
	panic("paged request used complete playlist")
}
func (c *pagedCatalog) PlaylistPage(_ context.Context, id, token string) (domain.PlaylistPage, error) {
	c.calls = append(c.calls, id+":"+token)
	return domain.PlaylistPage{Playlist: domain.Playlist{ID: id}, Next: "next"}, nil
}
func TestPlaylistPagingRoute(t *testing.T) {
	c := &pagedCatalog{}
	s := api.New(api.Deps{Catalog: c})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/v1/playlists/LM?paged=1&continuation=a%2Bb", nil))
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var page domain.PlaylistPage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(c.calls) != 1 || c.calls[0] != "LM:a+b" || page.Next != "next" || len(page.Playlist.Tracks) != 0 {
		t.Fatalf("bad page or requests: %+v %v", page, c.calls)
	}
}
