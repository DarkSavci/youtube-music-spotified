package mixes_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"spotifier/internal/control"
	"spotifier/internal/domain"
	"spotifier/internal/innertube"
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
func (s *stubCatalog) MixPage(ctx context.Context, mix domain.MixSeed, _ string) ([]domain.Track, string, error) {
	t, err := s.Radio(ctx, mix.VideoID)
	return t, "", err
}
func (s *stubCatalog) Home(context.Context) (domain.BrowsePage, error) {
	return domain.BrowsePage{}, nil
}
func (s *stubCatalog) Browse(context.Context, string, string) (domain.BrowsePage, error) {
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

// busyCatalog records how many radio calls run at once.
type busyCatalog struct {
	stubCatalog
	mu       sync.Mutex
	inFlight int
	maxSeen  int
	total    int
}

func (b *busyCatalog) Radio(_ context.Context, seed string) ([]domain.Track, error) {
	b.mu.Lock()
	b.inFlight++
	b.total++
	if b.inFlight > b.maxSeen {
		b.maxSeen = b.inFlight
	}
	b.mu.Unlock()
	time.Sleep(20 * time.Millisecond)
	b.mu.Lock()
	b.inFlight--
	b.mu.Unlock()
	var out []domain.Track
	for i := 0; i < 20; i++ {
		out = append(out, track(seed+"-r"+string(rune('a'+i)), "Radio", "Someone"))
	}
	return out, nil
}

// Building the mixes used to fire about thirty radio calls in the same
// instant. Now a handful run at a time, from a few seeds per mix.
func TestMixesAskForRadioAFewAtATime(t *testing.T) {
	store := openStore(t)
	var artists []string
	for i := 0; i < 26; i++ {
		artists = append(artists, "Artist "+string(rune('A'+i)))
	}
	seedHistory(t, store, artists)

	cat := &busyCatalog{}
	g := mixes.New(store, cat)
	out, err := g.All(context.Background(), control.DefaultUserID)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) == 0 {
		t.Fatal("no mixes built")
	}
	if cat.maxSeen > 3 {
		t.Errorf("%d radio calls ran at once, want at most 3", cat.maxSeen)
	}
	if cat.total > 12 {
		t.Errorf("%d radio calls, want at most 12 (3 seeds × 3 daily mixes + 3 for Discover)", cat.total)
	}
	for _, m := range out {
		if len(m.Seeds) > 3 {
			t.Errorf("%s seeded from %d artists", m.Title, len(m.Seeds))
		}
	}
}

// failingCatalog fails every radio call after the first n with err, or only
// the calls for the seeds in bad.
type failingCatalog struct {
	busyCatalog
	ok  int
	err error
	bad map[string]bool
}

func (f *failingCatalog) Radio(ctx context.Context, seed string) ([]domain.Track, error) {
	if f.bad != nil {
		if f.bad[seed] {
			return nil, f.err
		}
		return f.busyCatalog.Radio(ctx, seed)
	}
	f.mu.Lock()
	allowed := f.ok > 0
	f.ok--
	f.mu.Unlock()
	if !allowed {
		return nil, f.err
	}
	return f.busyCatalog.Radio(ctx, seed)
}

// A set built while some radio calls fail is not handed out as the mixes:
// Seeded reports the failure so a kept set can stand instead.
func TestSeededIsAllOrNothing(t *testing.T) {
	store := openStore(t)
	var artists []string
	for i := 0; i < 9; i++ {
		artists = append(artists, "Artist "+string(rune('A'+i)))
	}
	seedHistory(t, store, artists)

	g := mixes.New(store, &failingCatalog{ok: 4, err: fmt.Errorf("innertube next: %w", &innertube.HTTPError{Status: 429, Endpoint: "next"})})
	if out, err := g.Seeded(context.Background(), control.DefaultUserID); err == nil {
		t.Fatalf("got %d mixes and no error while radio failed", len(out))
	}
	// Without a cache, All still shows what it could.
	if out, err := g.All(context.Background(), control.DefaultUserID); err != nil {
		t.Fatal(err)
	} else {
		_ = out
	}
	thin := openStore(t)
	seedHistory(t, thin, []string{"One", "Two"})
	if _, err := mixes.New(thin, &busyCatalog{}).Seeded(context.Background(), control.DefaultUserID); !errors.Is(err, mixes.ErrThinHistory) {
		t.Fatalf("thin history: %v", err)
	}
}

// One seed that cannot be played (a deleted song, say) drops only itself:
// the other mixes still build, and nothing blocks them for good.
func TestAnUnusableSeedOnlyDropsItself(t *testing.T) {
	store := openStore(t)
	var artists []string
	for i := 0; i < 9; i++ {
		artists = append(artists, "Artist "+string(rune('A'+i)))
	}
	seedHistory(t, store, artists)
	cat := &failingCatalog{err: errors.New("innertube next: video unavailable"), bad: map[string]bool{"ta": true}}
	out, err := mixes.New(store, cat).Seeded(context.Background(), control.DefaultUserID)
	if err != nil {
		t.Fatalf("one bad seed failed the set: %v", err)
	}
	if len(out) < 3 {
		t.Fatalf("only %d mixes built", len(out))
	}
}
