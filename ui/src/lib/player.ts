import { create } from "zustand";
import type { Track } from "./types";

/**
 * Local projection of the listening Session.
 *
 * The authoritative Session lives in Go as a pure reducer; this
 * store is only what the UI renders. Until the engine exists it is driven
 * locally, and when the Session core lands this store becomes the subscriber to
 * its projections rather than the owner of the state. Keeping the shape aligned
 * with the Go `Session` now is what makes that swap uneventful.
 *
 * Position is deliberately NOT kept here. It is interpolated from an anchor at
 * render time, so a 60fps scrubber costs zero re-renders.
 */

export type PlayState = "idle" | "loading" | "playing" | "paused" | "stalled";
export type RepeatMode = "off" | "one" | "all";

/** What the active engine can actually do. The UI reads capabilities rather
 *  than branching on which engine is live. */
export interface Capabilities {
  eq: boolean;
  crossfade: "none" | "approx" | "true";
  normalization: boolean;
  preciseSeek: boolean;
  /** 0 means continuous; 101 is the integer range the embedded player exposes. */
  volumeSteps: number;
}

interface PositionAnchor {
  positionMs: number;
  /** performance.now() when the anchor was taken. */
  atMs: number;
  rate: number;
}

export interface PlayerDevice {
  id: string;
  name: string;
  owner: boolean;
}

interface PlayerState {
  followingRoom: boolean;
  /** Whether the core cannot reach YouTube; playback waits meanwhile (#7). */
  offline: boolean;
  /**
   * What this player knows about the room's current entry: whether it played
   * to the end here and how long it measured. Null outside a room.
   */
  roomPlayback: { entry: string; ended: boolean; durationMs: number } | null;
  state: PlayState;
  track: Track | null;
  queue: Track[];
  index: number;
  /** Where the queue came from, for the "Next from ..." label. */
  origin: string;
  repeat: RepeatMode;
  shuffle: boolean;
  /**
   * The queue's order from before shuffle, so turning it off puts it back.
   * Local playback only; the core keeps its own when it is authoritative.
   */
  unshuffled: Track[] | null;
  volume: number;
  muted: boolean;
  anchor: PositionAnchor;
  /**
   * The playback speed in effect: the chosen one, or 1× in a Listen Together
   * room. It is the anchor's rate while playing, so everything that
   * interpolates position — the scrubber, synced lyrics, the video — moves at
   * the speed the audio does.
   */
  speed: number;
  /**
   * Whether another device is the one producing sound, this window only
   * controlling it. Speed is per device, and that one's is not ours to know,
   * so position is interpolated at 1× meanwhile; see interpolationRate.
   */
  outputElsewhere: boolean;
  capabilities: Capabilities;
  /** Audio quality of the current stream, when known. */
  quality: string;

  /**
   * Every device attached to this listening session, including this one.
   *
   * Carried in every projection and kept here so the device picker renders
   * from state rather than asking for it when opened.
   */
  devices: PlayerDevice[];

  /**
   * Whether this device's engine can equalise.
   *
   * Separate from `capabilities`, which describes the session and arrives in
   * projections: an equaliser is a property of the audio graph on *this*
   * machine. Reading it from the session left the control hidden whenever the
   * projection had not yet carried this device's capabilities.
   */
  engineEq: boolean;
  /**
   * Why playback is not proceeding, when the reason is worth saying out loud.
   *
   * Reserved for states the user can act on or wait out — a rate limit, a
   * press needed to start. A track that simply failed is shown by greying the
   * row, not by a message.
   */
  notice: string | null;

  /** Makes `tracks` the queue and plays from `index`, shuffled if shuffle is on. */
  playFrom: (tracks: Track[], index: number, origin?: string) => void;
  /** Plays another entry of the current queue, from its start. */
  playAt: (index: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (ms: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  cycleRepeat: () => void;
  toggleShuffle: () => void;
}

const idleCapabilities: Capabilities = {
  eq: false,
  crossfade: "none",
  normalization: false,
  preciseSeek: true,
  volumeSteps: 0,
};

export const usePlayer = create<PlayerState>((set, get) => ({
  followingRoom: false,
  offline: false,
  roomPlayback: null,
  state: "idle",
  track: null,
  queue: [],
  index: -1,
  origin: "",
  repeat: "off",
  shuffle: false,
  unshuffled: null,
  // Matches the core's default: half, which the slider taper makes half as loud.
  volume: 0.5,
  muted: false,
  anchor: { positionMs: 0, atMs: 0, rate: 0 },
  speed: 1,
  outputElsewhere: false,
  capabilities: idleCapabilities,
  quality: "",
  notice: null,
  devices: [],
  engineEq: false,

  playFrom: (tracks, index, origin = "") => {
    if (!tracks[index]) return;
    // As the core does: the chosen track first, the rest shuffled after it.
    const queue = get().shuffle ? shuffledAround(tracks, index) : tracks;
    set({ queue, origin, unshuffled: get().shuffle ? tracks : null });
    get().playAt(get().shuffle ? 0 : index);
  },

  playAt: (index) => {
    const track = get().queue[index];
    if (!track) return;
    set({
      index,
      track,
      state: "playing",
      anchor: { positionMs: 0, atMs: performance.now(), rate: interpolationRate(get()) },
    });
  },

  toggle: () => {
    const { state, anchor } = get();
    // Buffering is still playing: pressing the button there means pause. It
    // did nothing at all, so a stalled track could not be stopped or nudged.
    if (state === "playing" || state === "stalled" || state === "loading") {
      // Freeze the anchor at the current interpolated position.
      set({
        state: "paused",
        anchor: { positionMs: currentPosition(get()), atMs: performance.now(), rate: 0 },
      });
    } else if (state === "paused") {
      set({ state: "playing", anchor: { ...anchor, atMs: performance.now(), rate: interpolationRate(get()) } });
    }
  },

  next: () => {
    const { queue, index, repeat } = get();
    if (queue.length === 0) return;
    let nextIndex = index + 1;
    if (nextIndex >= queue.length) {
      if (repeat !== "all") {
        set({ state: "paused" });
        return;
      }
      nextIndex = 0;
    }
    get().playAt(nextIndex);
  },

  prev: () => {
    const { queue, index } = get();
    if (queue.length === 0) return;
    // Restart the current track when past the opening seconds, which is the
    // near-universal convention for a previous button.
    if (currentPosition(get()) > 3000) {
      get().seek(0);
      return;
    }
    get().playAt(Math.max(0, index - 1));
  },

  seek: (ms) =>
    set((s) => ({
      anchor: { positionMs: Math.max(0, ms), atMs: performance.now(), rate: s.state === "playing" ? interpolationRate(s) : 0 },
    })),

  setVolume: (v) => set({ volume: Math.min(2, Math.max(0, v)), muted: false }),
  toggleMute: () => set((s) => ({ muted: !s.muted })),
  cycleRepeat: () =>
    set((s) => ({ repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off" })),
  /*
   * Reorders the queue, not just the button. It used to flip the flag and
   * nothing else, so without the core shuffle lit up and played in order.
   * Turning it on keeps the playing track and shuffles the rest after it;
   * turning it off restores the saved order with the same track current.
   */
  toggleShuffle: () =>
    set((s) => {
      if (!s.shuffle) {
        if (s.index < 0 || !s.queue[s.index]) return { shuffle: true };
        return { shuffle: true, unshuffled: s.queue, queue: shuffledAround(s.queue, s.index), index: 0 };
      }
      const saved = s.unshuffled;
      const at = saved && s.track ? saved.findIndex((t) => t.id === s.track!.id) : -1;
      if (!saved || at < 0) return { shuffle: false, unshuffled: null };
      return { shuffle: false, unshuffled: null, queue: saved, index: at };
    }),
}));

/** The track at `index` first, then every other track in random order. */
function shuffledAround(tracks: Track[], index: number): Track[] {
  const rest = tracks.filter((_, i) => i !== index);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return [tracks[index]!, ...rest];
}

/**
 * How fast position advances while playing: this device's speed, or 1× while
 * another device is the one playing. Every anchor taken while playing uses
 * this, so none of them runs the scrubber at a speed that is not being heard.
 */
export function interpolationRate(s: Pick<PlayerState, "speed" | "outputElsewhere">): number {
  return s.outputElsewhere ? 1 : s.speed;
}

/**
 * Interpolate the playback position from the anchor.
 *
 * Read this in an animation frame rather than subscribing to it: position is
 * not state, it is a function of time since the last anchor.
 */
export function currentPosition(s: Pick<PlayerState, "anchor" | "track">): number {
  const { positionMs, atMs, rate } = s.anchor;
  const elapsed = rate === 0 ? 0 : (performance.now() - atMs) * rate;
  const total = positionMs + elapsed;
  const duration = s.track?.durationMs ?? 0;
  return duration > 0 ? Math.min(total, duration) : total;
}
