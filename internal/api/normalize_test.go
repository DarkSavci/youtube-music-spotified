package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"spotifier/internal/api"
	"spotifier/internal/domain"
	"spotifier/internal/obs"
)

// emptyCatalog answers every call successfully with nothing in it — the exact
// shape that produced null lists.
type emptyCatalog struct{}

func (emptyCatalog) Home(context.Context) (domain.BrowsePage, error) {
	return domain.BrowsePage{Title: "Home"}, nil
}
func (emptyCatalog) Browse(context.Context, string) (domain.BrowsePage, error) {
	return domain.BrowsePage{Title: "Browse"}, nil
}
func (emptyCatalog) Search(context.Context, string, domain.SearchFilter) (domain.SearchResults, error) {
	return domain.SearchResults{Query: "q"}, nil
}
func (emptyCatalog) Suggest(context.Context, string) ([]string, error) { return nil, nil }
func (emptyCatalog) Album(context.Context, string) (domain.Album, error) {
	return domain.Album{ID: "a"}, nil
}
func (emptyCatalog) Artist(context.Context, string) (domain.Artist, error) {
	return domain.Artist{ID: "r"}, nil
}
func (emptyCatalog) Playlist(context.Context, string) (domain.Playlist, error) {
	return domain.Playlist{ID: "p"}, nil
}
func (emptyCatalog) Radio(context.Context, string) ([]domain.Track, error) { return nil, nil }
func (emptyCatalog) RadioPage(context.Context, string, string) ([]domain.Track, string, error) {
	return nil, "", nil
}
func (emptyCatalog) Podcast(context.Context, string) (domain.Podcast, error) {
	return domain.Podcast{ID: "s"}, nil
}

/*
A null list is not a harmless encoding detail.

The client maps over these fields, so one null unmounts the React tree. The
symptoms are nowhere near the cause: an empty library sidebar, missing filter
chips and a settings page that will not open, all from a browse response with
no shelves in it.
*/
func TestCatalogResponsesNeverContainNullLists(t *testing.T) {
	srv := httptest.NewServer(api.New(api.Deps{
		Catalog:  emptyCatalog{},
		Recorder: obs.NewRecorder(),
	}))
	defer srv.Close()

	// Every list field the client maps over, by the path it appears at.
	paths := []struct {
		url   string
		lists []string
	}{
		{"/v1/home", []string{"shelves", "moods"}},
		{"/v1/browse/FEmusic_home", []string{"shelves", "moods"}},
		{"/v1/search?q=test", []string{"shelves"}},
		{"/v1/albums/a", []string{"tracks", "artists"}},
		{"/v1/artists/r", []string{"topTracks", "albums", "singles", "related"}},
		{"/v1/playlists/p", []string{"tracks"}},
		{"/v1/podcasts/s", []string{"episodes"}},
	}

	for _, tc := range paths {
		t.Run(tc.url, func(t *testing.T) {
			resp, err := http.Get(srv.URL + tc.url)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			raw, _ := io.ReadAll(resp.Body)

			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status %d: %s", resp.StatusCode, raw)
			}
			if bytes.Contains(raw, []byte(":null")) {
				t.Fatalf("response carries a null list, which crashes the client: %s", raw)
			}

			var body map[string]json.RawMessage
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatal(err)
			}
			for _, field := range tc.lists {
				v, ok := body[field]
				if !ok {
					// Omitted is fine: the client checks before mapping. Null
					// is not, and that is what the scan above catches.
					continue
				}
				if string(v) == "null" {
					t.Fatalf("%q is null; the client maps over it unguarded", field)
				}
			}
		})
	}
}
