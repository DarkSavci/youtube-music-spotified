package identity

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"spotifier/internal/innertube"
	"spotifier/internal/renderers"
)

type likedTransport func(*http.Request) (*http.Response, error)

func (f likedTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// likedPages serves Liked Music as the given pages of video ids, the first
// from a browse and the rest from continuations, and counts the calls.
func likedPages(t *testing.T, pages ...[]string) (*InnerTube, *int) {
	t.Helper()
	doc := playlistDoc(t)
	shelf := renderers.FindAll(doc, "musicPlaylistShelfRenderer")[0]
	proto := shelf.List("contents")[0]
	inner := renderers.Node(proto.(map[string]any)).Child(renderers.NodeListItem)
	protoTrack, ok := renderers.ParseTrack(inner)
	if !ok || protoTrack.ID == "" {
		t.Fatal("fixture row did not parse")
	}
	protoJSON, _ := json.Marshal(proto)
	row := func(id string) any {
		var out any
		_ = json.Unmarshal([]byte(strings.ReplaceAll(string(protoJSON), protoTrack.ID, id)), &out)
		return out
	}
	more := func(tok string) any {
		return map[string]any{"continuationItemRenderer": map[string]any{"continuationEndpoint": map[string]any{"continuationCommand": map[string]any{"token": tok}}}}
	}
	rows := func(n int) []any {
		var out []any
		for _, id := range pages[n] {
			out = append(out, row(id))
		}
		if n+1 < len(pages) {
			out = append(out, more("p"+string(rune('0'+n+1))))
		}
		return out
	}
	shelf["contents"] = rows(0)
	first, _ := json.Marshal(doc)

	var mu sync.Mutex
	calls := 0
	client := innertube.New(
		innertube.WithCredentials(&innertube.Credentials{Cookie: "SAPISID=x; __Secure-3PAPISID=x; LOGIN_INFO=y"}),
		innertube.WithHTTPClient(&http.Client{Transport: likedTransport(func(r *http.Request) (*http.Response, error) {
			body := []byte(`{"INNERTUBE_CLIENT_VERSION":"1.20260901.01.00","INNERTUBE_API_KEY":"test"}`)
			if r.Method == http.MethodPost {
				mu.Lock()
				calls++
				mu.Unlock()
				// A browse continuation travels in the URL, as the web client's does.
				if tok := r.URL.Query().Get("ctoken"); tok != "" {
					n := int(tok[1] - '0')
					body, _ = json.Marshal(map[string]any{"onResponseReceivedActions": []any{map[string]any{
						"appendContinuationItemsAction": map[string]any{"continuationItems": rows(n)}}}})
				} else {
					body = first
				}
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
		})}),
	)
	return NewInnerTube(client, nil), &calls
}

func knownOf(ids ...string) func(string) bool {
	set := map[string]bool{}
	for _, id := range ids {
		set[id] = true
	}
	return func(id string) bool { return set[id] }
}

// A run of known songs that starts on one page and ends on the next stops the
// read there; a known song liked again sits among the new ones at the top.
func TestLikedSongsSinceStopsAtARunOfKnownSongsAcrossPages(t *testing.T) {
	it, calls := likedPages(t,
		[]string{"new00000001", "old0000000a", "new00000002", "old0000000b", "old0000000c"},
		[]string{"old0000000d", "old0000000e", "old0000000f", "old0000000g"},
		[]string{"old0000000h"}, // never needed
	)
	known := knownOf("old0000000a", "old0000000b", "old0000000c", "old0000000d", "old0000000e", "old0000000f", "old0000000g", "old0000000h")
	pl, reached, err := it.LikedSongsSince(context.Background(), known)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, tr := range pl.Tracks {
		got = append(got, tr.ID)
	}
	want := "new00000001,old0000000a,new00000002"
	if !reached || strings.Join(got, ",") != want {
		t.Fatalf("got %v reached=%v, want %s and the run found", got, reached, want)
	}
	if *calls != 2 {
		t.Fatalf("%d calls, want the browse and one continuation", *calls)
	}
}

// With no run of known songs the read goes to the end: the whole list.
func TestLikedSongsSinceReadsToTheEndWithoutARun(t *testing.T) {
	it, calls := likedPages(t,
		[]string{"new00000001", "old0000000a"},
		[]string{"new00000002"},
	)
	pl, reached, err := it.LikedSongsSince(context.Background(), knownOf("old0000000a"))
	if err != nil {
		t.Fatal(err)
	}
	if reached || len(pl.Tracks) != 3 || *calls != 2 {
		t.Fatalf("got %d tracks reached=%v after %d calls", len(pl.Tracks), reached, *calls)
	}
}
