package session

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"
	"time"

	"spotifier/internal/domain"
)

/*
Remembering where the listener left off.

Closing the app should not be the same as throwing the queue away: the track,
the position in it, what was queued behind it, and how loud it was are all
things a listener expects to find again.

What is deliberately *not* remembered is anything resolved. A stream URL is
bound to the address that asked for it and expires within hours (ADR 0002), so
persisting one would mean restoring a queue whose first track answers 403. The
snapshot holds catalogue identity only, and the tracks resolve again on
demand, exactly as they would if they had just been searched for.

Restoring never starts playback. A player that begins making noise because the
machine was turned on is startling, and the browser would refuse it anyway for
want of a user gesture — so the queue comes back paused, at the position it
was left.
*/

// Snapshot is the state that survives a restart.
type Snapshot struct {
	// Version guards against reading a shape this build does not understand.
	// An unknown version is discarded rather than guessed at.
	Version int `json:"version"`

	Tracks     []domain.Track    `json:"tracks"`
	Index      int               `json:"index"`
	Origin     string            `json:"origin,omitempty"`
	PositionMs int64             `json:"positionMs"`
	Volume     float64           `json:"volume"`
	Shuffle    bool              `json:"shuffle"`
	Repeat     domain.RepeatMode `json:"repeat"`
	SavedAt    time.Time         `json:"savedAt"`
}

// snapshotVersion is the shape this build writes and accepts.
const snapshotVersion = 1

// ResumeStore is the persistence this needs: one snapshot, replaced in place.
type ResumeStore interface {
	SaveResume(ctx context.Context, userID int64, snapshot []byte) error
	Resume(ctx context.Context, userID int64) ([]byte, error)
	ClearResume(ctx context.Context, userID int64) error
}

/*
Keeper writes the session's state down as it changes.

It subscribes like any other consumer rather than the Hub knowing about
storage, which keeps persistence out of the playback logic entirely — the Hub
has no idea this exists.

Writes are rate-limited because projections arrive on every accepted command
and every engine report, which while scrubbing is many per second. Losing the
last few seconds of position on a crash is not worth a disk write per frame.
*/
type Keeper struct {
	Store  ResumeStore
	UserID int64
	Log    *slog.Logger

	// Every is the shortest gap between writes. Zero means the default.
	Every time.Duration

	// off is set when the listener asks not to be remembered. Atomic because
	// it is flipped from an HTTP handler while Run is in its loop.
	off atomic.Bool
}

/*
SetEnabled turns remembering on or off, and forgets when turned off.

Forgetting immediately rather than merely ceasing to write is the point: a
listener who turns this off is asking for the last thing they played not to
come back, and a stale row would do exactly that at the next launch.
*/
func (k *Keeper) SetEnabled(ctx context.Context, on bool) {
	k.off.Store(!on)
	if on || k.Store == nil {
		return
	}
	if err := k.Store.ClearResume(ctx, k.UserID); err != nil && k.Log != nil {
		k.Log.Debug("resume: clear on disable", "err", err)
	}
}

// Enabled reports whether state is being remembered.
func (k *Keeper) Enabled() bool { return !k.off.Load() }

// defaultSaveEvery is often enough that a restart loses little, rare enough
// that scrubbing does not thrash the disk.
const defaultSaveEvery = 5 * time.Second

/*
Run persists state until the context ends, then writes a final snapshot.

The final write is the important one: it captures the position at the moment
of closing, which is the one a listener actually notices being wrong.
*/
func (k *Keeper) Run(ctx context.Context, hub *Hub) {
	if k.Store == nil || hub == nil {
		return
	}
	every := k.Every
	if every <= 0 {
		every = defaultSaveEvery
	}

	updates, cancel := hub.Subscribe()
	defer cancel()

	var (
		latest  Projection
		pending bool
	)
	tick := time.NewTicker(every)
	defer tick.Stop()

	for {
		select {
		case <-ctx.Done():
			if pending {
				// Detached, because the context that just ended is the reason
				// this write is happening — but bounded, so a stuck disk
				// cannot hold the process open.
				final, done := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
				k.save(final, latest)
				done()
			}
			return

		case p, ok := <-updates:
			if !ok {
				return
			}
			latest, pending = p, true

		case <-tick.C:
			if !pending {
				continue
			}
			k.save(ctx, latest)
			pending = false
		}
	}
}

// save writes one snapshot, reporting failures without making them the
// caller's problem — a lost resume point must never interrupt playback.
func (k *Keeper) save(ctx context.Context, p Projection) {
	if k.off.Load() {
		return
	}
	state := p.State
	if p.FollowingRoom {
		// A room is temporary. Crashes must not replace the personal queue.
		if p.PersonalResume == nil {
			return
		}
		state = *p.PersonalResume
	}
	snap := snapshotOf(state)
	if snap == nil {
		// Nothing queued. Forget rather than leave a stale queue to come back
		// after the listener has cleared it.
		if err := k.Store.ClearResume(ctx, k.UserID); err != nil && k.Log != nil {
			k.Log.Debug("resume: clear", "err", err)
		}
		return
	}
	blob, err := json.Marshal(snap)
	if err != nil {
		if k.Log != nil {
			k.Log.Debug("resume: encode", "err", err)
		}
		return
	}
	if err := k.Store.SaveResume(ctx, k.UserID, blob); err != nil && k.Log != nil {
		k.Log.Debug("resume: save", "err", err)
	}
}

// snapshotOf reduces a session to what is worth keeping, or nil when there is
// nothing to keep.
func snapshotOf(s domain.Session) *Snapshot {
	if len(s.Queue.Items) == 0 {
		return nil
	}
	return &Snapshot{
		Version:    snapshotVersion,
		Tracks:     s.Queue.Items,
		Index:      s.Queue.Index,
		Origin:     s.Queue.Origin,
		PositionMs: s.PositionMs,
		Volume:     s.Volume,
		Shuffle:    s.Shuffle,
		Repeat:     s.Repeat,
		SavedAt:    time.Now().UTC(),
	}
}

// LoadSnapshot reads the stored snapshot, or nil when there is none worth
// restoring. A snapshot from a shape this build does not know is discarded.
func LoadSnapshot(ctx context.Context, store ResumeStore, userID int64) *Snapshot {
	if store == nil {
		return nil
	}
	blob, err := store.Resume(ctx, userID)
	if err != nil || len(blob) == 0 {
		return nil
	}
	var snap Snapshot
	if err := json.Unmarshal(blob, &snap); err != nil {
		return nil
	}
	if snap.Version != snapshotVersion || len(snap.Tracks) == 0 {
		return nil
	}
	if snap.Index < 0 || snap.Index >= len(snap.Tracks) {
		snap.Index = 0
	}
	return &snap
}
