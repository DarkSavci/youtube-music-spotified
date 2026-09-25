import { apiUrl } from "./base";
import {
  NativeEngine,
  type Engine,
  type EngineEvent,
  type NormalizationLevel,
  type Target,
} from "./engine";
import { EmbeddedEngine } from "./embedded";
import { maxVolume, useSettings } from "./settings";
import { SessionClient, type Projection } from "./sessionclient";
import type { Track } from "./types";
import { currentPosition, usePlayer } from "./player";
import { effectiveSpeed, SPEEDS } from "./speed";
import { recordPlay } from "./playlog";
import { toast } from "./toast";

/**
 * Drives the engine from the player store.
 *
 * Mirrors the arrangement the Go core defines: a Target is derived from state
 * and handed to the engine, and the engine reports back. Keeping the same
 * shape here means that when the authoritative Session core takes over, this
 * module changes from deriving targets to forwarding them, and the engine
 * itself does not change at all.
 *
 * Deliberately not a React hook. Playback must outlive any component, and a
 * hook would tie the engine's lifetime to a render tree that can unmount.
 */

let engine: Engine | null = null;

/*
 * The device-side settings, remembered so a new engine adopts them.
 *
 * These are pushed from a React effect that runs before the one starting
 * playback, so on a fresh launch there was no engine yet to tell and the
 * value was simply dropped — normalisation and the equaliser did nothing at
 * all until something happened to change a setting and push again. Swapping
 * engines had the same hole. Holding the last value makes the order stop
 * mattering.
 */
let deviceSettings: {
  normalization: boolean;
  normalizationLevel: NormalizationLevel;
  eq: number[];
} | null = null;

/** Pushes the remembered settings into whatever engine is current. */
function applyDeviceSettings() {
  applySpeed();
  if (!deviceSettings || !(engine instanceof NativeEngine)) return;
  engine.setNormalization(deviceSettings.normalization, deviceSettings.normalizationLevel);
  engine.setEq(deviceSettings.eq);
}
let lastTargetKey = "";
let unsubscribe: (() => void) | null = null;

/**
 * The authoritative session, when the core is reachable.
 *
 * With it, playback state lives in Go: this module forwards intents and
 * applies projections. Without it — a browser with no sidecar — the local
 * store drives playback directly. The engine does not change either way,
 * because it reconciles to a target and does not care who produced it.
 */
let session: SessionClient | null = null;
let serverAuthoritative = false;

/**
 * Consecutive resolution failures before falling back to the embedded engine.
 *
 * One failure is an unavailable track and skipping is correct. Several in a row
 * means the resolver itself is broken — an upstream player change, an expired
 * session, a blocked address — and continuing to skip would silently race to
 * the end of the queue. Falling back keeps music playing at reduced
 * capability, which is far better than a player that quietly does nothing.
 */
const FALLBACK_AFTER_FAILURES = 3;
let consecutiveFailures = 0;
let fellBack = false;

/** Builds the engine the settings ask for, or the best available. */
function createEngine(): Engine {
  const preference = useSettings.getState().enginePreference;
  if (preference === "embedded" || fellBack) {
    usePlayer.setState({ engineEq: false });
    return new EmbeddedEngine(onEngineEvent);
  }
  usePlayer.setState({ engineEq: true });
  return new NativeEngine(onEngineEvent);
}

/**
 * Swaps the engine without losing the queue.
 *
 * The Session state is untouched: only the thing producing sound changes, and
 * the next reconcile re-applies the current target to the new engine. That is
 * the whole reason a target is declarative rather than a command stream.
 */
function swapEngine() {
  const previous = engine;
  engine = createEngine();
  applyDeviceSettings();
  previous?.destroy();
  // Force the next sync to re-apply, since the new engine knows nothing.
  lastTargetKey = "";
}

/** Epoch advances on every track change, so late reports from a replaced
 *  track can be discarded rather than skipping the new one. */
let epoch = 0;
let lastTrackId: string | null = null;

/**
 * Listening accounting for the current track.
 *
 * Only forward progress accumulates. Scrubbing back and replaying a section
 * would otherwise count twice, which quietly inflates every statistic built on
 * the play log.
 */
let playedMs = 0;
let lastPositionMs = 0;
let loggedCurrent = false;

/** Thirty seconds, or the whole track when it is shorter than that. */
function listenedThreshold(durationMs: number): number {
  const base = 30_000;
  return durationMs > 0 && durationMs < base ? durationMs : base;
}

/** Emits a play-log entry for the outgoing track when it was listened to. */
function closeOutCurrent(completed: boolean, failure?: string) {
  const s = usePlayer.getState();
  const track = s.track;
  if (!track || loggedCurrent) return;

  const counts = completed || failure || playedMs >= listenedThreshold(track.durationMs);
  if (!counts) return;

  loggedCurrent = true;
  recordPlay(track, {
    playedMs,
    completed,
    failed: Boolean(failure),
    failReason: failure ?? "",
    origin: s.origin,
  });
}

function deriveTarget(): Target {
  const s = usePlayer.getState();
  const track = s.track;
  if (track && track.id !== lastTrackId) {
    // A track change closes out the previous one before the counters reset.
    closeOutCurrent(false);
    epoch += 1;
    lastTrackId = track.id;
    playedMs = 0;
    lastPositionMs = 0;
    loggedCurrent = false;
  }
  const next = s.queue[s.index + 1];
  return {
    epoch,
    videoId: track?.id ?? null,
    startAtMs: s.anchor.positionMs,
    playing: s.state === "playing",
    preloadVideoId: next?.id ?? null,
    volume: s.muted ? 0 : s.volume,
    transition: { kind: "gapless" },
  };
}

function onEngineEvent(e: EngineEvent) {
  // Everything but the once-a-second position reports is worth a line in the
  // log: it is the engine's side of any "it skipped" or "it never started".
  if (e.kind !== "position") {
    const track = usePlayer.getState().track;
    const detail = "reason" in e && e.reason ? ` (${e.reason})` : "";
    const line = `[engine] ${e.kind}${detail} epoch=${e.epoch} track=${track?.id ?? "-"} "${track?.title ?? ""}"`;
    if (e.kind === "failed" || e.kind === "blocked") console.warn(line);
    else console.info(line);
  }

  if (serverAuthoritative && session) {
    // The core owns the queue, the failure ladder and the play log. Forward
    // the report and let the projection that follows update the UI, rather
    // than deciding anything here.
    session.report({
      Kind: e.kind,
      Epoch: e.epoch,
      PositionMs: "positionMs" in e ? e.positionMs : undefined,
      DurationMs: "durationMs" in e ? e.durationMs : undefined,
      Reason: "reason" in e ? e.reason : undefined,
    });
    if (e.kind === "blocked") {
      // Falling back to the embedded engine cannot fix a rate limit, and the
      // embedded player is refused by the same upstream. Stay put.
      usePlayer.setState({
        notice:
          e.reason === "rate_limited"
            ? "YouTube is rate-limiting this device. Playback will work again in a few minutes."
            : "Press play to start.",
      });
      return;
    }
    if (e.kind === "failed") {
      usePlayer.setState({ notice: usePlayer.getState().followingRoom ? "This track could not play on your account. Waiting for the host’s next track." : null });
      consecutiveFailures += 1;
      if (consecutiveFailures >= FALLBACK_AFTER_FAILURES && !fellBack) {
        console.warn("[playback] falling back to the embedded engine");
        fellBack = true;
        swapEngine();
        session.setCapabilities(engine!.capabilities);
      }
    } else if (e.kind === "loaded") {
      consecutiveFailures = 0;
    }
    return;
  }

  // Discard anything from a superseded track.
  if (e.epoch !== epoch) return;

  const store = usePlayer.getState();
  switch (e.kind) {
    case "loaded":
      consecutiveFailures = 0;
      usePlayer.setState((s) => ({
        state: "playing",
        track: s.track && e.durationMs > 0 && !s.track.durationMs
          ? { ...s.track, durationMs: e.durationMs }
          : s.track,
      }));
      break;

    case "position":
      if (e.positionMs > lastPositionMs) {
        playedMs += e.positionMs - lastPositionMs;
      }
      lastPositionMs = e.positionMs;
      // Re-anchor rather than storing position: consumers interpolate, so a
      // one-per-second correction is enough to stay accurate without
      // re-rendering at frame rate.
      usePlayer.setState((s) => ({
        anchor: { positionMs: e.positionMs, atMs: performance.now(), rate: s.speed },
        track:
          s.track && e.durationMs > 0 && !s.track.durationMs
            ? { ...s.track, durationMs: e.durationMs }
            : s.track,
      }));
      break;

    case "stalled":
      usePlayer.setState({ state: "stalled" });
      break;

    case "blocked":
      // Show it as paused. The next press carries the gesture the browser
      // asked for and starts this same track.
      usePlayer.setState({
        state: "paused",
        notice:
          e.reason === "rate_limited"
            ? "YouTube is rate-limiting this device. Playback will work again in a few minutes."
            : null,
      });
      break;

    case "ended":
      closeOutCurrent(true);
      store.next();
      break;

    case "failed": {
      // A failure is not an error the caller handles; the queue moves on and
      // the track is marked so the row can be greyed.
      console.warn("[playback] track failed:", e.reason);
      closeOutCurrent(false, e.reason);

      consecutiveFailures += 1;
      if (consecutiveFailures >= FALLBACK_AFTER_FAILURES && !fellBack) {
        // Repeated failures mean the resolver is broken rather than the track.
        // Degrade to the embedded engine instead of skipping to the end.
        console.warn("[playback] falling back to the embedded engine");
        fellBack = true;
        swapEngine();
      }
      usePlayer.setState((s) => ({
        queue: s.queue.map((t, i) => (i === s.index ? { ...t, playable: false } : t)),
      }));
      store.next();
      break;
    }
  }
}

/** Starts the engine and keeps it reconciled with the store. Idempotent. */
/**
 * Applies a projection from the core.
 *
 * The store becomes a view of authoritative state rather than the source of
 * it. Position arrives as an anchor and is interpolated locally, so the core
 * does not have to stream it at frame rate.
 */
function applyProjection(p: Projection) {
  // The core normalises these, but this is the first thing to touch a
  // projection and a null list here took the whole page down. Cheap to hold.
  const items = p.state.queue.items ?? [];
  const track = items[p.state.queue.index] ?? null;
  // Speed is per device. While another device is the one playing, this
  // window is a remote for it: its speed is not ours to know, so interpolate
  // at 1× and let the core's projections correct it.
  const remote = (p.devices ?? []).some((d) => d.owner && d.id !== session?.deviceID);
  usePlayer.setState({
    followingRoom: Boolean(p.followingRoom),
    state: p.state.state,
    track,
    queue: items,
    index: p.state.queue.index,
    origin: p.state.queue.origin ?? "",
    repeat: p.state.repeat,
    shuffle: p.state.shuffle,
    volume: p.state.volume,
    capabilities: p.capabilities,
    devices: (p.devices ?? []).map((d) => ({ id: d.id, name: d.name, owner: d.owner })),
    anchor: {
      positionMs: p.state.positionMs,
      atMs: performance.now(),
      rate: p.state.state !== "playing" ? 0 : remote ? 1 : usePlayer.getState().speed,
    },
  });

  if (engine) {
    engine.apply({
      epoch: p.target.Epoch,
      videoId: p.target.VideoID || null,
      startAtMs: p.target.StartAtMs,
      playing: p.target.Playing,
      preloadVideoId: p.target.PreloadVideoID ?? null,
      volume: p.target.Volume,
      transition: {
        kind: (p.target.Transition?.Kind ?? "gapless") as "cut" | "gapless" | "crossfade",
        ms: p.target.Transition?.Ms,
      },
      userChange: Boolean(p.target.UserChange),
    });
  }
}

export function startPlayback() {
  if (engine) return;
  engine = createEngine();
  applyDeviceSettings();

  // Try the authoritative core first. Failing that, drive playback locally —
  // the app still works, it just cannot hand off between devices.
  session = new SessionClient(applyProjection);
  void session
    .start(navigator.platform || "This device", engine.capabilities)
    .then((ok) => {
      serverAuthoritative = ok;
      // A room invitation never survives a window reload or account switch.
      // Only the playback owner may clear its stale room after a reload.
      if (ok && usePlayer.getState().followingRoom && usePlayer.getState().devices.some(d => d.id === session?.deviceID && d.owner)) void session?.command({ Kind: "leave_room" });
      if (!ok) {
        console.debug("[playback] session core unreachable; driving playback locally");
        session = null;
      }
    });

  const sync = () => {
    if (!engine) return;
    const target = deriveTarget();
    // Only reconcile when something meaningful changed; a Target is
    // idempotent but re-applying it on every store write would thrash the
    // media element.
    const key = [
      target.epoch, target.videoId, target.playing,
      Math.round(target.startAtMs / 1000), target.volume, target.preloadVideoId,
    ].join("|");
    if (key === lastTargetKey) return;
    lastTargetKey = key;
    engine.apply(target);
  };

  // Local-mode reconciliation. With the core authoritative, targets arrive in
  // projections instead and this is a no-op.
  unsubscribe = usePlayer.subscribe(() => {
    if (serverAuthoritative) return;
    sync();
  });
  sync();
}

/** The level to come back to when a mute is lifted. */
let volumeBeforeMute = 1;

/** True when the Go core owns playback state. */
export function isServerAuthoritative(): boolean {
  return serverAuthoritative;
}

function roomControlsLocked(): boolean {
  if (!usePlayer.getState().followingRoom) return false;
  toast("The host controls playback. Leave Listen Together to choose your own music.");
  return true;
}

export async function syncRoomPlayback(track: Track | null, positionMs: number, playing: boolean) {
  if (!session || !serverAuthoritative) throw new Error("The local music service is not ready.");
  if (!await session.command({ Kind: "follow_room", Tracks: track ? [track] : [], PositionMs: Math.round(positionMs), Playing: playing })) throw new Error("Could not synchronize playback with the local music service.");
}
export async function leaveRoomPlayback() {
  if (session) await session.command({ Kind: "leave_room" });
}

/** Sends an intent to the core, or falls back to the local store. */
export const transport = {
  play(tracks: Track[], index: number, origin: string) {
    if (roomControlsLocked()) return;
    /*
     * Clicking the song that is already playing does not restart it.
     *
     * Nobody double-clicks the current song to hear its first seconds again;
     * they click it because it is there. Paused, it resumes; playing, nothing
     * happens.
     */
    const s = usePlayer.getState();
    const clicked = tracks[index];
    if (clicked && s.track?.id === clicked.id) {
      const playing = s.state === "playing" || s.state === "loading" || s.state === "stalled";
      if (!playing) this.toggle();
      return;
    }
    if (serverAuthoritative && session) {
      void session.command({ Kind: "play", Tracks: tracks, StartIndex: index, Origin: origin });
    } else {
      usePlayer.getState().playFrom(tracks, index, origin);
    }
  },
  /*
   * Plays a song the way YouTube Music does: the song, then its radio.
   *
   * For a song picked out of search results or a Home shelf. The queue is
   * YouTube's own "Up next" for it, which keeps extending as it plays,
   * rather than whatever else happened to be on screen around it. An album
   * or a playlist still plays as itself (play()), and carries on into a
   * radio once it ends.
   */
  playRadio(track: Track, origin?: string) {
    if (roomControlsLocked()) return;
    const s = usePlayer.getState();
    if (s.track?.id === track.id) {
      const playing = s.state === "playing" || s.state === "loading" || s.state === "stalled";
      if (!playing) this.toggle();
      return;
    }
    if (serverAuthoritative && session) void session.startRadio(track, origin);
    else usePlayer.getState().playFrom([track], 0, origin ?? `${track.title} radio`);
  },

  /** Plays another entry of the queue, one already played included. */
  jump(at: number) {
    if (roomControlsLocked()) return;
    if (serverAuthoritative && session) void session.command({ Kind: "jump", At: at });
    else {
      const s = usePlayer.getState();
      s.playFrom(s.queue, at, s.origin ?? "");
    }
  },

  toggle() {
    // A guest whose start was blocked presses Play to try again; that is
    // the host's playback, not a choice of their own.
    const s = usePlayer.getState();
    if (s.followingRoom && s.notice) {
      usePlayer.setState({ notice: null });
      void import("./together").then(m => m.retryTogetherPlayback());
      return;
    }
    if (roomControlsLocked()) return;
    if (serverAuthoritative && session) void session.command({ Kind: "toggle" });
    else usePlayer.getState().toggle();
  },
  next() {
    if (roomControlsLocked()) return;
    if (serverAuthoritative && session) void session.command({ Kind: "next" });
    else usePlayer.getState().next();
  },
  prev() {
    if (roomControlsLocked()) return;
    if (serverAuthoritative && session) void session.command({ Kind: "prev" });
    else usePlayer.getState().prev();
  },
  seek(ms: number) {
    if (roomControlsLocked()) return;
    if (serverAuthoritative && session) void session.command({ Kind: "seek", PositionMs: Math.round(ms) });
    else usePlayer.getState().seek(ms);
  },
  setVolume(v: number) {
    v = Math.max(0, Math.min(maxVolume(), v));
    // Moving the slider means you want to hear that, so it lifts a mute — or
    // the bar would show the level you chose while playing nothing.
    usePlayer.setState({ muted: false });
    if (serverAuthoritative && session) void session.command({ Kind: "set_volume", Volume: v });
    else usePlayer.getState().setVolume(v);
  },

  /**
   * Silences playback, and restores the level afterwards.
   *
   * Mute used to be a store flag and nothing else. The store drives the
   * engine only while playback is local, and the core is authoritative
   * whenever it is reachable — so in the packaged app the button changed its
   * own icon and the slider's position and never touched the audio.
   *
   * The core has no notion of mute, and it does not need one: muting is
   * volume zero with the previous level remembered here, which is also what
   * makes it survive a projection coming back the other way.
   */
  toggleMute() {
    const s = usePlayer.getState();
    if (s.muted) {
      usePlayer.setState({ muted: false });
      // Unmuting to silence would look broken, so a mute taken at zero comes
      // back somewhere audible.
      const back = volumeBeforeMute > 0.01 ? volumeBeforeMute : 0.3;
      if (serverAuthoritative && session) {
        void session.command({ Kind: "set_volume", Volume: back });
      } else {
        usePlayer.getState().setVolume(back);
      }
      usePlayer.setState({ muted: false });
      return;
    }
    volumeBeforeMute = s.volume;
    if (serverAuthoritative && session) {
      void session.command({ Kind: "set_volume", Volume: 0 });
    } else {
      usePlayer.getState().setVolume(0);
    }
    // Set after, because setVolume clears it.
    usePlayer.setState({ muted: true });
  },
  toggleShuffle() {
    if (roomControlsLocked()) return;
    const s = usePlayer.getState();
    if (serverAuthoritative && session) void session.command({ Kind: "set_shuffle", Shuffle: !s.shuffle });
    else s.toggleShuffle();
  },
  /**
   * Adds tracks to the end of the queue.
   *
   * The core owns queue order, so this is an intent like any other; the
   * projection that follows is what moves the UI.
   */
  enqueue(tracks: Track[]) {
    if (roomControlsLocked()) return;
    const s = usePlayer.getState();
    const at = s.queue.length;
    if (serverAuthoritative && session) {
      void session.command({ Kind: "enqueue", Insert: tracks, At: at });
    } else {
      usePlayer.setState({ queue: [...s.queue, ...tracks] });
    }
  },

  /** Inserts tracks directly after the current one. */
  playNext(tracks: Track[]) {
    if (roomControlsLocked()) return;
    const s = usePlayer.getState();
    const at = Math.min(s.index + 1, s.queue.length);
    if (serverAuthoritative && session) {
      void session.command({ Kind: "enqueue", Insert: tracks, At: at });
    } else {
      const next = [...s.queue];
      next.splice(at, 0, ...tracks);
      usePlayer.setState({ queue: next });
    }
  },

  /**
   * Reorders the queue.
   *
   * The core has handled `move` and `remove` since it was written; nothing
   * ever sent them, so a queue could be built and never rearranged.
   */
  move(from: number, to: number) {
    if (roomControlsLocked()) return;
    if (serverAuthoritative && session) {
      void session.command({ Kind: "move", From: from, To: to });
    }
  },

  removeAt(at: number) {
    if (roomControlsLocked()) return;
    if (serverAuthoritative && session) {
      void session.command({ Kind: "remove", At: at });
    }
  },

  cycleRepeat() {
    if (roomControlsLocked()) return;
    const s = usePlayer.getState();
    const nextMode = s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off";
    if (serverAuthoritative && session) void session.command({ Kind: "set_repeat", Repeat: nextMode });
    else s.cycleRepeat();
  },
};

export function stopPlayback() {
  session?.stop();
  session = null;
  serverAuthoritative = false;
  unsubscribe?.();
  unsubscribe = null;
  engine?.destroy();
  engine = null;
  lastTargetKey = "";
  consecutiveFailures = 0;
  fellBack = false;
}

/** Which engine is producing sound, for the diagnostics panel. */
export function engineName(): string | null {
  return engine?.name ?? null;
}

/**
 * Plays at the speed in effect: the chosen one, or 1× in a Listen Together
 * room (see speed.ts). A speed the engine cannot play falls back to 1× rather
 * than being ignored while the control claims otherwise.
 *
 * Speed is this device's, like volume: the core keeps track time, and the
 * engine reports positions in track time, so nothing upstream changes. The
 * anchor is re-taken at the new rate so interpolation does not jump.
 */
export function applySpeed() {
  const wanted = effectiveSpeed();
  const rate = !engine || engine.speeds().includes(wanted) ? wanted : 1;
  engine?.setSpeed(rate);
  const s = usePlayer.getState();
  if (s.speed === rate) return;
  usePlayer.setState({
    speed: rate,
    anchor: { positionMs: currentPosition(s), atMs: performance.now(), rate: s.state === "playing" ? rate : 0 },
  });
}

/** The speeds the current engine can play. */
export function availableSpeeds(): readonly number[] {
  return engine?.speeds() ?? SPEEDS;
}

export function engineCapabilities() {
  return engine?.capabilities ?? null;
}


/**
 * Plays an album, playlist or artist straight from a card.
 *
 * A card's play button has to fetch before it can play, because a shelf item
 * carries only the cover and the name — never the tracks. That is the whole
 * reason this exists rather than the caller passing a list: the caller does
 * not have one.
 *
 * Returns false when there is nothing playable, so the caller can leave the
 * card alone rather than showing a player that never starts.
 */
export async function playEntity(
  kind: "album" | "playlist" | "artist",
  id: string,
  origin: string,
): Promise<boolean> {
  const { api } = await import("./api");
  try {
    const tracks =
      kind === "album"
        ? (await api.album(id)).tracks
        : kind === "playlist"
          ? (await api.playlist(id)).tracks
          : (await api.artist(id)).topTracks;
    const playable = (tracks ?? []).filter((t) => t.playable);
    if (playable.length === 0) return false;
    transport.play(playable, 0, origin);
    return true;
  } catch {
    // The entity page will report the failure properly if the user goes
    // there; a card is the wrong surface for an error message.
    return false;
  }
}


/** Moves playback to another device. The projection that follows updates the UI. */
export function transferTo(deviceId: string) {
  if (session) void session.command({ Kind: "transfer", DeviceID: deviceId });
}


/**
 * Pushes playback settings where they take effect.
 *
 * Crossfade and gapless are decided by the core, because it owns the
 * transition; normalization is a property of this device's audio graph. They
 * are two different destinations for what looks like one settings screen,
 * which is why this exists rather than the screen writing to a store and
 * hoping.
 */
export async function applyPlaybackSettings(s: {
  crossfadeMs: number;
  gapless: boolean;
  normalization: boolean;
  normalizationLevel: NormalizationLevel;
  resumeOnLaunch: boolean;
  reportToYouTube: boolean;
  cacheMaxMB: number;
  autoplay: boolean;
  eq: number[];
}) {
  deviceSettings = s;
  applyDeviceSettings();
  try {
    await fetch(apiUrl("/v1/session/settings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        crossfadeMs: s.crossfadeMs,
        gapless: s.gapless,
        // The core is what writes the queue down, so the switch lives there.
        resumeOnLaunch: s.resumeOnLaunch,
        reportToYouTube: s.reportToYouTube,
        cacheMaxMB: s.cacheMaxMB,
        autoplay: s.autoplay,
      }),
    });
  } catch {
    // The core keeps its previous settings; nothing is broken, the change
    // simply has not landed yet and will on the next attempt.
  }
}


/**
 * Exposes the audio graph's level for diagnostics.
 *
 * Attached to the window so a probe can distinguish a volume change that was
 * recorded from one that was actually heard.
 */
export function installAudioDebug() {
  (window as unknown as { __audio?: () => unknown }).__audio = () =>
    engine instanceof NativeEngine ? engine.debugLevel() : null;
}

/** Change an explicitly paired edit without replacing the listener's queue. */
export async function switchTrackVariant(track: Track, expectedID: string): Promise<boolean> {
  if (roomControlsLocked()) return false;
  if (usePlayer.getState().track?.id !== expectedID) return false;
  if (serverAuthoritative && session) return session.command({ Kind: "switch_variant", ExpectedID: expectedID, Tracks: [track] });
  return false;
}
