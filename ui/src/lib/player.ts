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
  state: PlayState;
  track: Track | null;
  queue: Track[];
  index: number;
  /** Where the queue came from, for the "Next from ..." label. */
  origin: string;
  repeat: RepeatMode;
  shuffle: boolean;
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

  playFrom: (tracks: Track[], index: number, origin?: string) => void;
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
  state: "idle",
  track: null,
  queue: [],
  index: -1,
  origin: "",
  repeat: "off",
  shuffle: false,
  // Matches the core's default: half, which the slider taper makes half as loud.
  volume: 0.5,
  muted: false,
  anchor: { positionMs: 0, atMs: 0, rate: 0 },
  speed: 1,
  capabilities: idleCapabilities,
  quality: "",
  notice: null,
  devices: [],
  engineEq: false,

  playFrom: (tracks, index, origin = "") => {
    const track = tracks[index];
    if (!track) return;
    set({
      queue: tracks,
      index,
      track,
      origin,
      state: "playing",
      anchor: { positionMs: 0, atMs: performance.now(), rate: get().speed },
    });
  },

  toggle: () => {
    const { state, anchor } = get();
    if (state === "playing") {
      // Freeze the anchor at the current interpolated position.
      set({
        state: "paused",
        anchor: { positionMs: currentPosition(get()), atMs: performance.now(), rate: 0 },
      });
    } else if (state === "paused") {
      set({ state: "playing", anchor: { ...anchor, atMs: performance.now(), rate: get().speed } });
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
    get().playFrom(queue, nextIndex, get().origin);
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
    get().playFrom(queue, Math.max(0, index - 1), get().origin);
  },

  seek: (ms) =>
    set((s) => ({
      anchor: { positionMs: Math.max(0, ms), atMs: performance.now(), rate: s.state === "playing" ? s.speed : 0 },
    })),

  setVolume: (v) => set({ volume: Math.min(2, Math.max(0, v)), muted: false }),
  toggleMute: () => set((s) => ({ muted: !s.muted })),
  cycleRepeat: () =>
    set((s) => ({ repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off" })),
  toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })),
}));

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
