package control_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"spotifier/internal/control"
	"spotifier/internal/respcache"
)

func TestResponsesRoundTripAndSurviveReopening(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "test.db")
	s, err := control.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	stored := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	keep := time.Now().Add(time.Hour)
	if err := s.SaveResponse(ctx, "cat|album|a", respcache.Entry{Status: 200, Body: []byte(`{"id":"a"}`), StoredAt: stored}, keep); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveResponse(ctx, "cat|lyrics|b", respcache.Entry{Status: 404, Body: []byte(`{}`), StoredAt: stored}, keep); err != nil {
		t.Fatal(err)
	}
	s.Close()

	s, err = control.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	e, ok := s.LoadResponse(ctx, "cat|album|a")
	if !ok || e.Status != 200 || string(e.Body) != `{"id":"a"}` || !e.StoredAt.Equal(stored) {
		t.Fatalf("got %+v %v", e, ok)
	}
	if e, ok := s.LoadResponse(ctx, "cat|lyrics|b"); !ok || e.Status != 404 {
		t.Fatalf("a kept 404 did not come back: %+v", e)
	}
}

func TestResponsesPastTheirKeepDateAreGone(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	past := time.Now().Add(-time.Minute)
	_ = s.SaveResponse(ctx, "old", respcache.Entry{Status: 200, Body: []byte("x"), StoredAt: past}, past)
	if _, ok := s.LoadResponse(ctx, "old"); ok {
		t.Fatal("an answer past its keep date was served")
	}
}

func TestResponsePrefixesAreLiteral(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	keep := time.Now().Add(time.Hour)
	for _, k := range []string{"cat|playlist|PL_a|whole", "cat|playlist|PLXa|whole", "lib|albums"} {
		_ = s.SaveResponse(ctx, k, respcache.Entry{Status: 200, Body: []byte("x"), StoredAt: time.Now()}, keep)
	}
	// "_" is a LIKE wildcard; the prefix must not match PLXa.
	if err := s.DeleteResponses(ctx, "cat|playlist|PL_a|"); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.LoadResponse(ctx, "cat|playlist|PL_a|whole"); ok {
		t.Fatal("PL_a survived")
	}
	if _, ok := s.LoadResponse(ctx, "cat|playlist|PLXa|whole"); !ok {
		t.Fatal("PLXa was dropped by a wildcard")
	}
	if err := s.ExpireResponses(ctx, "lib|"); err != nil {
		t.Fatal(err)
	}
	if e, _ := s.LoadResponse(ctx, "lib|albums"); !e.Expired {
		t.Fatal("expiry did not stick")
	}
}
