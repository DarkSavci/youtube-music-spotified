package session

import (
	"math/rand"
	"time"

	"spotifier/internal/clock"
	"spotifier/internal/domain"
)

// maxConsecutiveFaults is how many failures in a row the core will skip past
// before it stops and shows what went wrong.
//
// Without a limit, one unavailable region or an expired session turns into the
// queue silently racing to the end. Three is enough to step over the odd
// blocked track without hiding a systemic failure.
const maxConsecutiveFaults = 3

// Core owns the semantics of listening.
//
// It performs no I/O. Every method is a deterministic function of the current
// state, the argument, and the injected Clock — which is what allows gapless
// scheduling and the failure ladder to be unit-tested without audio, sockets
// or a browser.
//
// Not safe for concurrent use; the owner serialises access.
type Core struct {
	clk      clock.Clock
	settings Settings

	state domain.Session
	caps  Capabilities

	// userChange is whether the listener chose the current track (a play, a
	// skip, going back) rather than the last one ending. Skips cut; only an
	// ending crossfades.
	userChange bool
	following  bool // Ephemeral: never restored after an application restart.

	// unshuffled is the queue as it was before shuffle reordered it, so
	// turning shuffle off puts it back. Shuffle rewrites the queue itself
	// rather than keeping a hidden play order: the queue the listener sees
	// and edits has to be the order that plays, or moving and removing
	// tracks changes a list playback ignores.
	unshuffled []domain.Track

	// Progress accounting for the current track.
	playedMs          int64
	lastPositionMs    int64
	loggedCurrent     bool
	consecutiveFaults int

	rng *rand.Rand
}

// New builds a Core. A nil Clock uses the system clock.
func New(clk clock.Clock, settings Settings, seed int64) *Core {
	if clk == nil {
		clk = clock.System{}
	}
	if settings.ListenedThreshold == 0 {
		settings.ListenedThreshold = DefaultSettings().ListenedThreshold
	}
	return &Core{
		clk:      clk,
		settings: settings,
		rng:      rand.New(rand.NewSource(seed)),
		state: domain.Session{
			State:  domain.StateIdle,
			Repeat: domain.RepeatOff,
			// Half, not full: a first launch that starts at full volume is
			// loud enough to startle. With the perceptual slider taper,
			// halfway is ten decibels down, which is half as loud.
			Volume: DefaultVolume,
		},
	}
}

// DefaultVolume is the level a new session starts at, before anything is
// restored or chosen.
const DefaultVolume = 0.5

// State returns a copy of the current Session. Callers may not mutate the
// returned queue.
func (c *Core) State() domain.Session { return c.state }

// Capabilities returns what the attached engine can do.
func (c *Core) Capabilities() Capabilities { return c.caps }

// SetCapabilities records the active engine's abilities. Changing engines mid
// session is normal — falling back from native to embedded, for instance — so
// this bumps the version to force a re-render of capability-gated UI.
func (c *Core) SetCapabilities(caps Capabilities) {
	c.caps = caps
	c.state.Version++
}

// Target is the state the engine should reconcile toward.
func (c *Core) Target() Target {
	cur := c.state.Queue.Current()
	if cur == nil {
		return Target{Epoch: c.state.Epoch, Volume: c.state.Volume}
	}
	t := Target{
		Epoch:      c.state.Epoch,
		VideoID:    cur.ID,
		StartAtMs:  c.state.PositionMs,
		Playing:    c.playIntent(),
		Volume:     c.state.Volume,
		Transition: c.transition(),
		UserChange: c.userChange,
	}
	// Name the next track so the engine can have it ready. Without this there
	// is nothing to be gapless *with*. Repeat one has no next track: naming
	// one let the engine fade into it, or start it when this one ended, while
	// the session replayed the current track — the sound moved on and the
	// player did not.
	if next := c.peekNext(); !c.following && next != nil && c.state.Repeat != domain.RepeatOne {
		t.PreloadVideoID = next.ID
	}
	return t
}

// transition picks how to move into the next track, honouring both the user's
// setting and what the engine can actually do.
func (c *Core) transition() Transition {
	if c.following {
		return Transition{Kind: "cut"}
	}
	if c.settings.CrossfadeMs > 0 && c.caps.Crossfade != "none" {
		return Transition{Kind: "crossfade", Ms: c.settings.CrossfadeMs}
	}
	if c.settings.Gapless {
		return Transition{Kind: "gapless"}
	}
	return Transition{Kind: "cut"}
}

// ---------- commands ----------

// Apply folds a Command into the Session, returning why it was rejected (empty
// when applied) and any play-log entries the change produced.
func (c *Core) Apply(cmd Command) (Reject, []LogEntry) {
	if c.following && cmd.Kind != CmdFollow && cmd.Kind != CmdLeaveRoom && cmd.Kind != CmdSetVolume {
		return RejectNotOwner, nil
	}
	switch cmd.Kind {
	case CmdFollow:
		return c.followRoom(cmd)
	case CmdLeaveRoom:
		if c.following {
			c.following = false
			c.state.State = domain.StatePaused
			c.state.PositionAt = c.clk.Now()
			c.bump()
		}
		return RejectNone, nil
	case CmdVariant:
		return c.switchVariant(cmd)
	case CmdPlay:
		return c.play(cmd)
	case CmdToggle:
		return c.toggle()
	case CmdNext:
		return c.skip(+1, true)
	case CmdPrev:
		return c.prev()
	case CmdSeek:
		return c.seek(cmd.PositionMs)
	case CmdSetRepeat:
		c.state.Repeat = cmd.Repeat
		c.bump()
		return RejectNone, nil
	case CmdSetShuffle:
		return c.setShuffle(cmd.Shuffle)
	case CmdSetVolume:
		c.state.Volume = clampVolume(cmd.Volume)
		c.bump()
		return RejectNone, nil
	case CmdEnqueue:
		return c.enqueue(cmd)
	case CmdRemove:
		return c.remove(cmd.At)
	case CmdMove:
		return c.move(cmd.From, cmd.To)
	case CmdJump:
		return c.jump(cmd.At)
	case CmdTransfer:
		c.state.OwnerDeviceID = cmd.DeviceID
		// A new owner resolves its own stream, so the epoch advances and any
		// report still in flight from the previous owner is discarded.
		c.state.Epoch++
		c.bump()
		return RejectNone, nil
	default:
		return RejectUnknown, nil
	}
}

func (c *Core) play(cmd Command) (Reject, []LogEntry) {
	if len(cmd.Tracks) == 0 {
		return RejectEmptyQueue, nil
	}
	idx := cmd.StartIndex
	if idx < 0 || idx >= len(cmd.Tracks) {
		return RejectOutOfRange, nil
	}

	logs := c.closeOutCurrent(false)

	c.state.Queue = domain.Queue{Items: cmd.Tracks, Index: idx, Origin: cmd.Origin}
	c.state.Degraded = nil
	c.consecutiveFaults = 0
	c.unshuffled = nil
	if c.state.Shuffle {
		c.reshuffle(idx)
		idx = c.state.Queue.Index
	}
	c.userChange = true
	c.startTrack(idx, 0)
	return RejectNone, logs
}

func (c *Core) toggle() (Reject, []LogEntry) {
	switch c.state.State {
	case domain.StatePlaying:
		c.state.State = domain.StatePaused
	case domain.StatePaused, domain.StateStalled:
		c.state.State = domain.StatePlaying
	default:
		if c.state.Queue.Current() == nil {
			return RejectEmptyQueue, nil
		}
		c.state.State = domain.StatePlaying
	}
	c.state.PositionAt = c.clk.Now()
	c.bump()
	return RejectNone, nil
}

// skip moves by delta. byUser distinguishes a deliberate skip from the queue
// advancing on its own, which matters for what the play log records.
func (c *Core) skip(delta int, byUser bool) (Reject, []LogEntry) {
	if len(c.state.Queue.Items) == 0 {
		return RejectEmptyQueue, nil
	}
	logs := c.closeOutCurrent(false)

	next, ok := c.nextIndex(delta)
	if !ok {
		// The queue is exhausted and not repeating: stop at the end rather
		// than wrapping, and hold the last track so the bar still shows it.
		c.state.State = domain.StatePaused
		c.state.PositionMs = 0
		c.bump()
		return RejectNone, logs
	}
	c.userChange = byUser
	c.startTrack(next, 0)
	return RejectNone, logs
}

func (c *Core) prev() (Reject, []LogEntry) {
	if len(c.state.Queue.Items) == 0 {
		return RejectEmptyQueue, nil
	}
	// Past the opening seconds, "previous" restarts the current track. This is
	// the near-universal convention and it is what people expect from a
	// double-press.
	if c.positionNow() > 3000 {
		return c.seek(0)
	}
	return c.skip(-1, true)
}

func (c *Core) seek(ms int64) (Reject, []LogEntry) {
	cur := c.state.Queue.Current()
	if cur == nil {
		return RejectEmptyQueue, nil
	}
	if ms < 0 {
		ms = 0
	}
	if cur.DurationMs > 0 && ms > cur.DurationMs {
		ms = cur.DurationMs
	}
	c.state.PositionMs = ms
	c.state.PositionAt = c.clk.Now()
	c.lastPositionMs = ms
	c.bump()
	return RejectNone, nil
}

func (c *Core) setShuffle(on bool) (Reject, []LogEntry) {
	if c.state.Shuffle == on {
		return RejectNone, nil
	}
	c.state.Shuffle = on
	if on {
		c.reshuffle(c.state.Queue.Index)
	} else {
		c.unshuffle()
	}
	c.bump()
	return RejectNone, nil
}

func (c *Core) enqueue(cmd Command) (Reject, []LogEntry) {
	if len(cmd.Insert) == 0 {
		return RejectNone, nil
	}
	at := cmd.At
	if at < 0 || at > len(c.state.Queue.Items) {
		at = len(c.state.Queue.Items)
	}
	items := c.state.Queue.Items
	next := make([]domain.Track, 0, len(items)+len(cmd.Insert))
	next = append(next, items[:at]...)
	next = append(next, cmd.Insert...)
	next = append(next, items[at:]...)
	c.state.Queue.Items = next
	// Keep the current track current when inserting above it.
	if at <= c.state.Queue.Index {
		c.state.Queue.Index += len(cmd.Insert)
	}
	// Queued tracks keep their place when shuffle is turned off, too.
	if c.unshuffled != nil {
		c.unshuffled = append(c.unshuffled, cmd.Insert...)
	}
	c.bump()
	return RejectNone, nil
}

func (c *Core) remove(at int) (Reject, []LogEntry) {
	items := c.state.Queue.Items
	if at < 0 || at >= len(items) {
		return RejectOutOfRange, nil
	}
	removed := items[at].ID
	c.state.Queue.Items = append(items[:at:at], items[at+1:]...)
	for i, t := range c.unshuffled {
		if t.ID == removed {
			c.unshuffled = append(c.unshuffled[:i:i], c.unshuffled[i+1:]...)
			break
		}
	}

	switch {
	case at < c.state.Queue.Index:
		c.state.Queue.Index--
	case at == c.state.Queue.Index:
		// Removing what is playing: hold the position so the next track slides
		// into it, and clamp when the tail was removed.
		c.userChange = true
		if c.state.Queue.Index >= len(c.state.Queue.Items) {
			c.state.Queue.Index = len(c.state.Queue.Items) - 1
		}
		if c.state.Queue.Index < 0 {
			c.state.Queue.Index = 0
			c.state.State = domain.StateIdle
		}
	}
	c.bump()
	return RejectNone, nil
}

// jump plays another entry of the queue — one already played, or one further
// on — without rebuilding it. A play command with the same list would do the
// same, but it re-shuffles a shuffled queue.
func (c *Core) jump(at int) (Reject, []LogEntry) {
	if at < 0 || at >= len(c.state.Queue.Items) {
		return RejectOutOfRange, nil
	}
	logs := c.closeOutCurrent(false)
	c.userChange = true
	c.startTrack(at, 0)
	return RejectNone, logs
}

func (c *Core) move(from, to int) (Reject, []LogEntry) {
	items := c.state.Queue.Items
	if from < 0 || from >= len(items) || to < 0 || to >= len(items) {
		return RejectOutOfRange, nil
	}
	if from == to {
		return RejectNone, nil
	}
	// Track where the playing item ends up, so reordering never changes what
	// is sounding.
	currentID := ""
	if cur := c.state.Queue.Current(); cur != nil {
		currentID = cur.ID
	}

	item := items[from]
	rest := append(items[:from:from], items[from+1:]...)
	next := make([]domain.Track, 0, len(items))
	next = append(next, rest[:to]...)
	next = append(next, item)
	next = append(next, rest[to:]...)
	c.state.Queue.Items = next

	for i := range next {
		if next[i].ID == currentID {
			c.state.Queue.Index = i
			break
		}
	}
	c.bump()
	return RejectNone, nil
}

// ---------- engine events ----------

// HandleEngine folds a report from the engine into the Session.
//
// Playback failure never surfaces as a command error: it arrives here, the
// core records it, advances by policy, and emits a log entry. Nothing throws
// at the caller.
func (c *Core) HandleEngine(ev EngineEvent) []LogEntry {
	// Discard anything from a superseded track or a previous owner.
	if ev.Epoch != c.state.Epoch {
		return nil
	}

	switch ev.Kind {
	case EvLoaded:
		c.consecutiveFaults = 0
		if ev.DurationMs > 0 {
			if cur := c.currentPtr(); cur != nil && cur.DurationMs == 0 {
				cur.DurationMs = ev.DurationMs
			}
		}
		// Loaded is not a request to play. A track loading while paused — the
		// last track, restored when the app opens — stays paused until the
		// listener presses play; only one that was waiting to play moves on.
		if c.playIntent() {
			c.state.State = domain.StatePlaying
		}
		c.state.PositionAt = c.clk.Now()
		c.bump()

	case EvPosition:
		// Accumulate listened time from forward progress only, so scrubbing
		// backwards and forwards cannot inflate it.
		if ev.PositionMs > c.lastPositionMs {
			c.playedMs += ev.PositionMs - c.lastPositionMs
		}
		c.lastPositionMs = ev.PositionMs
		c.state.PositionMs = ev.PositionMs
		c.state.PositionAt = c.clk.Now()
		// A track the catalogue gave no length learns it here. EvLoaded is not
		// enough: with gapless or crossfade the next track loads on the idle
		// deck, and that report is dropped, so it would play with no length.
		// Position reports always come from the deck that is playing.
		if ev.DurationMs > 0 {
			if cur := c.currentPtr(); cur != nil && cur.DurationMs == 0 {
				cur.DurationMs = ev.DurationMs
			}
		}
		if c.state.State == domain.StateStalled {
			c.state.State = domain.StatePlaying
		}
		c.bump()

	case EvStalled:
		// Buffering while paused is not stalling: nothing is meant to sound.
		if c.playIntent() {
			c.state.State = domain.StateStalled
			c.bump()
		}

	case EvEnded:
		logs := c.closeOutCurrent(true)
		if c.following {
			if track := c.state.Queue.Current(); track != nil && track.DurationMs > 0 {
				c.state.PositionMs = track.DurationMs
				c.lastPositionMs = track.DurationMs
			}
			c.state.State = domain.StatePaused
			c.bump()
			return logs
		}
		_, more := c.advanceAfterEnd()
		return append(logs, more...)

	case EvBlocked:
		// Pause rather than advance. The target stops asking the engine to
		// play, so the next press — which carries the gesture the browser
		// wanted — starts the same track instead of one four places later.
		c.state.State = domain.StatePaused
		c.consecutiveFaults = 0
		c.bump()

	case EvFailed:
		return c.handleFailure(ev.Reason)
	}
	return nil
}

/*
playIntent is whether the user wants sound, as opposed to whether sound is
currently coming out.

The Target carries intent, not observation. Deriving it from the observed
state deadlocked on every seek: buffering sets the state to stalled, a stalled
target told the engine to pause, and a paused engine stops fetching and stops
reporting — so the position report that clears a stall could never arrive.
Seeking always buffers, so seeking always broke playback.

Loading and stalled are both "trying to play". Only an explicit pause, an
empty queue or an autoplay refusal means the engine should stop.
*/
func (c *Core) playIntent() bool {
	switch c.state.State {
	case domain.StatePlaying, domain.StateStalled, domain.StateLoading:
		return true
	default:
		return false
	}
}

/*
SetSettings replaces the playback settings.

Crossfade length and gapless are the user's choices, and the core is what
decides a transition, so they have to be able to change while it is running —
they were fixed at construction, which left the Settings screen writing to a
value nothing read.

ListenedThreshold is deliberately not settable: it defines what counts as a
listen in the Play log, and letting it move would make the statistics
incomparable with themselves over time.
*/
func (c *Core) SetSettings(crossfadeMs int, gapless bool) {
	if crossfadeMs < 0 {
		crossfadeMs = 0
	}
	c.settings.CrossfadeMs = crossfadeMs
	c.settings.Gapless = gapless
	c.bump()
}

// firstArtistID and firstArtistName name the credited artist, which is the
// one the statistics group by. A track with none is left blank rather than
// guessed at.
func firstArtistID(t *domain.Track) string {
	if t == nil || len(t.Artists) == 0 {
		return ""
	}
	return t.Artists[0].ID
}

// albumID and albumName name the album a track is from, blank when it has none.
func albumID(t *domain.Track) string {
	if t == nil || t.Album == nil {
		return ""
	}
	return t.Album.ID
}

func albumName(t *domain.Track) string {
	if t == nil || t.Album == nil {
		return ""
	}
	return t.Album.Name
}

func firstArtistName(t *domain.Track) string {
	if t == nil || len(t.Artists) == 0 {
		return ""
	}
	return t.Artists[0].Name
}

// advanceAfterEnd moves on when a track finishes, honouring repeat-one.
func (c *Core) advanceAfterEnd() (Reject, []LogEntry) {
	if c.state.Repeat == domain.RepeatOne {
		c.userChange = false
		c.startTrack(c.state.Queue.Index, 0)
		return RejectNone, nil
	}
	return c.skip(+1, false)
}

// handleFailure walks the failure ladder: record, log, advance, and stop after
// too many in a row.
func (c *Core) handleFailure(reason string) []LogEntry {
	cur := c.state.Queue.Current()
	if cur == nil {
		return nil
	}
	c.state.Degraded = append(c.state.Degraded, domain.TrackFault{
		Index:  c.state.Queue.Index,
		Reason: reason,
	})
	if p := c.currentPtr(); p != nil {
		p.Playable = false
	}
	logs := []LogEntry{{
		TrackID:    cur.ID,
		Title:      cur.Title,
		ArtistID:   firstArtistID(cur),
		Artist:     firstArtistName(cur),
		Artwork:    cur.Artwork.AtLeast(226).URL,
		AlbumID:    albumID(cur),
		Album:      albumName(cur),
		At:         c.clk.Now(),
		PlayedMs:   c.playedMs,
		Failed:     true,
		FailReason: reason,
		Origin:     c.state.Queue.Origin,
	}}
	c.loggedCurrent = true

	c.consecutiveFaults++
	if c.following || c.consecutiveFaults >= maxConsecutiveFaults {
		// Stop rather than race to the end of the queue. Something systemic is
		// wrong and the user should see it.
		c.state.State = domain.StatePaused
		c.bump()
		return logs
	}
	_, more := c.skip(+1, false)
	return append(logs, more...)
}

// ---------- internals ----------

// startTrack makes index current and begins playback from ms.
//
// Every track change advances the Epoch, which is what invalidates reports
// still in flight from the track being replaced.
func (c *Core) startTrack(index int, ms int64) {
	c.state.Queue.Index = index
	c.state.PositionMs = ms
	c.state.PositionAt = c.clk.Now()
	c.state.State = domain.StatePlaying
	c.state.Epoch++
	c.playedMs = 0
	c.lastPositionMs = ms
	c.loggedCurrent = false
	c.bump()
}

// closeOutCurrent emits a play-log entry for the outgoing track when it was
// listened to for long enough to count.
func (c *Core) closeOutCurrent(completed bool) []LogEntry {
	cur := c.state.Queue.Current()
	if cur == nil || c.loggedCurrent {
		return nil
	}
	threshold := c.settings.ListenedThreshold.Milliseconds()
	// A track shorter than the threshold counts when played to the end.
	if cur.DurationMs > 0 && cur.DurationMs < threshold {
		threshold = cur.DurationMs
	}
	if c.playedMs < threshold && !completed {
		return nil
	}
	c.loggedCurrent = true
	return []LogEntry{{
		TrackID:   cur.ID,
		Title:     cur.Title,
		ArtistID:  firstArtistID(cur),
		Artist:    firstArtistName(cur),
		Artwork:   cur.Artwork.AtLeast(226).URL,
		AlbumID:   albumID(cur),
		Album:     albumName(cur),
		At:        c.clk.Now(),
		PlayedMs:  c.playedMs,
		Completed: completed,
		Origin:    c.state.Queue.Origin,
	}}
}

// nextIndex resolves the next playback position, honouring shuffle and repeat.
// ok is false when the queue is exhausted.
func (c *Core) nextIndex(delta int) (int, bool) {
	n := len(c.state.Queue.Items)
	if n == 0 {
		return 0, false
	}
	idx := c.state.Queue.Index + delta
	switch {
	case idx >= n:
		if c.state.Repeat != domain.RepeatAll {
			return 0, false
		}
		idx = 0
	case idx < 0:
		idx = 0
	}
	return idx, true
}

// peekNext is nextIndex without mutating anything, for preload.
func (c *Core) peekNext() *domain.Track {
	idx, ok := c.nextIndex(+1)
	if !ok || idx < 0 || idx >= len(c.state.Queue.Items) {
		return nil
	}
	return &c.state.Queue.Items[idx]
}

// reshuffle puts the current track first and shuffles everything else after
// it, so turning shuffle on never interrupts what is already playing.
func (c *Core) reshuffle(current int) {
	items := c.state.Queue.Items
	if current < 0 || current >= len(items) {
		return
	}
	if c.unshuffled == nil {
		c.unshuffled = append([]domain.Track(nil), items...)
	}
	rest := make([]domain.Track, 0, len(items)-1)
	rest = append(rest, items[:current]...)
	rest = append(rest, items[current+1:]...)
	c.rng.Shuffle(len(rest), func(i, j int) { rest[i], rest[j] = rest[j], rest[i] })
	c.state.Queue.Items = append([]domain.Track{items[current]}, rest...)
	c.state.Queue.Index = 0
}

// unshuffle restores the order from before shuffle, keeping the current
// track current. Edits made while shuffled are carried over: removals are
// already gone from the saved order and additions were appended to it.
func (c *Core) unshuffle() {
	saved := c.unshuffled
	c.unshuffled = nil
	if saved == nil || len(saved) != len(c.state.Queue.Items) {
		return
	}
	cur := c.state.Queue.Current()
	if cur == nil {
		return
	}
	for i, t := range saved {
		if t.ID == cur.ID {
			c.state.Queue.Items = saved
			c.state.Queue.Index = i
			return
		}
	}
}

func (c *Core) currentPtr() *domain.Track {
	if c.state.Queue.Index < 0 || c.state.Queue.Index >= len(c.state.Queue.Items) {
		return nil
	}
	return &c.state.Queue.Items[c.state.Queue.Index]
}

// positionNow interpolates the position from the anchor, which is how every
// consumer derives it rather than receiving events at frame rate.
func (c *Core) positionNow() int64 {
	if c.state.State != domain.StatePlaying {
		return c.state.PositionMs
	}
	elapsed := c.clk.Now().Sub(c.state.PositionAt)
	if elapsed < 0 {
		elapsed = 0
	}
	return c.state.PositionMs + elapsed.Milliseconds()
}

func (c *Core) bump() { c.state.Version++ }

// MaxVolume is 200%: past full scale when the listener turns on volume
// boost. Whether boost is on is the client's business; the core only keeps
// the level inside what any client can ask for.
const MaxVolume = 2.0

func clampVolume(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > MaxVolume {
		return MaxVolume
	}
	return v
}

var _ = time.Second

// followRoom applies a single authoritative room snapshot without changing
// local volume, repeat/shuffle preferences, or inventing listening progress.
func (c *Core) followRoom(cmd Command) (Reject, []LogEntry) {
	if len(cmd.Tracks) > 1 || cmd.PositionMs < 0 || cmd.PositionMs > 86400000 {
		return RejectOutOfRange, nil
	}
	var logs []LogEntry
	current := c.state.Queue.Current()
	wasFollowing := c.following
	if len(cmd.Tracks) == 1 && cmd.Tracks[0].ID == "" {
		return RejectOutOfRange, nil
	}
	c.following = true
	if len(cmd.Tracks) == 0 {
		logs = c.closeOutCurrent(false)
		c.state.Queue = domain.Queue{}
		c.state.State = domain.StateIdle
		c.state.Epoch++
		c.bump()
		return RejectNone, logs
	}
	track := cmd.Tracks[0]
	if !wasFollowing || current == nil || current.ID != track.ID || !current.Playable {
		logs = c.closeOutCurrent(false)
		c.state.Queue = domain.Queue{Items: []domain.Track{track}, Index: 0, Origin: "Listen Together"}
		c.unshuffled = nil
		c.state.Degraded = nil
		c.userChange = true
		c.startTrack(0, cmd.PositionMs)
	}
	c.seek(cmd.PositionMs)
	c.state.State = domain.StatePaused
	if cmd.Playing {
		c.state.State = domain.StatePlaying
	}
	c.bump()
	return RejectNone, logs
}

// switchVariant replaces only the current queue slot and cuts to the matching
// song/video edit. Other queue entries, repeat, shuffle and volume survive.
func (c *Core) switchVariant(cmd Command) (Reject, []LogEntry) {
	current := c.state.Queue.Current()
	if current == nil {
		return RejectEmptyQueue, nil
	}
	if len(cmd.Tracks) != 1 || cmd.ExpectedID != current.ID || cmd.Tracks[0].ID == "" || !cmd.Tracks[0].Playable {
		return RejectOutOfRange, nil
	}
	track := cmd.Tracks[0]
	pos := c.positionNow()
	if track.DurationMs > 0 && pos >= track.DurationMs {
		pos = max(int64(0), track.DurationMs-5000)
	}
	if pos < 0 {
		pos = 0
	}
	paused := !c.playIntent()
	oldID := current.ID
	carriedPlay := c.playedMs
	logs := c.closeOutCurrent(false)
	if len(logs) > 0 {
		carriedPlay = 0
	}
	c.state.Queue.Items[c.state.Queue.Index] = track
	for i := range c.unshuffled {
		if c.unshuffled[i].ID == oldID {
			c.unshuffled[i] = track
			break
		}
	}
	c.userChange = true
	c.consecutiveFaults = 0
	c.state.Degraded = nil
	c.startTrack(c.state.Queue.Index, pos)
	c.playedMs += carriedPlay
	if paused {
		c.state.State = domain.StatePaused
	}
	return RejectNone, logs
}
