package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"spotifier/internal/domain"
	"spotifier/internal/obs"
	"spotifier/internal/renderers"
)

// Fixture is a Catalog served from recorded responses on disk.
//
// It is not only a test double. It is the adapter the UI develops against for
// the whole of M3, so the client and the backend can proceed in parallel, and
// it doubles as the regression harness for renderer-node changes
// (one Catalog seam, two adapters).
//
// Entity lookups ignore the requested identifier and serve the single recorded
// example, because there is exactly one album fixture and one artist fixture.
// That is sufficient — M3 needs a page that renders, not a catalog.
type Fixture struct {
	dir      string
	recorder *obs.Recorder

	mu     sync.RWMutex
	cached map[string]renderers.Node
}

// NewFixture builds a Catalog over a fixture directory.
func NewFixture(dir string, rec *obs.Recorder) *Fixture {
	return &Fixture{dir: dir, recorder: rec, cached: map[string]renderers.Node{}}
}

var _ Catalog = (*Fixture)(nil)

// Available reports which fixtures are present, so startup can fail loudly
// rather than serving empty screens.
func (f *Fixture) Available() ([]string, error) {
	entries, err := os.ReadDir(f.dir)
	if err != nil {
		return nil, fmt.Errorf("fixture dir: %w", err)
	}
	var out []string
	for _, e := range entries {
		if name, ok := strings.CutSuffix(e.Name(), ".json"); ok {
			out = append(out, name)
		}
	}
	return out, nil
}

func (f *Fixture) load(name string) (renderers.Node, error) {
	f.mu.RLock()
	doc, ok := f.cached[name]
	f.mu.RUnlock()
	if ok {
		return doc, nil
	}

	b, err := os.ReadFile(filepath.Join(f.dir, name+".json"))
	if err != nil {
		return nil, fmt.Errorf("fixture %q: %w", name, err)
	}
	doc, err = renderers.Parse(json.RawMessage(b))
	if err != nil {
		return nil, fmt.Errorf("fixture %q: %w", name, err)
	}

	f.mu.Lock()
	f.cached[name] = doc
	f.mu.Unlock()
	return doc, nil
}

func (f *Fixture) ctxFor(surface string) renderers.ParseContext {
	return renderers.ParseContext{Surface: surface, Recorder: f.recorder}
}

func (f *Fixture) Home(ctx context.Context) (domain.BrowsePage, error) {
	return f.browseFixture("home", SurfaceHome)
}

// surfaceFixtures maps surface identifiers onto recorded files.
var surfaceFixtures = map[string]string{
	SurfaceHome:        "home",
	SurfaceExplore:     "explore",
	SurfaceCharts:      "charts",
	SurfaceNewReleases: "new_releases",
	SurfaceMoods:       "moods",
}

// Browse ignores params: fixtures are recorded per surface, not per tile.
func (f *Fixture) Browse(ctx context.Context, surfaceID, _ string) (domain.BrowsePage, error) {
	name, ok := surfaceFixtures[surfaceID]
	if !ok {
		// An unrecorded surface is a gap in the fixture set, not a crash. Say
		// so plainly so it gets recorded rather than worked around.
		return domain.BrowsePage{}, fmt.Errorf("fixture: no recording for surface %q", surfaceID)
	}
	return f.browseFixture(name, surfaceID)
}

func (f *Fixture) browseFixture(name, surfaceID string) (domain.BrowsePage, error) {
	doc, err := f.load(name)
	if err != nil {
		return domain.BrowsePage{}, err
	}
	return renderers.ParseBrowsePage(doc, f.ctxFor(surfaceID)), nil
}

// filterFixtures maps a search filter onto its recorded file.
var filterFixtures = map[domain.SearchFilter]string{
	domain.FilterNone:      "search_all",
	domain.FilterSongs:     "search_songs",
	domain.FilterVideos:    "search_videos",
	domain.FilterAlbums:    "search_albums",
	domain.FilterArtists:   "search_artists",
	domain.FilterPlaylists: "search_playlists",
}

func (f *Fixture) Search(ctx context.Context, query string, filter domain.SearchFilter) (domain.SearchResults, error) {
	// A query that looks deliberately empty serves the recorded zero-result
	// response, so the UI's empty state can be exercised without a network.
	name := filterFixtures[filter]
	if strings.Contains(strings.ToLower(query), "nonexistent") {
		name = "search_empty"
	}
	if name == "" {
		name = "search_all"
	}
	doc, err := f.load(name)
	if err != nil {
		return domain.SearchResults{Query: query}, err
	}
	res := renderers.ParseSearch(doc, query, f.ctxFor(name))
	res.Query = query
	return res, nil
}

func (f *Fixture) Suggest(ctx context.Context, prefix string) ([]string, error) {
	doc, err := f.load("suggestions")
	if err != nil {
		return nil, err
	}
	var out []string
	seen := map[string]bool{}
	for _, n := range renderers.FindAll(doc, "searchSuggestionRenderer") {
		s := strings.TrimSpace(n.Text("suggestion"))
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out, nil
}

func (f *Fixture) Album(ctx context.Context, id string) (domain.Album, error) {
	doc, err := f.load("album")
	if err != nil {
		return domain.Album{}, err
	}
	al, ok := renderers.ParseAlbum(doc, id, f.ctxFor("album"))
	if !ok {
		return domain.Album{ID: id}, fmt.Errorf("fixture: album did not parse")
	}
	return al, nil
}

func (f *Fixture) Artist(ctx context.Context, id string) (domain.Artist, error) {
	doc, err := f.load("artist")
	if err != nil {
		return domain.Artist{}, err
	}
	ar, ok := renderers.ParseArtist(doc, id, f.ctxFor("artist"))
	if !ok {
		return domain.Artist{ID: id}, fmt.Errorf("fixture: artist did not parse")
	}
	return ar, nil
}

func (f *Fixture) Playlist(ctx context.Context, id string) (domain.Playlist, error) {
	doc, err := f.load("playlist")
	if err != nil {
		return domain.Playlist{}, err
	}
	pl, ok := renderers.ParsePlaylist(doc, id, f.ctxFor("playlist"))
	if !ok {
		return domain.Playlist{ID: id}, fmt.Errorf("fixture: playlist did not parse")
	}
	return pl, nil
}

// Radio serves the recorded watch queue, so mix generation can be exercised
// without a network.
func (f *Fixture) Radio(ctx context.Context, seedTrackID string) ([]domain.Track, error) {
	doc, err := f.load("next")
	if err != nil {
		return nil, err
	}
	tracks, _ := renderers.ParseWatchQueue(doc)
	return tracks, nil
}

// RadioPage serves the recorded queue as a single page with no more after.
func (f *Fixture) RadioPage(ctx context.Context, seedTrackID, token string) ([]domain.Track, string, error) {
	if token != "" {
		return nil, "", nil
	}
	tracks, err := f.Radio(ctx, seedTrackID)
	return tracks, "", err
}

/*
Podcast serves a recorded show.

There is no podcast fixture yet, and an adapter that invents one would let a
broken parser pass. Reporting that the recording is missing is the honest
answer, and `cmd/record` is how it gets added.
*/
func (f *Fixture) Podcast(ctx context.Context, id string) (domain.Podcast, error) {
	doc, err := f.load("podcast")
	if err != nil {
		return domain.Podcast{}, err
	}
	pod, ok := renderers.ParsePodcastPage(doc, id, f.ctxFor("podcast"))
	if !ok {
		return domain.Podcast{ID: id}, fmt.Errorf("fixture: podcast did not parse")
	}
	return pod, nil
}
