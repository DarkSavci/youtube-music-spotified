package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"spotifier/internal/api"
	"spotifier/internal/clock"
	"spotifier/internal/control"
	"spotifier/internal/domain"
	"spotifier/internal/mixes"
	"spotifier/internal/respcache"
)

// radioCatalogFor answers radio for mixes and can be made to fail.
type radioCatalogFor struct {
	brokenCatalog
	mu    sync.Mutex
	fail  error
	calls int
}

func (c *radioCatalogFor) Radio(_ context.Context, seed string) ([]domain.Track, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	if c.fail != nil {
		return nil, c.fail
	}
	var out []domain.Track
	for i := 0; i < 20; i++ {
		out = append(out, domain.Track{ID: seed + "-" + string(rune('a'+i)), Title: "R", Playable: true})
	}
	return out, nil
}

func (c *radioCatalogFor) setFail(err error) {
	c.mu.Lock()
	c.fail = err
	c.mu.Unlock()
}

func historyOf(t *testing.T, artists int) *control.Store {
	t.Helper()
	s, err := control.Open(context.Background(), filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	var plays []control.Play
	for i := 0; i < artists; i++ {
		id := string(rune('a' + i))
		plays = append(plays, control.Play{
			EventUUID: "e" + id, TrackID: "t" + id, Title: "Track " + id,
			Artist: "Artist " + id, ArtistID: "UC" + id, PlayedMs: 200_000,
			PlayedAt: time.Now().UTC().Add(-time.Duration(i+1) * time.Hour),
		})
	}
	if err := s.RecordPlays(context.Background(), control.DefaultUserID, plays); err != nil {
		t.Fatal(err)
	}
	return s
}

func mixIDs(t *testing.T, s *api.Server) []string {
	t.Helper()
	rec := do(t, s, http.MethodGet, "/v1/me/mixes")
	var got []mixes.Mix
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode %s: %v", rec.Body, err)
	}
	var ids []string
	for _, m := range got {
		if m.Kind != mixes.KindOnRepeat {
			ids = append(ids, m.ID)
		}
	}
	return ids
}

func TestARateLimitedRebuildKeepsTheMixesThatWereThere(t *testing.T) {
	clk := clock.NewManual()
	store := historyOf(t, 9)
	cat := &radioCatalogFor{}
	cache := respcache.New(respcache.Options{Clock: clk})
	s := serverWith(api.Deps{Catalog: cat, Control: store, Mixes: mixes.New(store, cat), Responses: cache})

	good := mixIDs(t, s)
	if len(good) == 0 {
		t.Fatal("no mixes built")
	}
	clk.Advance(3 * 24 * time.Hour) // past fresh and past the revalidate window
	cat.setFail(errors.New("innertube next: HTTP 429: Resource has been exhausted"))
	if got := mixIDs(t, s); len(got) != len(good) {
		t.Fatalf("during the rate limit got %v, want the kept %v", got, good)
	}
	// And the failure was not kept: once YouTube answers, they are rebuilt.
	cat.setFail(nil)
	before := cat.calls
	mixIDs(t, s)
	if cat.calls == before {
		t.Fatal("the mixes were not rebuilt after the rate limit passed")
	}
}

func TestAFailedFirstBuildIsNotRetriedAtOnce(t *testing.T) {
	clk := clock.NewManual()
	store := historyOf(t, 9)
	cat := &radioCatalogFor{fail: errors.New("HTTP 429")}
	s := serverWith(api.Deps{Catalog: cat, Control: store, Mixes: mixes.New(store, cat), Responses: respcache.New(respcache.Options{Clock: clk})})
	mixIDs(t, s)
	first := cat.calls
	mixIDs(t, s)
	if cat.calls != first {
		t.Fatalf("a failed build was retried at once (%d more radio calls)", cat.calls-first)
	}
	clk.Advance(6 * time.Minute)
	mixIDs(t, s)
	if cat.calls == first {
		t.Fatal("never retried")
	}
}

func TestNotEnoughHistoryIsOnlyKeptBriefly(t *testing.T) {
	clk := clock.NewManual()
	store := historyOf(t, 2)
	cat := &radioCatalogFor{}
	s := serverWith(api.Deps{Catalog: cat, Control: store, Mixes: mixes.New(store, cat), Responses: respcache.New(respcache.Options{Clock: clk})})
	if got := mixIDs(t, s); len(got) != 0 {
		t.Fatalf("two artists gave mixes %v", got)
	}
	// Listening grows past the threshold.
	if err := store.RecordPlays(context.Background(), control.DefaultUserID, []control.Play{
		{EventUUID: "x1", TrackID: "tx", Title: "X", Artist: "Artist x", ArtistID: "UCx", PlayedMs: 200_000, PlayedAt: time.Now().UTC()},
		{EventUUID: "y1", TrackID: "ty", Title: "Y", Artist: "Artist y", ArtistID: "UCy", PlayedMs: 200_000, PlayedAt: time.Now().UTC()},
	}); err != nil {
		t.Fatal(err)
	}
	clk.Advance(11 * time.Minute)
	mixIDs(t, s) // served the brief answer while it rebuilds
	s2 := mixIDs(t, s)
	for i := 0; i < 50 && len(s2) == 0; i++ {
		time.Sleep(10 * time.Millisecond)
		s2 = mixIDs(t, s)
	}
	if len(s2) == 0 {
		t.Fatal("mixes never appeared once there was enough history")
	}
}
