// Package session owns the semantics of listening.
//
// The core is a pure reducer: (state, Command) -> (state, intents, log
// entries), with no I/O, no timers and no HTTP. Queue arithmetic, shuffle
// derivation, repeat behaviour, the failure ladder, gapless scheduling and the
// play-log threshold all live here as ordinary functions, which makes the
// hardest logic in the product the most testable part of it.
//
// The engine is deliberately dumb. It is handed the state it should be in and
// reconciles toward it, rather than receiving a stream of imperative commands —
// so a target is idempotent, safe to re-send after a reconnect, and lets the
// engine schedule its own crossfade instead of being driven across a process
// boundary.
package session

import (
	"time"

	"spotifier/internal/domain"
)

// ---------- commands ----------

// CommandKind tags a Command.
type CommandKind string

const (
	CmdPlay       CommandKind = "play"
	CmdToggle     CommandKind = "toggle"
	CmdNext       CommandKind = "next"
	CmdPrev       CommandKind = "prev"
	CmdSeek       CommandKind = "seek"
	CmdSetRepeat  CommandKind = "set_repeat"
	CmdSetShuffle CommandKind = "set_shuffle"
	CmdSetVolume  CommandKind = "set_volume"
	CmdEnqueue    CommandKind = "enqueue"
	CmdRemove     CommandKind = "remove"
	CmdMove       CommandKind = "move"
	// CmdJump plays the queue entry at At, keeping the queue as it is.
	CmdJump     CommandKind = "jump"
	CmdTransfer CommandKind = "transfer"
)

// Command is an intent to change the Session. Exactly one payload field is
// meaningful, selected by Kind.
type Command struct {
	Kind CommandKind

	// Play
	Tracks     []domain.Track
	StartIndex int
	Origin     string

	// Seek
	PositionMs int64

	// Enqueue / Remove / Move
	Insert []domain.Track
	At     int
	From   int
	To     int

	Repeat  domain.RepeatMode
	Shuffle bool
	Volume  float64

	// Transfer
	DeviceID string
}

// Reject explains why a Command was not applied. An empty value means it was.
type Reject string

const (
	RejectNone       Reject = ""
	RejectEmptyQueue Reject = "empty_queue"
	RejectOutOfRange Reject = "out_of_range"
	RejectNotOwner   Reject = "not_owner"
	RejectUnknown    Reject = "unknown_command"
)

// ---------- engine ----------

// Transition says how the engine should move between tracks.
type Transition struct {
	Kind string // "cut" | "gapless" | "crossfade"
	Ms   int    // crossfade duration, when Kind is crossfade
}

// Target is the state the engine should reconcile toward.
//
// Declarative rather than imperative: re-sending an unchanged Target is a
// no-op, which makes reconnect and recovery trivial.
type Target struct {
	// Epoch stamps this Target. Engine reports carrying an older Epoch are
	// discarded, which is what stops a swapped-out engine's late "ended" from
	// skipping the track that just started.
	Epoch uint64

	// VideoID is empty when nothing should be loaded.
	VideoID   string
	StartAtMs int64
	Playing   bool

	// PreloadVideoID is the next track, resolved ahead of time so a gapless or
	// crossfaded transition has something ready.
	PreloadVideoID string

	Volume     float64
	Transition Transition

	// UserChange is set when the listener moved to this track themselves —
	// played it, skipped to it, went back to it. The engine cuts to such a
	// track at once; Transition applies when a track ends on its own.
	UserChange bool
}

// EngineEventKind tags an EngineEvent.
type EngineEventKind string

const (
	EvLoaded   EngineEventKind = "loaded"
	EvPosition EngineEventKind = "position"
	EvEnded    EngineEventKind = "ended"
	EvFailed   EngineEventKind = "failed"
	EvStalled  EngineEventKind = "stalled"
	// EvBlocked means the engine is ready but was refused permission to start
	// — a browser autoplay policy wanting a user gesture. It is deliberately
	// not a failure: the track is fine, so it must not be marked unplayable,
	// logged as a failed play, or skipped past.
	EvBlocked EngineEventKind = "blocked"
)

// EngineEvent is what the engine reports back.
type EngineEvent struct {
	Kind EngineEventKind

	// Epoch the engine was acting on. Stale events are ignored.
	Epoch uint64

	PositionMs int64
	DurationMs int64

	// Reason describes a failure, e.g. "403", "unavailable", "not_embeddable".
	Reason string
}

// ---------- play log ----------

// LogEntry records something worth remembering about listening. Emitted by the
// core and written by the Control plane; the core itself performs no I/O.
type LogEntry struct {
	TrackID string

	/*
	 * Title and artist travel with the entry.
	 *
	 * The play log is read back months later to build "Your listening" and
	 * the generated mixes, by which time the queue that produced it is long
	 * gone — and a catalogue lookup per row would be thousands of requests to
	 * render one page. Denormalised on purpose: without these the statistics
	 * pages and every mix came out as a list of blank rows.
	 */
	Title    string
	ArtistID string
	Artist   string
	// Artwork is the cover's URL, for the same reason: On Repeat is built
	// from this log and has nothing else to show.
	Artwork string
	// Album is what Top albums and the album lookup group by. Empty for a
	// track that has none (a video, an upload), which those simply skip.
	AlbumID string
	Album   string

	At         time.Time
	PlayedMs   int64
	Completed  bool
	Failed     bool
	FailReason string
	Origin     string
}

// ---------- capabilities ----------

// Capabilities describe what the active engine can do.
//
// Carried as data rather than expressed as a wider interface, so two very
// unalike engines share one seam and the UI reads a flag instead of branching
// on which engine is live.
type Capabilities struct {
	EQ            bool
	Crossfade     string // "none" | "approx" | "true"
	Normalization bool
	PreciseSeek   bool
	// VolumeSteps is 0 for continuous volume, or the number of discrete steps
	// an embedded player exposes.
	VolumeSteps int
}

// Settings are user preferences the core needs to schedule transitions.
type Settings struct {
	CrossfadeMs int
	Gapless     bool
	// ListenedThreshold is how much of a track must play before it counts as
	// listened. Thirty seconds, or the whole track if it is shorter.
	ListenedThreshold time.Duration
}

// DefaultSettings are used when none are supplied.
func DefaultSettings() Settings {
	return Settings{
		CrossfadeMs:       0,
		Gapless:           true,
		ListenedThreshold: 30 * time.Second,
	}
}
