package session

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"spotifier/internal/clock"
	"spotifier/internal/domain"
)

// recordingSink captures play-log entries the hub emits.
type recordingSink struct{ entries []LogEntry }

func (r *recordingSink) Record(_ context.Context, e []LogEntry) {
	r.entries = append(r.entries, e...)
}

func newHub(t *testing.T) (*Hub, *recordingSink) {
	t.Helper()
	sink := &recordingSink{}
	return NewHub(clock.NewManual(), DefaultSettings(), sink), sink
}

func fullCaps() Capabilities {
	return Capabilities{EQ: true, Crossfade: "true", Normalization: true, PreciseSeek: true}
}

func limitedCaps() Capabilities {
	return Capabilities{Crossfade: "approx", VolumeSteps: 101}
}

// The first Device to register takes ownership, so a single-device setup needs
// no explicit transfer to start playing.
func TestFirstDeviceTakesOwnership(t *testing.T) {
	h, _ := newHub(t)
	dev := h.Register("laptop", "Laptop", fullCaps())

	if !dev.Owner {
		t.Error("the first device should own playback")
	}
	if got := h.Projection().State.OwnerDeviceID; got != "laptop" {
		t.Errorf("owner = %q, want laptop", got)
	}
	if !h.Projection().Caps.EQ {
		t.Error("the owner's capabilities should become the session's")
	}
}

// A second Device joins as an observer; it can control playback but does not
// take over sound.
func TestSecondDeviceObservesWithoutStealingPlayback(t *testing.T) {
	h, _ := newHub(t)
	h.Register("laptop", "Laptop", fullCaps())
	second := h.Register("phone", "Phone", limitedCaps())

	if second.Owner {
		t.Error("joining must not steal playback from the current owner")
	}
	if got := h.Projection().State.OwnerDeviceID; got != "laptop" {
		t.Errorf("owner changed to %q on a second device joining", got)
	}
}

// The full Connect handoff: state survives, capabilities follow the new owner,
// and the epoch advances so the old owner's reports are discarded.
func TestTransferMovesPlaybackWithoutLosingState(t *testing.T) {
	h, _ := newHub(t)
	ctx := context.Background()
	h.Register("laptop", "Laptop", fullCaps())
	h.Register("phone", "Phone", limitedCaps())

	if _, err := h.Command(ctx, "laptop", Command{
		Kind: CmdPlay, Tracks: tracks(5), StartIndex: 2, Origin: "Album",
	}); err != nil {
		t.Fatal(err)
	}
	h.EngineEvent(ctx, "laptop", EngineEvent{
		Kind: EvPosition, Epoch: h.Projection().State.Epoch, PositionMs: 42_000,
	})

	before := h.Projection()
	epochBefore := before.State.Epoch

	if _, err := h.Command(ctx, "phone", Command{Kind: CmdTransfer, DeviceID: "phone"}); err != nil {
		t.Fatal(err)
	}
	after := h.Projection()

	if after.State.OwnerDeviceID != "phone" {
		t.Fatalf("owner = %q, want phone", after.State.OwnerDeviceID)
	}
	// The queue and position are what make a transfer feel seamless.
	if after.State.Queue.Index != before.State.Queue.Index {
		t.Errorf("queue position moved on transfer: %d -> %d",
			before.State.Queue.Index, after.State.Queue.Index)
	}
	if len(after.State.Queue.Items) != len(before.State.Queue.Items) {
		t.Error("the queue did not survive the transfer")
	}
	if after.State.PositionMs != before.State.PositionMs {
		t.Errorf("playback position moved on transfer: %d -> %d",
			before.State.PositionMs, after.State.PositionMs)
	}
	if after.State.Epoch == epochBefore {
		t.Error("transfer must advance the epoch so the old owner's reports are dropped")
	}
	// Capabilities follow the owner, so the UI stops offering an equaliser the
	// new device cannot provide.
	if after.Caps.EQ {
		t.Error("capabilities did not follow ownership to the limited device")
	}
}

// After a transfer, the previous owner's engine reports must be ignored.
func TestFormerOwnerCannotDriveTheQueue(t *testing.T) {
	h, _ := newHub(t)
	ctx := context.Background()
	h.Register("laptop", "Laptop", fullCaps())
	h.Register("phone", "Phone", fullCaps())
	h.Command(ctx, "laptop", Command{Kind: CmdPlay, Tracks: tracks(5)})
	h.Command(ctx, "phone", Command{Kind: CmdTransfer, DeviceID: "phone"})

	indexBefore := h.Projection().State.Queue.Index

	// The laptop's engine finally reports that the track ended.
	h.EngineEvent(ctx, "laptop", EngineEvent{Kind: EvEnded, Epoch: h.Projection().State.Epoch})

	if got := h.Projection().State.Queue.Index; got != indexBefore {
		t.Errorf("a former owner advanced the queue: %d -> %d", indexBefore, got)
	}
}

// Closing the owning window should hand playback on rather than stopping it.
func TestOwnerLeavingPassesPlaybackOn(t *testing.T) {
	h, _ := newHub(t)
	ctx := context.Background()
	h.Register("laptop", "Laptop", fullCaps())
	h.Register("speaker", "Speaker", fullCaps())
	h.Command(ctx, "laptop", Command{Kind: CmdPlay, Tracks: tracks(3)})

	h.Unregister("laptop")

	p := h.Projection()
	if p.State.OwnerDeviceID != "speaker" {
		t.Errorf("owner = %q, want the remaining device", p.State.OwnerDeviceID)
	}
	if len(p.State.Queue.Items) != 3 {
		t.Error("the queue did not survive the owner leaving")
	}
}

// With nothing left to play on, playback pauses rather than pretending.
func TestLastDeviceLeavingPauses(t *testing.T) {
	h, _ := newHub(t)
	ctx := context.Background()
	h.Register("laptop", "Laptop", fullCaps())
	h.Command(ctx, "laptop", Command{Kind: CmdPlay, Tracks: tracks(3)})

	h.Unregister("laptop")

	if got := h.Projection().State.State; got != domain.StatePaused {
		t.Errorf("state = %s, want paused with no devices present", got)
	}
}

// Any device may control playback — that is what a remote is.
func TestNonOwnerCanControlPlayback(t *testing.T) {
	h, _ := newHub(t)
	ctx := context.Background()
	h.Register("speaker", "Speaker", fullCaps())
	h.Register("phone", "Phone", fullCaps())
	h.Command(ctx, "speaker", Command{Kind: CmdPlay, Tracks: tracks(5)})

	if _, err := h.Command(ctx, "phone", Command{Kind: CmdNext}); err != nil {
		t.Fatal(err)
	}
	if got := h.Projection().State.Queue.Index; got != 1 {
		t.Errorf("a non-owner could not skip: index = %d", got)
	}
	// Control does not imply ownership: sound stays where it was.
	if h.Projection().State.OwnerDeviceID != "speaker" {
		t.Error("controlling playback should not move it")
	}
}

func TestSubscribersReceiveProjections(t *testing.T) {
	h, _ := newHub(t)
	ctx := context.Background()
	h.Register("laptop", "Laptop", fullCaps())

	ch, cancel := h.Subscribe()
	defer cancel()

	// A new subscriber gets current state immediately rather than waiting for
	// the next change.
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal("no initial projection delivered")
	}

	h.Command(ctx, "laptop", Command{Kind: CmdPlay, Tracks: tracks(3)})

	select {
	case p := <-ch:
		if len(p.State.Queue.Items) != 3 {
			t.Errorf("projection missing the queue: %+v", p.State.Queue)
		}
		if p.Target.VideoID == "" {
			t.Error("projection carries no target for the engine to reconcile to")
		}
	case <-time.After(time.Second):
		t.Fatal("no projection after a command")
	}
}

// A subscriber that stops reading must not stall the hub, or one wedged device
// would freeze playback for every other.
func TestSlowSubscriberDoesNotStallTheHub(t *testing.T) {
	h, _ := newHub(t)
	ctx := context.Background()
	h.Register("laptop", "Laptop", fullCaps())

	_, cancel := h.Subscribe() // never drained
	defer cancel()

	done := make(chan struct{})
	go func() {
		for range 100 {
			h.Command(ctx, "laptop", Command{Kind: CmdPlay, Tracks: tracks(2)})
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the hub stalled behind a subscriber that stopped reading")
	}
}

// Listening is persisted through the sink, outside the core.
func TestPlayLogReachesTheSink(t *testing.T) {
	h, sink := newHub(t)
	ctx := context.Background()
	h.Register("laptop", "Laptop", fullCaps())
	h.Command(ctx, "laptop", Command{Kind: CmdPlay, Tracks: tracks(3), Origin: "Album"})

	epoch := h.Projection().State.Epoch
	h.EngineEvent(ctx, "laptop", EngineEvent{Kind: EvPosition, Epoch: epoch, PositionMs: 45_000})
	h.EngineEvent(ctx, "laptop", EngineEvent{Kind: EvEnded, Epoch: epoch})

	if len(sink.entries) == 0 {
		t.Fatal("a completed track produced no play-log entry")
	}
	if !sink.entries[0].Completed {
		t.Errorf("entry should be marked completed: %+v", sink.entries[0])
	}
	if sink.entries[0].Origin != "Album" {
		t.Errorf("origin not carried through: %q", sink.entries[0].Origin)
	}
}

// Concurrent commands from several devices must not corrupt state.
func TestConcurrentCommandsAreSerialised(t *testing.T) {
	h, _ := newHub(t)
	ctx := context.Background()
	for _, id := range []string{"a", "b", "c"} {
		h.Register(id, id, fullCaps())
	}
	h.Command(ctx, "a", Command{Kind: CmdPlay, Tracks: tracks(20)})

	done := make(chan struct{})
	for _, id := range []string{"a", "b", "c"} {
		go func(device string) {
			for range 50 {
				h.Command(ctx, device, Command{Kind: CmdNext})
				h.Projection()
			}
			done <- struct{}{}
		}(id)
	}
	for range 3 {
		<-done
	}

	p := h.Projection()
	if p.State.Queue.Index < 0 || p.State.Queue.Index >= len(p.State.Queue.Items) {
		t.Fatalf("queue index escaped its bounds under concurrency: %d of %d",
			p.State.Queue.Index, len(p.State.Queue.Items))
	}
}

// A nil slice marshals to JSON null, and the client indexes into the queue as
// soon as it connects — when the queue is necessarily empty. Emitting null
// there threw on every fresh launch, before the user had done anything.
func TestProjectionEmptyListsAreNeverNull(t *testing.T) {
	h, _ := newHub(t)
	p := h.Projection()

	if p.State.Queue.Items == nil {
		t.Fatal("empty queue marshals as null; the client cannot index it")
	}
	if p.Devices == nil {
		t.Fatal("empty device list marshals as null")
	}

	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(`"items":null`)) {
		t.Fatalf("projection still carries a null list: %s", raw)
	}
}
