package identity

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"spotifier/internal/domain"
	"spotifier/internal/obs"
	"spotifier/internal/renderers"
)

// Fixture is an Identity served from recorded responses.
//
// Writes are recorded in memory rather than rejected, so the UI's optimistic
// paths and success states can be exercised offline. Nothing is persisted:
// this adapter exists for development and tests, not for use.
type Fixture struct {
	dir      string
	recorder *obs.Recorder

	mu     sync.Mutex
	cached map[string]renderers.Node
	Writes []string // append-only log of attempted writes, for assertions
}

func NewFixture(dir string, rec *obs.Recorder) *Fixture {
	return &Fixture{dir: dir, recorder: rec, cached: map[string]renderers.Node{}}
}

var _ Identity = (*Fixture)(nil)

func (f *Fixture) load(name string) (renderers.Node, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if doc, ok := f.cached[name]; ok {
		return doc, nil
	}
	b, err := os.ReadFile(filepath.Join(f.dir, name+".json"))
	if err != nil {
		// Personal fixtures are not committed, so a missing one is expected on
		// a fresh clone and must be said plainly.
		return nil, fmt.Errorf("identity fixture %q missing (run: go run ./cmd/record): %w", name, err)
	}
	doc, err := renderers.Parse(json.RawMessage(b))
	if err != nil {
		return nil, err
	}
	f.cached[name] = doc
	return doc, nil
}

func (f *Fixture) ctxFor(s string) renderers.ParseContext {
	return renderers.ParseContext{Surface: s, Recorder: f.recorder}
}

func (f *Fixture) LikedSongs(ctx context.Context) (domain.Playlist, error) {
	doc, err := f.load("liked")
	if err != nil {
		return domain.Playlist{}, err
	}
	pl, ok := renderers.ParsePlaylist(doc, SurfaceLikedSongs, f.ctxFor("liked"))
	if !ok {
		return domain.Playlist{}, fmt.Errorf("identity fixture: liked did not parse")
	}
	pl.ID = "LM"
	if pl.Title == "" {
		pl.Title = "Liked Music"
	}
	return pl, nil
}

func (f *Fixture) Playlists(ctx context.Context) ([]domain.LibraryItem, error) {
	return f.items("library_playlists", domain.LibPlaylist)
}
func (f *Fixture) Artists(ctx context.Context) ([]domain.LibraryItem, error) {
	return f.items("library_artists", domain.LibArtist)
}
func (f *Fixture) Albums(ctx context.Context) ([]domain.LibraryItem, error) {
	return f.items("library_albums", domain.LibAlbum)
}

func (f *Fixture) items(name string, kind domain.LibraryItemKind) ([]domain.LibraryItem, error) {
	doc, err := f.load(name)
	if err != nil {
		return nil, err
	}
	return LibraryItemsFrom(doc, kind, f.ctxFor(name)), nil
}

func (f *Fixture) History(ctx context.Context) ([]domain.Track, error) {
	doc, err := f.load("history")
	if err != nil {
		return nil, err
	}
	var out []domain.Track
	for _, n := range renderers.FindAll(doc, renderers.NodeListItem) {
		if tr, ok := renderers.ParseTrack(n); ok {
			out = append(out, tr)
		}
	}
	return out, nil
}

func (f *Fixture) record(format string, args ...any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Writes = append(f.Writes, fmt.Sprintf(format, args...))
	return nil
}

// Follow is accepted and discarded, like every other write here: a fixture
// records responses and has no account to change.
func (f *Fixture) Follow(context.Context, string, bool) error { return nil }

func (f *Fixture) Rate(ctx context.Context, trackID string, r Rating) error {
	return f.record("rate %s %s", trackID, r)
}
func (f *Fixture) ToggleLibrary(ctx context.Context, token string) error {
	return f.record("toggleLibrary %.12s", token)
}
func (f *Fixture) CreatePlaylist(ctx context.Context, title, desc string, public bool) (string, error) {
	_ = f.record("createPlaylist %q public=%v", title, public)
	return "PLfixture000000000000", nil
}
func (f *Fixture) DeletePlaylist(ctx context.Context, id string) error {
	return f.record("deletePlaylist %s", id)
}
func (f *Fixture) AddToPlaylist(ctx context.Context, id string, trackIDs []string) error {
	return f.record("addToPlaylist %s +%d", id, len(trackIDs))
}
func (f *Fixture) RemoveFromPlaylist(ctx context.Context, id string, items []PlaylistItemRef) error {
	return f.record("removeFromPlaylist %s -%d", id, len(items))
}
