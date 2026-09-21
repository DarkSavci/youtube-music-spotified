package session_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"spotifier/internal/clock"
	"spotifier/internal/control"
	"spotifier/internal/domain"
	"spotifier/internal/session"
)

/*
The whole thing, through the real database: play, close, reopen.

The in-memory tests cover the snapshot's shape; this covers the part that
actually breaks in the field — the SQL, the upsert, and the fact that a second
process reading the same file sees what the first one wrote.
*/
func TestResumeSurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "resume.db")
	ctx := context.Background()

	queue := []domain.Track{
		{ID: "aaa", Title: "First", DurationMs: 200_000},
		{ID: "bbb", Title: "Second", DurationMs: 180_000},
		{ID: "ccc", Title: "Third", DurationMs: 240_000},
	}

	// --- first run: listen, then close ---
	{
		store, err := control.Open(ctx, path)
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		hub := session.NewHub(clock.System{}, session.DefaultSettings(), nil)
		keeper := &session.Keeper{Store: store, UserID: control.DefaultUserID, Every: 20 * time.Millisecond}

		runCtx, stop := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() { keeper.Run(runCtx, hub); close(done) }()

		dev := hub.Register("probe", "Probe", session.Capabilities{})
		if _, err := hub.Command(ctx, dev.ID, session.Command{
			Kind: "play", Tracks: queue, StartIndex: 1, Origin: "album:X",
		}); err != nil {
			t.Fatalf("play: %v", err)
		}
		if _, err := hub.Command(ctx, dev.ID, session.Command{Kind: "seek", PositionMs: 64_000}); err != nil {
			t.Fatalf("seek: %v", err)
		}
		if _, err := hub.Command(ctx, dev.ID, session.Command{Kind: "set_volume", Volume: 0.25}); err != nil {
			t.Fatalf("volume: %v", err)
		}

		time.Sleep(120 * time.Millisecond) // let a periodic write land
		stop()
		<-done
		_ = store.Close()
	}

	// --- second run: a new process, the same file ---
	store, err := control.Open(ctx, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = store.Close() }()

	snap := session.LoadSnapshot(ctx, store, control.DefaultUserID)
	if snap == nil {
		t.Fatal("nothing was remembered")
	}

	hub := session.NewHub(clock.System{}, session.DefaultSettings(), nil)
	hub.Restore(snap)
	got := hub.Projection().State

	if got.Queue.Index != 1 || len(got.Queue.Items) != 3 {
		t.Fatalf("queue came back as %d of %d, want 1 of 3", got.Queue.Index, len(got.Queue.Items))
	}
	if got.Queue.Items[got.Queue.Index].Title != "Second" {
		t.Fatalf("resumed on %q, want Second", got.Queue.Items[got.Queue.Index].Title)
	}
	if got.PositionMs != 64_000 {
		t.Fatalf("resumed at %dms, want 64000", got.PositionMs)
	}
	if got.Volume != 0.25 {
		t.Fatalf("volume %v, want 0.25", got.Volume)
	}
	// Never playing: the machine being switched on is not a reason to make
	// a noise, and a browser would refuse to anyway.
	if got.State != domain.StatePaused {
		t.Fatalf("came back %q, want paused", got.State)
	}
}

// Turning the setting off forgets what was already stored, rather than merely
// ceasing to add to it.
func TestDisablingResumeForgets(t *testing.T) {
	ctx := context.Background()
	store, err := control.Open(ctx, filepath.Join(t.TempDir(), "r.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = store.Close() }()

	if err := store.SaveResume(ctx, control.DefaultUserID, []byte(`{"version":1,"tracks":[{"id":"a"}]}`)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	k := &session.Keeper{Store: store, UserID: control.DefaultUserID}
	k.SetEnabled(ctx, false)

	if session.LoadSnapshot(ctx, store, control.DefaultUserID) != nil {
		t.Fatal("still remembers after being told not to")
	}
	if k.Enabled() {
		t.Fatal("reports enabled after being turned off")
	}
}
