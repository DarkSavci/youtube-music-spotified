// Command record captures real InnerTube responses into testdata/fixtures.
//
// These fixtures are the contract that lets the UI and the backend be built in
// parallel, and the regression harness for renderer-node changes. Recording is
// a deliberate, occasional act — fixtures are committed and reviewed, not
// refreshed automatically, because a silent refresh would hide exactly the
// shape changes they exist to catch.
//
//	go run ./cmd/record                 # the standard set
//	go run ./cmd/record -only home      # one surface
//	go run ./cmd/record -list           # what would be recorded
//
// Credentials are scrubbed as responses are written, never in a later pass.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"spotifier/internal/innertube"
	"spotifier/internal/renderers"
)

type surface struct {
	name     string
	endpoint string
	body     map[string]any
	// needsAuth marks surfaces that only return content when signed in.
	needsAuth bool
	// note explains why this surface is in the set, especially for the
	// awkward cases that exist to stress the parsers.
	note string
}

func main() {
	var (
		outDir = flag.String("out", "testdata/fixtures", "output directory")
		only   = flag.String("only", "", "record only this surface")
		list   = flag.Bool("list", false, "list surfaces and exit")
		creds  = flag.String("credentials", "credentials.json", "path to credentials")
	)
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	c, authed := buildClient(*creds)
	if authed {
		fmt.Println("recording SIGNED IN")
	} else {
		fmt.Println("recording SIGNED OUT — library surfaces will be skipped")
	}

	surfaces, err := buildSurfaces(ctx, c, authed)
	if err != nil {
		fatal("discover surfaces: %v", err)
	}
	if *list {
		for _, s := range surfaces {
			fmt.Printf("  %-28s %-12s %s\n", s.name, s.endpoint, s.note)
		}
		return
	}
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fatal("mkdir: %v", err)
	}

	var recorded, skipped, failed int
	for _, s := range surfaces {
		if *only != "" && s.name != *only {
			continue
		}
		if s.needsAuth && !authed {
			fmt.Printf("  %-28s SKIP (needs auth)\n", s.name)
			skipped++
			continue
		}
		raw, err := c.Call(ctx, s.endpoint, s.body)
		if err != nil {
			fmt.Printf("  %-28s FAIL %v\n", s.name, err)
			failed++
			continue
		}
		clean := scrub(raw)
		path := filepath.Join(*outDir, s.name+".json")
		if err := os.WriteFile(path, clean, 0o644); err != nil {
			fatal("write %s: %v", path, err)
		}
		types := renderers.RendererTypes(mustDecode(clean))
		fmt.Printf("  %-28s %7d bytes  %2d node types  %s\n",
			s.name, len(clean), len(types), s.note)
		recorded++
	}
	fmt.Printf("\nrecorded %d, skipped %d, failed %d -> %s\n", recorded, skipped, failed, *outDir)
}

func buildClient(credPath string) (*innertube.Client, bool) {
	creds, err := innertube.LoadCredentials(credPath)
	if err != nil {
		return innertube.New(innertube.WithLocale("en", "US")), false
	}
	c := innertube.New(
		innertube.WithCredentials(creds),
		innertube.WithLocale("en", "US"),
	)
	return c, c.Authenticated()
}

// buildSurfaces assembles the recording set, discovering real entity IDs by
// search so the set is reproducible rather than depending on hardcoded IDs
// that rot.
func buildSurfaces(ctx context.Context, c *innertube.Client, authed bool) ([]surface, error) {
	out := []surface{
		{name: "home", endpoint: "browse", body: id("FEmusic_home"), note: "shelves, quick picks"},
		{name: "explore", endpoint: "browse", body: id("FEmusic_explore"), note: "explore landing"},
		{name: "charts", endpoint: "browse", body: id("FEmusic_charts"), note: "charts by region"},
		{name: "new_releases", endpoint: "browse", body: id("FEmusic_new_releases"), note: "new releases"},
		{name: "moods", endpoint: "browse", body: id("FEmusic_moods_and_genres"), note: "mood/genre grid"},

		{name: "search_all", endpoint: "search", body: q("daft punk"), note: "unfiltered: top result card"},
		{name: "search_songs", endpoint: "search", body: qf("daft punk", filterSongs), note: "songs filter"},
		{name: "search_albums", endpoint: "search", body: qf("daft punk", filterAlbums), note: "albums filter"},
		{name: "search_artists", endpoint: "search", body: qf("daft punk", filterArtists), note: "artists filter"},
		{name: "search_playlists", endpoint: "search", body: qf("daft punk", filterPlaylists), note: "playlists filter"},
		{name: "search_videos", endpoint: "search", body: qf("daft punk", filterVideos), note: "videos filter"},

		// Awkward cases. These exist to stress parsers and to give M3 something
		// to render when data is missing, which is when Spotify-shaped layouts
		// break.
		{name: "search_empty", endpoint: "search",
			body: q("zzzzqqqxxyy nonexistent query 12345"), note: "AWKWARD: zero results"},
		{name: "search_unicode", endpoint: "search",
			body: q("björk vespertine"), note: "AWKWARD: non-ascii"},
		{name: "suggestions", endpoint: "music/get_search_suggestions",
			body: map[string]any{"input": "daf"}, note: "autocomplete"},
	}

	// Discover real entity IDs from a search, rather than hardcoding.
	raw, err := c.Call(ctx, "search", q("daft punk discovery"))
	if err != nil {
		return nil, err
	}
	doc := mustDecode(raw)

	if vid := firstVideoID(doc); vid != "" {
		out = append(out,
			surface{name: "next", endpoint: "next",
				body: map[string]any{"videoId": vid}, note: "watch queue + lyrics id"},
			surface{name: "player", endpoint: "player",
				body:      map[string]any{"videoId": vid, "contentCheckOk": true, "racyCheckOk": true},
				needsAuth: true, note: "streaming formats (Premium tiers)"},
		)
	}
	if aid := firstBrowseIDWithPrefix(doc, "MPREb_"); aid != "" {
		out = append(out, surface{name: "album", endpoint: "browse",
			body: id(aid), note: "album detail"})
	}
	if cid := firstBrowseIDWithPrefix(doc, "UC"); cid != "" {
		out = append(out, surface{name: "artist", endpoint: "browse",
			body: id(cid), note: "artist detail"})
	}
	// Playlist browse endpoints do not appear in unfiltered search results, so
	// discover them from a playlists-filtered search instead.
	if praw, err := c.Call(ctx, "search", qf("daft punk", filterPlaylists)); err == nil {
		if pid := firstBrowseIDWithPrefix(mustDecode(praw), "VL"); pid != "" {
			out = append(out, surface{name: "playlist", endpoint: "browse",
				body: id(pid), note: "playlist detail"})
		}
	}

	// Signed-in surfaces.
	out = append(out,
		surface{name: "liked", endpoint: "browse", body: id("VLLM"),
			needsAuth: true, note: "Liked Music"},
		surface{name: "library_playlists", endpoint: "browse", body: id("FEmusic_liked_playlists"),
			needsAuth: true, note: "library: saved playlists"},
		surface{name: "library_artists", endpoint: "browse", body: id("FEmusic_library_corpus_track_artists"),
			needsAuth: true, note: "library: artists"},
		surface{name: "library_albums", endpoint: "browse", body: id("FEmusic_liked_albums"),
			needsAuth: true, note: "library: albums"},
		surface{name: "history", endpoint: "browse", body: id("FEmusic_history"),
			needsAuth: true, note: "recently played"},
		surface{name: "account", endpoint: "account/account_menu", body: map[string]any{},
			needsAuth: true, note: "canary shape"},
	)
	return out, nil
}

// Search filter params, as the web client sends them.
const (
	filterSongs     = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D"
	filterVideos    = "EgWKAQIQAWoKEAkQBRAKEAMQBA%3D%3D"
	filterAlbums    = "EgWKAQIYAWoKEAkQBRAKEAMQBA%3D%3D"
	filterArtists   = "EgWKAQIgAWoKEAkQBRAKEAMQBA%3D%3D"
	filterPlaylists = "EgWKAQIoAWoKEAkQBRAKEAMQBA%3D%3D"
)

func id(browseID string) map[string]any { return map[string]any{"browseId": browseID} }
func q(query string) map[string]any     { return map[string]any{"query": query} }
func qf(query, params string) map[string]any {
	return map[string]any{"query": query, "params": params}
}

func firstVideoID(doc any) string {
	for _, n := range renderers.FindAll(doc, "watchEndpoint") {
		if vid := n.Str("videoId"); vid != "" {
			return vid
		}
	}
	return ""
}

func firstBrowseIDWithPrefix(doc any, prefix string) string {
	for _, n := range renderers.FindAll(doc, "browseEndpoint") {
		if bid := n.Str("browseId"); strings.HasPrefix(bid, prefix) {
			return bid
		}
	}
	return ""
}

// ---------- scrubbing ----------

// Keys whose values identify a session or a request rather than the content.
// Removed entirely: they are noise for parsing and are session-bound.
var scrubKeys = map[string]bool{
	"trackingParams":        true,
	"clickTrackingParams":   true,
	"visitorData":           true,
	"sessionId":             true,
	"xsrfToken":             true,
	"datasyncId":            true,
	"loggingContext":        true,
	"serializedShareEntity": true,
}

var reLongToken = regexp.MustCompile(`^[A-Za-z0-9_\-=]{120,}$`)

// scrub removes session-identifying values before a fixture is written.
//
// Done during the write, never as a cleanup pass, so a fixture cannot be
// committed in an unscrubbed state.
func scrub(raw json.RawMessage) []byte {
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return raw
	}
	cleaned := walk(doc)
	out, err := json.MarshalIndent(cleaned, "", "  ")
	if err != nil {
		return raw
	}
	return append(out, '\n')
}

func walk(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys) // stable output so fixture diffs are readable
		for _, k := range keys {
			if scrubKeys[k] {
				continue
			}
			out[k] = walk(t[k])
		}
		return out
	case []any:
		out := make([]any, 0, len(t))
		for _, sub := range t {
			out = append(out, walk(sub))
		}
		return out
	case string:
		if reLongToken.MatchString(t) {
			return "<scrubbed>"
		}
		return t
	}
	return v
}

func mustDecode(raw []byte) any {
	var doc any
	json.Unmarshal(raw, &doc)
	return doc
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "record: "+format+"\n", args...)
	os.Exit(1)
}
