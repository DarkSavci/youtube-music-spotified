package session

import (
	"context"
	"fmt"
	"sync"
	"time"

	"spotifier/internal/clock"
	"spotifier/internal/domain"
)

/*
The hub.

Serialises access to the Core and fans its state out to subscribers. The Core
itself stays a pure reducer with no locks, no channels and no I/O; everything
concurrent lives here.

This is also where Connect happens. A Device is just a subscriber that may hold
ownership, and a transfer is an ordinary command — so the single-device case is
the degenerate multi-device case rather than a separate code path. Local playback exercises the same machinery Connect will,
which is what stops Connect becoming a rewrite later.
*/

// Device is a client that can hold and observe a Session.
type Device struct {
	ID       string       `json:"id"`
	Name     string       `json:"name"`
	Caps     Capabilities `json:"capabilities"`
	LastSeen time.Time    `json:"lastSeen"`
	// Owner is true for the Device currently producing sound.
	Owner bool `json:"owner"`
}

// Projection is the state plus the target, which is everything a subscriber
// needs to render and to reconcile its engine.
type Projection struct {
	FollowingRoom bool           `json:"followingRoom"`
	State         domain.Session `json:"state"`
	Target        Target         `json:"target"`
	Devices       []Device       `json:"devices"`
	Caps          Capabilities   `json:"capabilities"`
}

// LogSink receives play-log entries. Implemented by the Control plane; the Core
// emits entries but performs no I/O itself.
type LogSink interface {
	Record(ctx context.Context, entries []LogEntry)
}

// Hub owns the Core and coordinates Devices.
type Hub struct {
	mu      sync.Mutex
	core    *Core
	devices map[string]*Device

	subscribers map[int64]chan Projection
	nextSubID   int64

	sink LogSink
	clk  clock.Clock
}

// NewHub builds a Hub around a fresh Core.
func NewHub(clk clock.Clock, settings Settings, sink LogSink) *Hub {
	if clk == nil {
		clk = clock.System{}
	}
	return &Hub{
		core:        New(clk, settings, time.Now().UnixNano()),
		devices:     map[string]*Device{},
		subscribers: map[int64]chan Projection{},
		sink:        sink,
		clk:         clk,
	}
}

/*
Restore seeds the session from a saved snapshot, paused.

Called once at startup, before any Device registers, so there is no owner to
notify and nothing to interrupt. Paused on purpose: a player that starts
making noise because the machine was switched on is startling, and a browser
would refuse to start it anyway without a gesture to hang the decision on.

Position is set as an anchor stopped at the saved point, so the transport bar
opens showing where the listener actually was rather than at zero.
*/
func (h *Hub) Restore(snap *Snapshot) {
	if snap == nil || len(snap.Tracks) == 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	st := &h.core.state
	st.Queue.Items = snap.Tracks
	st.Queue.Index = snap.Index
	st.Queue.Origin = snap.Origin
	st.State = domain.StatePaused
	st.PositionMs = snap.PositionMs
	st.PositionAt = h.clk.Now()
	st.Shuffle = snap.Shuffle
	st.Repeat = snap.Repeat
	if snap.Volume > 0 {
		// A session saved while muted would otherwise come back silent with a
		// slider that says so, which reads as broken rather than as muted.
		st.Volume = snap.Volume
	}
	st.Version++
	st.Epoch++
}

// Register adds a Device. The first one to register takes ownership, so a
// single-device setup needs no explicit transfer.
func (h *Hub) Register(id, name string, caps Capabilities) Device {
	h.mu.Lock()
	defer h.mu.Unlock()

	dev := &Device{ID: id, Name: name, Caps: caps, LastSeen: h.clk.Now()}
	h.devices[id] = dev

	if h.core.state.OwnerDeviceID == "" {
		h.core.state.OwnerDeviceID = id
		h.core.SetCapabilities(caps)
		dev.Owner = true
	}
	h.broadcastLocked()
	return *dev
}

// Unregister removes a Device.
//
// When the owner leaves, ownership passes to another Device if one is present.
// Playback then continues there rather than stopping because a window closed,
// which is the behaviour that makes handoff feel reliable.
func (h *Hub) Unregister(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	delete(h.devices, id)
	if h.core.state.OwnerDeviceID != id {
		h.broadcastLocked()
		return
	}

	h.core.state.OwnerDeviceID = ""
	for otherID, dev := range h.devices {
		h.core.state.OwnerDeviceID = otherID
		dev.Owner = true
		h.core.SetCapabilities(dev.Caps)
		// A new owner resolves its own stream, so the epoch advances and any
		// report still in flight from the old owner is discarded.
		h.core.state.Epoch++
		break
	}
	if h.core.state.OwnerDeviceID == "" {
		// Nothing left to play on.
		h.core.state.State = domain.StatePaused
	}
	h.broadcastLocked()
}

// Command applies an intent and fans out the result.
//
// deviceID identifies the caller. Any Device may control playback — that is the
// point of a remote — but only the owner's engine receives targets.
func (h *Hub) Command(ctx context.Context, deviceID string, cmd Command) (Reject, error) {
	h.mu.Lock()

	if dev, ok := h.devices[deviceID]; ok {
		dev.LastSeen = h.clk.Now()
	}

	reject, logs := h.core.Apply(cmd)
	if cmd.Kind == CmdTransfer {
		h.reassignOwnerLocked(cmd.DeviceID)
	}
	h.broadcastLocked()
	h.mu.Unlock()

	// Persist outside the lock: the Core must never wait on I/O.
	if len(logs) > 0 && h.sink != nil {
		h.sink.Record(ctx, logs)
	}
	return reject, nil
}

// EngineEvent folds a report from an owner's engine.
//
// Reports from a Device that is not the owner are discarded. Without that, a
// previous owner still winding down could advance the queue on a Device that
// is now playing something else.
func (h *Hub) EngineEvent(ctx context.Context, deviceID string, ev EngineEvent) {
	h.mu.Lock()
	if h.core.state.OwnerDeviceID != "" && h.core.state.OwnerDeviceID != deviceID {
		h.mu.Unlock()
		return
	}
	logs := h.core.HandleEngine(ev)
	h.broadcastLocked()
	h.mu.Unlock()

	if len(logs) > 0 && h.sink != nil {
		h.sink.Record(ctx, logs)
	}
}

// reassignOwnerLocked moves ownership. Caller holds the lock.
func (h *Hub) reassignOwnerLocked(to string) {
	for id, dev := range h.devices {
		dev.Owner = id == to
	}
	if dev, ok := h.devices[to]; ok {
		h.core.SetCapabilities(dev.Caps)
	}
}

// Subscribe returns a channel of projections and a cancel function.
//
// The channel is buffered and lossy: a slow subscriber drops intermediate
// states rather than stalling the hub. That is correct here because every
// projection is a complete snapshot, so a dropped one is superseded rather
// than lost.
func (h *Hub) Subscribe() (<-chan Projection, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()

	id := h.nextSubID
	h.nextSubID++
	ch := make(chan Projection, 8)
	h.subscribers[id] = ch

	// Deliver current state immediately so a new subscriber renders without
	// waiting for the next change.
	ch <- h.projectionLocked()

	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if sub, ok := h.subscribers[id]; ok {
			delete(h.subscribers, id)
			close(sub)
		}
	}
}

// Projection returns the current snapshot.
// SetSettings updates playback settings and broadcasts the new transition to
// every attached device, so a crossfade set on one takes effect on all.
func (h *Hub) SetSettings(crossfadeMs int, gapless bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.core.SetSettings(crossfadeMs, gapless)
	h.broadcastLocked()
}

func (h *Hub) Projection() Projection {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.projectionLocked()
}

func (h *Hub) projectionLocked() Projection {
	devices := make([]Device, 0, len(h.devices))
	for _, d := range h.devices {
		devices = append(devices, *d)
	}
	state := h.core.State()
	// An empty queue is an empty list, never null. A nil slice marshals to
	// JSON null, and the client indexes into this the moment it connects —
	// which is exactly when the queue is empty, so every fresh launch threw
	// before anything had gone wrong.
	if state.Queue.Items == nil {
		state.Queue.Items = []domain.Track{}
	}
	if state.Degraded == nil {
		state.Degraded = []domain.TrackFault{}
	}
	return Projection{
		FollowingRoom: h.core.following,
		State:         state,
		Target:        h.core.Target(),
		Devices:       devices,
		Caps:          h.core.Capabilities(),
	}
}

func (h *Hub) broadcastLocked() {
	p := h.projectionLocked()
	for id, ch := range h.subscribers {
		select {
		case ch <- p:
		default:
			// Subscriber is behind. Drop this snapshot: the next one
			// supersedes it, and blocking here would stall every other Device.
			_ = id
		}
	}
}

// SetCapabilities records what the owning Device's engine can do.
func (h *Hub) SetCapabilities(deviceID string, caps Capabilities) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	dev, ok := h.devices[deviceID]
	if !ok {
		return fmt.Errorf("session: unknown device %q", deviceID)
	}
	dev.Caps = caps
	if h.core.state.OwnerDeviceID == deviceID {
		h.core.SetCapabilities(caps)
	}
	h.broadcastLocked()
	return nil
}
