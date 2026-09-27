package catalog_test

import (
	"context"
	"encoding/json"
	"errors"
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

// servePage answers every InnerTube call with page, and the config scrape
// with a usable client version, as a signed-in client.
func servePage(page []byte) *innertube.Client {
	return serveAs(page, nil, &innertube.Credentials{Cookie: "SAPISID=test; LOGIN_INFO=test"})
}

// serveAs is servePage with the given credentials (nil: signed out). posts,
// when set, counts the InnerTube calls made.
func serveAs(page []byte, posts *int, creds *innertube.Credentials) *innertube.Client {
	opts := []innertube.Option{innertube.WithHTTPClient(&http.Client{Transport: pagingTransport(func(r *http.Request) (*http.Response, error) {
		body := []byte(`{"INNERTUBE_CLIENT_VERSION":"1.20260901.01.00","INNERTUBE_API_KEY":"test"}`)
		if r.Method == "POST" {
			if posts != nil {
				*posts++
			}
			body = page
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
	})})}
	if creds != nil {
		opts = append(opts, innertube.WithCredentials(creds))
	}
	return innertube.New(opts...)
}

// The Liked Music page reads without its header, as the library's summary
// does, and a page with neither header nor tracks is the throttle shape.
func TestLikedMusicPageUsesTheLikedParse(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/fixtures/playlist.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, h := range renderers.FindAll(doc, "sectionListRenderer") {
		contents := h.List("contents")
		kept := contents[:0]
		for _, c := range contents {
			if m, ok := c.(map[string]any); ok && m["musicResponsiveHeaderRenderer"] != nil {
				continue
			}
			kept = append(kept, c)
		}
		h["contents"] = kept
	}
	headerless, _ := json.Marshal(doc)
	if strings.Contains(string(headerless), "musicResponsiveHeaderRenderer") {
		t.Skip("fixture keeps its header elsewhere; covered by the renderers tests")
	}

	page, err := catalog.NewInnerTube(servePage(headerless), nil).PlaylistPage(context.Background(), "LM", "")
	if err != nil {
		t.Fatal(err)
	}
	if page.Playlist.Title != renderers.LikedTitle || len(page.Playlist.Tracks) == 0 {
		t.Fatalf("got title=%q tracks=%d", page.Playlist.Title, len(page.Playlist.Tracks))
	}

	_, err = catalog.NewInnerTube(servePage([]byte(`{"contents":{}}`)), nil).Playlist(context.Background(), "LM")
	if !errors.Is(err, renderers.ErrLikedShape) {
		t.Fatalf("err = %v, want ErrLikedShape", err)
	}
	// Any other playlist keeps the plain parse and its own error.
	_, err = catalog.NewInnerTube(servePage([]byte(`{"contents":{}}`)), nil).Playlist(context.Background(), "PLother")
	if err == nil || errors.Is(err, renderers.ErrLikedShape) {
		t.Fatalf("other playlist err = %v", err)
	}
}

// Signed out, Liked Music is not asked for at all: the answer is to sign in.
func TestLikedMusicSignedOutAsksForSignIn(t *testing.T) {
	posts := 0
	c := catalog.NewInnerTube(serveAs([]byte(`{"contents":{}}`), &posts, nil), nil)
	if _, err := c.Playlist(context.Background(), "LM"); !errors.Is(err, renderers.ErrLikedSignedOut) {
		t.Fatalf("Playlist err = %v, want ErrLikedSignedOut", err)
	}
	if _, err := c.PlaylistPage(context.Background(), "VLLM", ""); !errors.Is(err, renderers.ErrLikedSignedOut) {
		t.Fatalf("PlaylistPage err = %v, want ErrLikedSignedOut", err)
	}
	if posts != 0 {
		t.Fatalf("made %d InnerTube calls while signed out", posts)
	}
}
