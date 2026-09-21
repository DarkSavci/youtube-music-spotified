package control_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"spotifier/internal/control"
)

func TestStreamURLsSurviveARestartUntilTheyExpire(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "urls.db")
	s, err := control.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	_ = s.SaveStreamURL(ctx, "fresh", []byte(`{"u":1}`), time.Now().Add(time.Hour))
	_ = s.SaveStreamURL(ctx, "stale", []byte(`{"u":2}`), time.Now().Add(-time.Minute))
	s.Close()

	s, _ = control.Open(ctx, path)
	defer s.Close()
	if got, ok := s.StreamURL(ctx, "fresh"); !ok || string(got) != `{"u":1}` {
		t.Fatalf("fresh: %q %v", got, ok)
	}
	if _, ok := s.StreamURL(ctx, "stale"); ok {
		t.Fatal("an expired URL came back")
	}
	s.DropStreamURL(ctx, "fresh")
	if _, ok := s.StreamURL(ctx, "fresh"); ok {
		t.Fatal("a dropped URL came back")
	}
}
