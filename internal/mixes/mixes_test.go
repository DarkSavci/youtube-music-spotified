package mixes_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"spotifier/internal/control"
	"spotifier/internal/domain"
	"spotifier/internal/mixes"
)

// stubCatalog returns predictable radio, so mix assembly is what is under test
// rather than YouTube's recommendations.
type stubCatalog struct {
	byseed map[string][]domain.Track
	calls  int
}

func (s *stubCatalog) Podcast(context.Context, string) (domain.Podcast, error) {
	return domain.Podcast{}, nil
}

func (s *stubCatalog) Radio(_ context.Context, seed string) ([]domain.Track, error) {
	s.calls++
	return s.byseed[seed], nil
}

func (s *stubCatalog) RadioPage(ctx context.Context, seed, _ string) ([]domain.Track, string, error) {
	t, err := s.Radio(ctx, seed)
	return t, "", err
}
func (s *stubCatalog) Home(context.Context) (domain.BrowsePage, error) {
	return domain.BrowsePage{}, nil
}
func (s *stubCatalog) Browse(context.Context, string) (domain.BrowsePage, error) {
	return domain.BrowsePage{}, nil
}
func (s *stubCatalog) Search(context.Context, string, domain.SearchFilter) (domain.SearchResults, error) {
	return domain.SearchResults{}, nil
}
func (s *stubCatalog) Suggest(context.Context, string) ([]string, error) { return nil, nil }
func (s *stubCatalog) Album(context.Context, string) (domain.Album, error) {
	return domain.Album{}, nil
}
func (s *stubCatalog) Artist(context.Context, string) (domain.Artist, error) {
	return domain.Artist{}, nil
}
func (s *stubCatalog) Playlist(context.Context, string) (domain.Playlist, error) {
	return domain.Playlist{}, nil
}

func track(id, title, artist string) domain.Track {
	return domain.Track{ID: id, Title: title, Artists: []domain.ArtistRef{{Name: artist}}, Playable: true}
}

func openStore(t *testing.T) *control.Store {
	t.Helper()
	s, err := control.Open(context.Background(), filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// Seeds a history of n artists, each with one played track.
func seedHistory(t *testing.T, s *control.Store, artists []string) {
	t.Helper()
	var plays []control.Play
	for i, a := range artists {
		id := string(rune('a' + i))
		plays = append(plays, control.Play{
			EventUUID: "e" + id, TrackID: "t" + id, Title: "Track " + id,
			Artist: a, ArtistID: "UC" + id, PlayedMs: 200_000,
			PlayedAt: time.Now().UTC().Add(-time.Duration(i+1) * time.Hour),
		})
	}
	if err := s.RecordPlays(context.Background(), control.DefaultUserID, plays); err != nil {
		t.Fatal(err)
	}
}

// With almost no history, seeded mixes must be withheld. Two artists' radio
// dressed up as three "Daily Mixes" looks broken rather than empty.
func TestThinHistoryWithholdsSeededMixes(t *testing.T) {
	store := openStore(t)
	seedHistory(t, store, []string{"Alpha", "Beta"})

	g := mixes.New(store, &stubCatalog{byseed: map[string][]domain.Track{}})
	out, err := g.All(context.Background(), control.DefaultUserID)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range out {
		if m.Kind == mixes.KindDaily || m.Kind == mixes.KindDiscover {
			t.Errorf("seeded mix %q offered on two artists of history", m.Title)
		}
	}
}

// On Repeat is a pure aggregate and should work from the very first listen.
func TestOnRepeatNeedsNoSeeding(t *testing.T) {
	store := openStore(t)
	seedHistory(t, store, []string{"Alpha"})

	g := mixes.New(store, &stubCatalog{byseed: map[string][]domain.Track{}})
	out, err := g.All(context.Background(), control.DefaultUserID)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) == 0 || out[0].Kind != mixes.KindOnRepeat {
		t.Fatalf("On Repeat should be present and first, got %+v", out)
	}
	if len(out[0].Tracks) == 0 {
		t.Error("On Repeat has no tracks")
	}
}

func TestDailyMixesInterleaveArtists(t *testing.T) {
	store := openStore(t)
	artists := []string{"Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"}
	seedHistory(t, store, artists)

	radio := map[string][]domain.Track{}
	for i := range artists {
		id := string(rune('a' + i))
		var rt []domain.Track
		for j := range 10 {
			rt = append(rt, track("r"+id+string(rune('0'+j)), "Radio", artists[i]))
		}
		radio["t"+id] = rt
	}

	g := mixes.New(store, &stubCatalog{byseed: radio})
	out, err := g.All(context.Background(), control.DefaultUserID)
	if err != nil {
		t.Fatal(err)
	}

	var daily []mixes.Mix
	for _, m := range out {
		if m.Kind == mixes.KindDaily {
			daily = append(daily, m)
		}
	}
	if len(daily) == 0 {
		t.Fatal("no daily mixes produced from six artists of history")
	}
	for _, m := range daily {
		if len(m.Tracks) < 5 {
			t.Errorf("%s has only %d tracks", m.Title, len(m.Tracks))
		}
		// No duplicates within a mix.
		seen := map[string]bool{}
		for _, tr := range m.Tracks {
			if seen[tr.ID] {
				t.Errorf("%s repeats track %s", m.Title, tr.ID)
			}
			seen[tr.ID] = true
		}
		if m.Description == "" {
			t.Errorf("%s has no description saying what it was built from", m.Title)
		}
	}
}

// Discovery must exclude what has already been played, or it is a
// familiarity mix wearing the wrong label.
func TestDiscoverExcludesAlreadyHeard(t *testing.T) {
	store := openStore(t)
	artists := []string{"Alpha", "Beta", "Gamma", "Delta"}
	seedHistory(t, store, artists)

	// Radio returns the already-played tracks plus genuinely new ones.
	radio := map[string][]domain.Track{}
	for i := range artists {
		id := string(rune('a' + i))
		radio["t"+id] = []domain.Track{
			track("t"+id, "Already played", artists[i]),
			track("new"+id, "Unheard", artists[i]),
		}
	}

	g := mixes.New(store, &stubCatalog{byseed: radio})
	discover, err := g.Discover(context.Background(), control.DefaultUserID, mustTopArtists(t, store))
	if err != nil {
		t.Fatal(err)
	}
	for _, tr := range discover.Tracks {
		if len(tr.ID) == 2 && tr.ID[0] == 't' {
			t.Errorf("discovery included an already-played track %q", tr.ID)
		}
	}
	if len(discover.Tracks) == 0 {
		t.Error("discovery produced nothing despite unheard tracks being available")
	}
}

func mustTopArtists(t *testing.T, s *control.Store) []control.ArtistStat {
	t.Helper()
	a, err := s.TopArtists(context.Background(), control.DefaultUserID, control.Last(90*24*time.Hour), 24)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

// An empty history must produce no mixes and no error: a fresh install is a
// normal state, not a failure.
func TestEmptyHistoryIsNotAnError(t *testing.T) {
	store := openStore(t)
	g := mixes.New(store, &stubCatalog{byseed: map[string][]domain.Track{}})
	out, err := g.All(context.Background(), control.DefaultUserID)
	if err != nil {
		t.Fatalf("empty history should not error: %v", err)
	}
	if len(out) != 0 {
		t.Errorf("expected no mixes, got %d", len(out))
	}
}
