package catalog_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"spotifier/internal/catalog"
	"spotifier/internal/innertube"
	"spotifier/internal/renderers"
)

type pagingTransport func(*http.Request) (*http.Response, error)

func (f pagingTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestPlaylistPageDoesNotFetchTheTail(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/fixtures/playlist.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := renderers.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	shelf := renderers.FindAll(doc, "musicPlaylistShelfRenderer")[0]
	row := shelf.List("contents")[0]
	more := map[string]any{"continuationItemRenderer": map[string]any{"continuationEndpoint": map[string]any{"continuationCommand": map[string]any{"token": "next"}}}}
	shelf["contents"] = append(shelf.List("contents"), more)
	first, _ := json.Marshal(doc)
	tail, _ := json.Marshal(map[string]any{"onResponseReceivedActions": []any{map[string]any{"appendContinuationItemsAction": map[string]any{"continuationItems": []any{row, row}}}}})
	calls := 0
	client := innertube.New(innertube.WithHTTPClient(&http.Client{Transport: pagingTransport(func(r *http.Request) (*http.Response, error) {
		body := []byte(`{"INNERTUBE_CLIENT_VERSION":"1.20260901.01.00","INNERTUBE_API_KEY":"test"}`)
		if r.Method == "POST" {
			calls++
			var request map[string]any
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Fatal(err)
			}
			if token, ok := request["continuation"]; ok {
				if token != "next" {
					t.Fatalf("unexpected token %v", token)
				}
				body = tail
			} else {
				body = first
			}
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
	})}))
	c := catalog.NewInnerTube(client, nil)
	page, err := c.PlaylistPage(context.Background(), "test", "")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || page.Next != "next" || len(page.Playlist.Tracks) == 0 || page.Playlist.DurationMs != 0 {
		t.Fatalf("first page: calls=%d next=%q count=%d duration=%d", calls, page.Next, len(page.Playlist.Tracks), page.Playlist.DurationMs)
	}
	next, err := c.PlaylistPage(context.Background(), "test", page.Next)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || next.Next != "" || len(next.Playlist.Tracks) != 2 {
		t.Fatalf("tail: calls=%d page=%+v", calls, next)
	}
	if next.Playlist.Tracks[0].ID != next.Playlist.Tracks[1].ID {
		t.Fatal("repeated playlist entries were lost")
	}
}
