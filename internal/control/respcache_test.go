package control_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"spotifier/internal/control"
	"spotifier/internal/respcache"
)

func openResponses(t *testing.T, path string) *control.Responses {
	t.Helper()
	r, err := control.OpenResponses(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	return r
}

func TestResponsesRoundTripAndSurviveReopening(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), control.ResponsesFile)
	r, err := control.OpenResponses(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	stored := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	fresh := stored.Add(time.Minute)
	keep := time.Now().Add(time.Hour)
	if err := r.SaveResponse(ctx, "cat|album|a", respcache.Entry{Status: 200, Body: []byte(`{"id":"a"}`), StoredAt: stored, FreshUntil: fresh}, keep); err != nil {
		t.Fatal(err)
	}
	if err := r.SaveResponse(ctx, "cat|lyrics|b", respcache.Entry{Status: 404, Body: []byte(`{}`), StoredAt: stored}, keep); err != nil {
		t.Fatal(err)
	}
	r.Close()

	r = openResponses(t, path)
	e, ok := r.LoadResponse(ctx, "cat|album|a")
	if !ok || e.Status != 200 || string(e.Body) != `{"id":"a"}` || !e.StoredAt.Equal(stored) || !e.FreshUntil.Equal(fresh) {
		t.Fatalf("got %+v %v", e, ok)
	}
	if e, ok := r.LoadResponse(ctx, "cat|lyrics|b"); !ok || e.Status != 404 || !e.FreshUntil.IsZero() {
		t.Fatalf("a kept 404 did not come back as it was: %+v", e)
	}
}

func TestResponsesPastTheirKeepDateAreGone(t *testing.T) {
	ctx := context.Background()
	r := openResponses(t, filepath.Join(t.TempDir(), control.ResponsesFile))
	past := time.Now().Add(-time.Minute)
	_ = r.SaveResponse(ctx, "old", respcache.Entry{Status: 200, Body: []byte("x"), StoredAt: past}, past)
	if _, ok := r.LoadResponse(ctx, "old"); ok {
		t.Fatal("an answer past its keep date was served")
	}
}

func TestResponsePrefixesAreLiteral(t *testing.T) {
	ctx := context.Background()
	r := openResponses(t, filepath.Join(t.TempDir(), control.ResponsesFile))
	keep := time.Now().Add(time.Hour)
	for _, k := range []string{"cat|playlist|PL_a|whole", "cat|playlist|PLXa|whole", "lib|albums"} {
		_ = r.SaveResponse(ctx, k, respcache.Entry{Status: 200, Body: []byte("x"), StoredAt: time.Now()}, keep)
	}
	// "_" is a LIKE wildcard; the prefix must not match PLXa.
	if err := r.DeleteResponses(ctx, "cat|playlist|PL_a|"); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.LoadResponse(ctx, "cat|playlist|PL_a|whole"); ok {
		t.Fatal("PL_a survived")
	}
	if _, ok := r.LoadResponse(ctx, "cat|playlist|PLXa|whole"); !ok {
		t.Fatal("PLXa was dropped by a wildcard")
	}
	if err := r.ExpireResponses(ctx, "lib|"); err != nil {
		t.Fatal(err)
	}
	if e, _ := r.LoadResponse(ctx, "lib|albums"); !e.Expired {
		t.Fatal("expiry did not stick")
	}
}

func TestPruningKeepsTheNewestWithinTheRowCap(t *testing.T) {
	ctx := context.Background()
	r := openResponses(t, filepath.Join(t.TempDir(), control.ResponsesFile))
	keep := time.Now().Add(time.Hour)
	base := time.Now().Add(-time.Hour)
	for i := 0; i < 4010; i++ {
		_ = r.SaveResponse(ctx, "k"+time.Duration(i).String(), respcache.Entry{Status: 200, Body: []byte("x"), StoredAt: base.Add(time.Duration(i) * time.Millisecond)}, keep)
	}
	if err := r.PruneResponses(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.LoadResponse(ctx, "k"+time.Duration(0).String()); ok {
		t.Fatal("the oldest answer survived the cap")
	}
	if _, ok := r.LoadResponse(ctx, "k"+time.Duration(4009).String()); !ok {
		t.Fatal("the newest answer was pruned")
	}
}
