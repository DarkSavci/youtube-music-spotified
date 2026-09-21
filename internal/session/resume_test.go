package session

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"spotifier/internal/clock"
	"spotifier/internal/domain"
)

// memResume is an in-memory ResumeStore that records what it was asked to do.
type memResume struct {
	blob    []byte
	saves   int
	cleared int
	failing bool
}

func (m *memResume) SaveResume(_ context.Context, _ int64, b []byte) error {
	if m.failing {
		return errors.New("disk full")
	}
	m.blob = append([]byte(nil), b...)
	m.saves++
	return nil
}

func (m *memResume) Resume(context.Context, int64) ([]byte, error) { return m.blob, nil }

func (m *memResume) ClearResume(context.Context, int64) error {
	m.blob = nil
	m.cleared++
	return nil
}

func sessionWith(tracks int, index int, positionMs int64) domain.Session {
	items := make([]domain.Track, tracks)
	for i := range items {
		items[i] = domain.Track{ID: string(rune('a' + i)), Title: "Track"}
	}
	return domain.Session{
		Queue:      domain.Queue{Items: items, Index: index, Origin: "album:MPRE1"},
		State:      domain.StatePlaying,
		PositionMs: positionMs,
		Volume:     0.42,
		Shuffle:    true,
		Repeat:     domain.RepeatOne,
	}
}

// What comes back is where the listener was: the track, the position in it,
// the rest of the queue, and how loud it was.
func TestSnapshotRoundTrip(t *testing.T) {
	store := &memResume{}
	k := &Keeper{Store: store, UserID: 1}
	k.save(context.Background(), Projection{State: sessionWith(4, 2, 91_000)})

	got := LoadSnapshot(context.Background(), store, 1)
	if got == nil {
		t.Fatal("nothing restored")
	}
	if got.Index != 2 || len(got.Tracks) != 4 {
		t.Fatalf("queue came back as %d of %d", got.Index, len(got.Tracks))
	}
	if got.PositionMs != 91_000 {
		t.Fatalf("position %d, want 91000", got.PositionMs)
	}
	if got.Volume != 0.42 || !got.Shuffle || got.Repeat != domain.RepeatOne {
		t.Fatalf("lost volume/shuffle/repeat: %+v", got)
	}
}

/*
A resolved URL must never be persisted.

It is bound to the address that asked for it and expires within hours, so a
restored queue built on one would answer 403 on its first track. The snapshot
carries catalogue identity only.
*/
func TestSnapshotHoldsNoResolvedURLs(t *testing.T) {
	store := &memResume{}
	k := &Keeper{Store: store, UserID: 1}
	k.save(context.Background(), Projection{State: sessionWith(2, 0, 0)})

	var raw map[string]any
	if err := json.Unmarshal(store.blob, &raw); err != nil {
		t.Fatalf("snapshot is not JSON: %v", err)
	}
	for _, banned := range []string{"url", "streamUrl", "signatureCipher", "expiresAt"} {
		if _, ok := raw[banned]; ok {
			t.Fatalf("snapshot carries %q", banned)
		}
	}
	if s := string(store.blob); len(s) > 0 && (contains(s, "googlevideo") || contains(s, "https://")) {
		t.Fatalf("snapshot looks like it carries a resolved URL: %s", s)
	}
}

func contains(h, n string) bool {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return true
		}
	}
	return false
}

// An emptied queue is forgotten, rather than coming back after the listener
// has cleared it.
func TestClearedQueueIsForgotten(t *testing.T) {
	store := &memResume{blob: []byte(`{"version":1,"tracks":[{"id":"a"}]}`)}
	k := &Keeper{Store: store, UserID: 1}
	k.save(context.Background(), Projection{State: domain.Session{}})

	if store.cleared != 1 {
		t.Fatalf("cleared %d times, want 1", store.cleared)
	}
	if LoadSnapshot(context.Background(), store, 1) != nil {
		t.Fatal("still restores after the queue was emptied")
	}
}

// A snapshot written by a different shape is discarded, not guessed at.
func TestUnknownSnapshotVersionIgnored(t *testing.T) {
	store := &memResume{blob: []byte(`{"version":99,"tracks":[{"id":"a"}],"index":0}`)}
	if LoadSnapshot(context.Background(), store, 1) != nil {
		t.Fatal("restored a snapshot from an unknown version")
	}
}

// Restoring hands the queue back paused, at the position it was left.
func TestRestoreComesBackPaused(t *testing.T) {
	h := NewHub(clock.System{}, DefaultSettings(), nil)
	h.Restore(&Snapshot{
		Version: snapshotVersion,
		Tracks:  []domain.Track{{ID: "a"}, {ID: "b"}},
		Index:   1, PositionMs: 45_000, Volume: 0.3,
	})

	p := h.Projection()
	if p.State.State != domain.StatePaused {
		t.Fatalf("restored as %q, want paused", p.State.State)
	}
	if p.State.Queue.Index != 1 || p.State.PositionMs != 45_000 {
		t.Fatalf("restored at %d of queue, %dms", p.State.Queue.Index, p.State.PositionMs)
	}
	if p.State.Volume != 0.3 {
		t.Fatalf("volume %v, want 0.3", p.State.Volume)
	}
}

// A failing store must never become the caller's problem.
func TestSaveFailureIsSurvivable(t *testing.T) {
	k := &Keeper{Store: &memResume{failing: true}, UserID: 1}
	k.save(context.Background(), Projection{State: sessionWith(1, 0, 0)})
}

// The final write on shutdown is the one that matters: it captures the
// position at the moment of closing.
func TestKeeperWritesOnShutdown(t *testing.T) {
	store := &memResume{}
	h := NewHub(clock.System{}, DefaultSettings(), nil)
	k := &Keeper{Store: store, UserID: 1, Every: time.Hour}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { k.Run(ctx, h); close(done) }()

	time.Sleep(40 * time.Millisecond)
	h.Restore(&Snapshot{Version: snapshotVersion, Tracks: []domain.Track{{ID: "a"}}, PositionMs: 7000})
	h.SetSettings(0, true) // provokes a broadcast the Keeper will see
	time.Sleep(60 * time.Millisecond)

	cancel()
	<-done

	if store.saves == 0 {
		t.Fatal("nothing was written on shutdown")
	}
	if got := LoadSnapshot(context.Background(), store, 1); got == nil || got.PositionMs != 7000 {
		t.Fatalf("shutdown snapshot wrong: %+v", got)
	}
}
