import type { Capabilities } from "./player";
import { apiUrl } from "./base";
import { Mixer, perceptualGain } from "./decks";
import { audibleEdges, type Edges } from "./silence";
import type { SpeedSupport } from "./speed";

/**
 * The playback engine seam.
 *
 * Engines are handed the state they should be in and reconcile toward it,
 * rather than receiving a stream of imperative commands. A Target is
 * idempotent, so re-sending an unchanged one is a no-op and recovering after a
 * stall or a reconnect is just "send the target again".
 *
 * Two adapters sit here with very different abilities. The asymmetry is
 * carried as `capabilities` data rather than as a wider interface, so the UI
 * reads a flag and never branches on which engine is live.
 */

export interface Target {
  /** Stamps the target. Reports carrying an older epoch are discarded, which
   *  stops a swapped-out engine's late "ended" skipping the new track. */
  epoch: number;
  videoId: string | null;
  startAtMs: number;
  playing: boolean;
  preloadVideoId?: string | null;
  volume: number;
  transition: { kind: "cut" | "gapless" | "crossfade"; ms?: number };
  /** The listener chose this track (a play, a skip): cut to it, never fade. */
  userChange?: boolean;
}

export type EngineEvent =
  | { kind: "loaded"; epoch: number; durationMs: number }
  /**
   * durationMs rides along because the "loaded" report can be lost: a track
   * preloaded on the idle deck loads while idle, and only the playing deck
   * reports. Zero when the element does not know its length yet.
   */
  | { kind: "position"; epoch: number; positionMs: number; durationMs: number }
  | { kind: "ended"; epoch: number }
  | { kind: "stalled"; epoch: number }
  /**
   * The engine is ready but cannot start, and the track is not at fault —
   * the browser wants a user gesture, or upstream is rate-limiting us.
   *
   * Deliberately distinct from "failed": the track is fine, so it must not be
   * marked unplayable, logged as a failed play, or skipped past. Recovery is a
   * press or a wait, and the queue has to survive both.
   */
  | { kind: "blocked"; epoch: number; reason?: string }
  | { kind: "failed"; epoch: number; reason: string };

export interface Engine {
  readonly name: string;
  readonly capabilities: Capabilities;
  /** Reconcile toward the given state. Safe to call repeatedly. */
  apply(target: Target): void;
  /** Interpolation-free truth, for the rare caller that needs it exactly. */
  positionMs(): number;
  /** The playback speeds this engine can play; see lib/speed.ts. */
  speeds(): SpeedSupport;
  /** Plays at this multiple of normal speed, pitch preserved. */
  setSpeed(rate: number): void;
  destroy(): void;
}

/**
 * Native engine: plays the sidecar's relayed bytes through a Web Audio graph.
 *
 * googlevideo will not serve a cross-origin browser request, so the audio
 * element points at the local sidecar rather than at YouTube. That is also
 * what makes the graph possible at all — a cross-origin media element taints
 * the pipeline and cannot be routed through an AnalyserNode or a filter chain.
 */
/**
 * What each normalisation level aims for, in LUFS.
 *
 * The same three Spotify offers, and the same targets: quiet enough to leave
 * headroom for dynamics, or loud enough to match everything else at the cost
 * of some. "Normal" is the broadcast-ish -14 that streaming has settled on.
 */
export const NORMALIZATION_TARGETS = {
  quiet: -19,
  normal: -14,
  loud: -11,
} as const;

export type NormalizationLevel = keyof typeof NORMALIZATION_TARGETS;

/** The correction that brings a track to a target, bounded as the core does. */
function gainDb(trackLkfs: number, targetLkfs: number): number {
  const limit = 12;
  return Math.max(-limit, Math.min(limit, targetLkfs - trackLkfs));
}

/*
 * How long a deck that should be playing may sit without moving.
 *
 * BUFFERING_MS: then it says so — the bar pulses instead of showing a timer
 * that is quietly frozen.
 * STALL_MS: mid-track, after it has already played. A connection that dies
 * there rarely comes back by itself, so it is picked up again soon.
 * LOAD_STALL_MS: before a load has played at all. The first bytes wait on
 * resolving the stream, which can take a while on a slow link.
 * RECOVERY_STALL_MS: a reload of a track that was playing, from a URL the
 * core has cached, is quick when it works at all. A track that never played
 * may still be resolving, so its one reload gets LOAD_STALL_MS again.
 * A track that dies mid-way so fails in about STALL_MS plus two
 * RECOVERY_STALL_MS, some twenty seconds rather than the minute it used to
 * take. One that never starts shows as buffering throughout, and fails after
 * two LOAD_STALL_MS.
 */
const BUFFERING_MS = 1_500;
const STALL_MS = 6_000;
const LOAD_STALL_MS = 15_000;
const RECOVERY_STALL_MS = 7_000;
/*
 * What counts as the deck moving: this much media time past where it was last
 * seen moving. At the edge of what has buffered, currentTime creeps by a few
 * hundredths of a second, which is not the music coming back.
 */
const MIN_PROGRESS_S = 0.25;
/** Media time played without a hitch after which a track's retries are refilled. */
const RETRY_REFILL_S = 10;
/** How long a NotSupportedError from play() waits for the element's own error event. */
const UNANSWERED_REJECTION_MS = 3_000;
/**
 * When a failed preload of the next track is tried again: later each time,
 * then not at all. The track still loads normally when it comes up; warming
 * it is only a head start, and not worth a stream of refused requests.
 */
const PRELOAD_RETRY_MS = [2_000, 10_000];
/** When a missed silence measurement is asked for again; then not at all. */
const EDGE_RETRY_MS = [3_000, 10_000, 30_000];

function currentVideoId(el: HTMLAudioElement): string | null {
  const m = /\/v1\/stream\/([^/?#]+)/.exec(el.src || "");
  return m ? decodeURIComponent(m[1]!) : null;
}

/*
 * Loudness is asked for once per track and remembered.
 *
 * The core caches it too, but a deck is normalised on every load — a repeat,
 * a crossfade back, a preload that becomes the current track — and a request
 * per load would be several for the same answer.
 */
const loudnessSeen = new Map<string, number | null>();

async function trackLoudness(videoId: string): Promise<number | null> {
  const known = loudnessSeen.get(videoId);
  if (known !== undefined) return known;
  try {
    // Its own route, and deliberately not /v1/resolve: that one starts yt-dlp,
    // which is three seconds of work to read a number, landing exactly when
    // the track is trying to start.
    const res = await fetch(apiUrl(`/v1/tracks/${encodeURIComponent(videoId)}/loudness`));
    if (!res.ok) return null;
    const body = (await res.json()) as { loudnessLkfs?: number };
    // Absent means the track does not publish one, which is not a failure:
    // the leveller covers it. Remembered as null so it is not asked again.
    const lkfs = typeof body.loudnessLkfs === "number" ? body.loudnessLkfs : null;
    loudnessSeen.set(videoId, lkfs);
    return lkfs;
  } catch {
    return null;
  }
}

/**
 * Asks the core why a load failed.
 *
 * Only ever called on failure, so the extra request costs nothing in the
 * normal case. A failure to classify is itself inconclusive, and returning
 * null lets the caller fall back to the media element's own code.
 */
async function classifyFailure(videoId: string | null): Promise<string | null> {
  if (!videoId) return null;
  try {
    // What the core already knows about the last attempt. Asking it to
    // resolve again, as this used to, started yt-dlp to answer a question the
    // failed attempt had already answered.
    const res = await fetch(apiUrl(`/v1/tracks/${encodeURIComponent(videoId)}/health`));
    if (!res.ok) return null;
    const body = (await res.json()) as { rateLimited?: boolean };
    return body.rateLimited ? "rate_limited" : null;
  } catch {
    return null;
  }
}

export class NativeEngine implements Engine {
  readonly name = "native";
  readonly capabilities: Capabilities = {
    eq: true,
    crossfade: "true",
    normalization: true,
    preciseSeek: true,
    volumeSteps: 0,
  };

  /*
   * Two decks, because a crossfade needs both tracks audible at once.
   *
   * The next track is loaded into the idle deck as soon as the core names it,
   * so a transition is a pair of gain ramps rather than a load. That is also
   * what makes gapless gapless: the bytes are already decoded when the
   * previous track ends.
   */
  private decks: HTMLAudioElement[];
  private active = 0;
  private mixer = new Mixer();
  private current: Target | null = null;
  private emit: (e: EngineEvent) => void;
  private ticker?: number;
  /** Set while a crossfade is in flight, so it is not restarted every tick. */
  private fadingTo: string | null = null;
  /** The deck fading out after a transition, which must not be reused yet. */
  private releasing: HTMLAudioElement | null = null;
  private releaseTimer: number | undefined;
  /** Recovery attempts for the current track; see recover(). */
  private recoveries = 0;
  /** The epoch a failure was last reported for; see fail(). */
  private failedEpoch = -1;
  /** Error events seen on any deck, so a rejected play() can tell if one followed. */
  private errorEvents = 0;
  /** Failed silence measurements: how many, and when to ask again. */
  private edgeFailures = new Map<string, { count: number; retryAt: number }>();
  private edgesAsking = new Set<string>();
  /** Failed preloads of the next track: how many, and when to try again. */
  private preloadFailures = new Map<string, { count: number; retryAt: number }>();
  /** The last position the playing deck was known to be at, in seconds. */
  private lastGoodAt = 0;
  /** When the playing deck last moved forward, for the stall watchdog. */
  private progressAt = 0;
  /** Whether the current load has played at all yet; see watchForStall(). */
  private progressedSinceLoad = false;
  /** Whether the current track has played at all, on any load; see recover(). */
  private playedThisTrack = false;
  /** Set while the deck is frozen and the core has been told it is buffering. */
  private stallShown = false;
  /** Set from a retry's reload until its metadata arrives; see recover(). */
  private reloading = false;
  /** Media time played since the last retry, to refill retries once it plays on. */
  private playedSinceRetry = 0;
  /** Retry reloads of the current track, refills included. */
  private reloads = 0;
  /** Where each track's sound starts and ends, for timing crossfades. */
  private edges = new Map<string, Edges>();

  /** Playback speed, applied to both decks so a crossfade starts in step. */
  private speed = 1;

  constructor(emit: (e: EngineEvent) => void) {
    this.emit = emit;
    this.decks = [new Audio(), new Audio()];
    for (const el of this.decks) {
      el.preload = "auto";
      el.preservesPitch = true;
      this.wire(el);
    }
  }

  speeds(): SpeedSupport {
    // A media element plays any rate in our range, pitch preserved.
    return "any";
  }

  setSpeed(rate: number) {
    this.speed = rate;
    // defaultPlaybackRate as well: loading a new source resets an element's
    // rate to its default, which would drop back to 1× on every track.
    for (const el of this.decks) {
      el.defaultPlaybackRate = rate;
      el.playbackRate = rate;
    }
  }

  private get deck(): HTMLAudioElement {
    return this.decks[this.active]!;
  }

  private get idle(): HTMLAudioElement {
    return this.decks[1 - this.active]!;
  }

  private wire(el: HTMLAudioElement) {
    el.addEventListener("loadedmetadata", () => {
      // Only the deck that is actually playing defines the track's duration.
      if (el !== this.deck) return;
      this.emit({
        kind: "loaded",
        epoch: this.current?.epoch ?? 0,
        durationMs: Math.round((el.duration || 0) * 1000),
      });
    });
    el.addEventListener("ended", () => {
      if (el !== this.deck) return;
      const epoch = this.current?.epoch ?? 0;
      this.switchOnEnded(el);
      this.emit({ kind: "ended", epoch });
    });
    el.addEventListener("waiting", () => {
      if (el !== this.deck) return;
      // Held until the deck moves again: a position report in between would
      // tell the core it is playing, and the bar would show a frozen timer.
      this.stallShown = true;
      this.emit({ kind: "stalled", epoch: this.current?.epoch ?? 0 });
    });
    el.addEventListener("error", () => {
      this.errorEvents += 1;
      if (el !== this.deck) {
        // A preload that failed. Left alone it still looks ready, and a skip
        // to it then plays a dead element that never starts or errors again.
        if (el === this.idle) this.rewarmAfterError(el);
        return;
      }
      const code = el.error?.code;
      // MEDIA_ERR_ABORTED means we replaced the source ourselves — a track
      // change or a teardown. Reporting it would fault a track for the crime
      // of being skipped.
      if (code === MediaError.MEDIA_ERR_ABORTED) return;

      // A dropped connection or a stale URL is not a dead track: pick the
      // same track up again where it was, before giving up on it.
      if (this.recover(el)) return;

      const epoch = this.current?.epoch ?? 0;
      const videoId = this.current?.videoId ?? null;
      /*
       * A media element reports every refusal the same way, so the reason has
       * to be asked for separately.
       *
       * This matters because a rate limit and a dead track need opposite
       * responses: one is waited out with the queue intact, the other is
       * skipped. Guessing wrong turns a few minutes of waiting into a queue
       * of tracks permanently greyed out.
       */
      void classifyFailure(videoId).then((reason) => {
        if (reason === "rate_limited") {
          this.emit({ kind: "blocked", epoch, reason });
          return;
        }
        this.fail(epoch, reason ?? (code ? `media_error_${code}` : "media_error"));
      });
    });
  }

  /*
   * Reports a failure once per load of a track.
   *
   * A deck whose source failed rejects every play() after it, and each
   * projection from the core reconciles, and so calls play(), again. Every
   * rejection used to be reported, so one dead track arrived as a burst of
   * twenty failures that tripped the engine fallback by itself. A fresh press
   * of play re-arms it (see apply()), so retrying a dead track still reports.
   */
  private fail(epoch: number, reason: string) {
    if (this.failedEpoch === epoch) return;
    this.failedEpoch = epoch;
    this.emit({ kind: "failed", epoch, reason });
  }

  private srcFor(videoId: string): string {
    return apiUrl(`/v1/stream/${encodeURIComponent(videoId)}`);
  }

  /**
   * Points a deck at a track, and corrects its loudness.
   *
   * The two happen together because a correction applied late is a volume
   * change the listener hears. The figure is asked for in parallel with the
   * load rather than before it, so a slow or missing answer delays nothing:
   * the track starts either way, and the gain lands within the first moments
   * if it arrives at all.
   */
  private point(el: HTMLAudioElement, videoId: string, preload = false) {
    // A preload says so: the core then treats it as readying, not as
    // someone waiting, and it does not hold up the rest of its work.
    el.src = this.srcFor(videoId) + (preload ? "?preload=1" : "");
    void this.normalise(el, videoId);
  }

  /*
   * Picks a failing track up again where it was.
   *
   * A media element reports a dropped connection, a stale URL and a stall
   * the same way it reports a track that cannot play at all, and the answer
   * used to be the same too: skip it. Most of those are transient, and the
   * core fixes a stale URL on the next request. So the same track is loaded
   * again (a fresh request) and seeked back to where it was. Twice for a
   * track that has played, once for one that never has; after that it
   * really is the track.
   */
  private recover(el: HTMLAudioElement): boolean {
    const id = this.current?.videoId;
    // A track that never played once gets one fresh try, not two: nothing
    // suggests a passing drop, and the listener is watching it buffer.
    const tries = this.playedThisTrack ? 2 : 1;
    if (!id || el !== this.deck || currentVideoId(el) !== id || this.recoveries >= tries) return false;
    this.recoveries += 1;
    const at = this.lastGoodAt;
    console.info(
      `[engine] retrying ${id} at ${Math.round(at)}s (attempt ${this.recoveries}, media error ${el.error?.code ?? "none"})`,
    );
    // Counted over the whole track, so a retry after a refill is still a URL
    // the element has not already given up on.
    this.reloads += 1;
    el.src = `${this.srcFor(id)}?retry=${this.reloads}`;
    // Until the reload's metadata arrives the element sits at 0 and paused.
    // Neither is news: the position to come back to stays where it was.
    this.reloading = true;
    this.playedSinceRetry = 0;
    el.addEventListener(
      "loadedmetadata",
      () => {
        if (el !== this.deck || currentVideoId(el) !== id) return;
        this.reloading = false;
        if (at > 0) el.currentTime = at;
        if (this.current?.playing) void el.play().catch(() => {});
      },
      { once: true },
    );
    this.progressAt = performance.now();
    this.progressedSinceLoad = false;
    return true;
  }

  /*
   * Gapless without waiting for the core.
   *
   * The switch to the next track used to wait for the core to hear "ended"
   * and answer with a new target: a round trip, heard as a gap. The next
   * track is already on the idle deck, so the engine starts it the moment
   * this one ends, and the core, when it answers, finds it playing.
   */
  private switchOnEnded(ended: HTMLAudioElement) {
    const t = this.current;
    const next = this.idle;
    if (!t || !t.playing || this.fadingTo || t.transition.kind === "cut") return;
    const id = t.preloadVideoId;
    if (!id || id === t.videoId || next === this.releasing) return;
    if (!this.loaded(next, id) || next.readyState < 2) return;

    this.fadingTo = id;
    this.mixer.set(next, 0);
    next.currentTime = 0;
    void next.play().catch(() => {
      /* handled by the error listener on that element */
    });
    // A few milliseconds of ramp: a gain stepping 0 to 1 in one sample clicks.
    this.mixer.crossfade(ended, next, 40, 1);
    this.active = this.decks.indexOf(next);
    this.release(ended, 40);
  }

  private async normalise(el: HTMLAudioElement, videoId: string) {
    if (!this.normalizing) return;
    const lkfs = await trackLoudness(videoId);
    // Still the track this deck is holding? A fast skip can land the answer
    // after the deck has moved on, and correcting for the wrong track is
    // worse than not correcting at all.
    if (!this.loaded(el, videoId) || !this.normalizing) return;

    this.knownLoudness.set(el, lkfs !== null);
    if (lkfs !== null) this.mixer.setTrackGainDb(el, gainDb(lkfs, this.target));
    this.reviewLevelling();
  }

  /** Which decks hold a track that says how loud it is. */
  private knownLoudness = new WeakMap<HTMLAudioElement, boolean>();

  /**
   * Measure only what does not announce itself.
   *
   * The leveller and replay gain are two answers to the same question, and
   * running both corrects twice: the exact correction lands, and then the
   * leveller sees a track at the target and pulls it somewhere else again.
   * So it measures only while the track playing published nothing.
   */
  private reviewLevelling() {
    const el = this.playingDeck() ?? this.deck;
    const known = this.knownLoudness.get(el) === true;
    this.mixer.setLevelling(this.normalizing && !known);
  }

  /** Whether normalisation is on, and the loudness it aims for. */
  private normalizing = false;
  private target: number = NORMALIZATION_TARGETS.normal;

  private loaded(el: HTMLAudioElement, videoId: string): boolean {
    return el.src.includes(encodeURIComponent(videoId));
  }

  apply(target: Target) {
    const prev = this.current;
    this.current = target;
    if (prev && target.playing && !prev.playing) this.failedEpoch = -1;

    if (!target.videoId) {
      for (const el of this.decks) el.pause();
      this.stopTicker();
      return;
    }

    /*
     * Build the audio graph before touching a deck.
     *
     * Routing an element happens in the transition below, and it can only
     * succeed once the AudioContext exists. Creating the context afterwards
     * left the first track connected straight to the output, where the
     * master gain — and therefore the volume slider — could not reach it.
     * The context still must not be created before a gesture, and a target
     * asking to play is downstream of one.
     */
    if (target.playing) {
      this.mixer.ensure();
      this.mixer.resume();
      // Decks that took their track before there was a graph join it now:
      // the one playing at full level, the preloaded one silent.
      this.mixer.adopt(this.deck, 1);
      if (this.idle.src) this.mixer.adopt(this.idle, 0);
    }

    const changed = !prev || prev.videoId !== target.videoId;
    if (target.transition.kind === "crossfade") {
      // The fade is timed on the music, not the file: learn where both the
      // playing track's sound ends and the next one's begins.
      if (target.videoId) this.learnEdges(target.videoId);
      if (target.preloadVideoId) this.learnEdges(target.preloadVideoId);
    }
    /*
     * The same track under a new epoch is the core starting it again: after
     * the connection came back (#7), or repeat-one. It gets a fresh set of
     * retries, and a deck that had failed or stopped loading is loaded
     * afresh, or the retries spent during the outage failed it at once.
     */
    const restarted = !changed && !!prev && prev.epoch !== target.epoch;
    const stuck = restarted && (this.deck.error !== null || this.stallShown);
    if (changed || restarted) {
      this.recoveries = 0;
      this.lastGoodAt = target.startAtMs / 1000;
      this.progressAt = performance.now();
      this.progressedSinceLoad = false;
      this.playedThisTrack = false;
      this.stallShown = false;
      this.reloading = false;
      this.reloads = 0;
    }
    if (stuck && target.videoId && this.loaded(this.deck, target.videoId)) {
      this.point(this.deck, target.videoId);
      if (target.startAtMs > 0) this.deck.currentTime = target.startAtMs / 1000;
    }
    const ms = target.transition.ms ?? 0;

    if (changed && this.loaded(this.deck, target.videoId)) {
      /*
       * Already playing it.
       *
       * A crossfade started here before the core caught up, so by the time
       * the new target arrives the track is a second or two in. Loading it
       * again would restart it — which is what made a crossfade sound like a
       * stutter back to the beginning.
       */
      this.fadingTo = null;
    } else if (changed) {
      const nextIsWarm = this.loaded(this.idle, target.videoId) && !this.idle.error;
      // A crossfade is for a track ending into the next. A skip is the
      // listener wanting the next track now, so it cuts.
      const wantsFade = target.transition.kind === "crossfade" && ms > 0 && !target.userChange;

      if (nextIsWarm && this.fadingTo !== target.videoId) {
        /*
         * The track we are moving to is already on the idle deck.
         *
         * Gapless gets a very short ramp rather than none at all: cutting a
         * gain from 0 to 1 in one sample is a click, and a click between
         * tracks is more noticeable than the gap it replaced.
         */
        const fade = wantsFade ? ms : 40;
        this.fadingTo = target.videoId;

        this.mixer.set(this.idle, 0);
        if (target.startAtMs > 0) this.idle.currentTime = target.startAtMs / 1000;
        void this.idle.play().catch(() => {
          /* handled by the error listener on that element */
        });
        this.mixer.crossfade(this.deck, this.idle, fade, 1);

        const outgoing = this.deck;
        this.active = 1 - this.active;
        this.release(outgoing, fade);
      } else if (this.fadingTo !== target.videoId) {
        // Nothing warm to fade into: load and cut.
        this.fadingTo = null;
        this.point(this.deck, target.videoId);
        this.mixer.set(this.deck, 1);
        if (target.startAtMs > 0) this.deck.currentTime = target.startAtMs / 1000;
      }
    } else {
      const el = this.playingDeck() ?? this.deck;
      if (Math.abs(el.currentTime * 1000 - target.startAtMs) > 1500) {
        // Only chase the target position when it has genuinely moved;
        // otherwise normal playback drift seeks on every reconcile.
        el.currentTime = target.startAtMs / 1000;
        // A seek is a new place to measure progress from, not progress.
        // And a new wait: if the audio there does not come, the core has to
        // hear "stalled" again, since the seek told it the track is playing.
        if (!this.reloading) {
          this.lastGoodAt = el.currentTime;
          this.progressAt = performance.now();
          this.stallShown = false;
        }
      }
    }

    if (this.loaded(this.deck, target.videoId)) this.fadingTo = null;

    this.mixer.setBaseVolume(target.volume);
    if (!this.mixer.available) {
      // No graph at all: the elements' own volume is the only control left.
      // It is still a gain, so it takes the same taper the graph would apply —
      // otherwise the slider would behave differently on this path.
      for (const el of this.decks) el.volume = perceptualGain(target.volume);
    }

    // Pressing play on a track whose load already failed: the element keeps
    // its error and would reject play() forever without reporting again, so
    // the player sat on "playing" in silence. Load it afresh instead.
    const retry = target.playing && !prev?.playing && this.deck.error !== null;
    if (retry && this.loaded(this.deck, target.videoId)) {
      this.recoveries = 0;
      this.point(this.deck, target.videoId);
      if (target.startAtMs > 0) this.deck.currentTime = target.startAtMs / 1000;
    }

    if (target.playing) {
      const deck = this.deck;
      void deck.play().catch((err) => {
        // NotAllowedError is the autoplay policy asking for a gesture, not a
        // broken track. Treating the two alike burned through the queue,
        // marking each track unplayable on the way past.
        if (err?.name === "NotAllowedError") {
          this.emit({ kind: "blocked", epoch: target.epoch });
          return;
        }
        // AbortError means our own next reconcile interrupted this play() —
        // a track change, a pause, a teardown. The track is untouched, and
        // reporting it faulted the queue one entry at a time.
        if (err?.name === "AbortError") return;
        // A source that failed to load rejects play() too, but the element's
        // error listener owns that failure: it retries, or asks why, first.
        // By the time this runs a retry may already have cleared deck.error,
        // so the rejection's name is what identifies it.
        if (err?.name === "NotSupportedError" || deck.error) {
          // Usually an error event follows and is handled there. When none
          // does (a deck with no usable source), report it after a moment,
          // or the track would sit on "playing" with nothing said.
          const seen = this.errorEvents;
          window.setTimeout(() => {
            if (this.errorEvents === seen && this.current?.epoch === target.epoch) {
              this.fail(target.epoch, String(err?.name ?? "play_rejected"));
            }
          }, UNANSWERED_REJECTION_MS);
          return;
        }
        this.fail(target.epoch, String(err?.name ?? "play_rejected"));
      });
      this.startTicker();
    } else {
      for (const el of this.decks) el.pause();
      this.stopTicker();
    }

    this.warmNext();
  }

  /*
   * Warms the next track on the idle deck, so a transition has something
   * to fade into rather than a load to wait for.
   *
   * Not while the idle deck is still fading out. Straight after a crossfade
   * the idle deck is the outgoing track, and the core's next target (which
   * arrives within milliseconds of the fade starting) names a new track to
   * preload. Loading it there replaced the outgoing song mid-fade and reset
   * its gain, so the crossfade became a plain cut to the next song.
   */
  private warmNext(retrying = false) {
    const id = this.current?.preloadVideoId;
    if (!id || this.idle === this.releasing) return;
    if (this.loaded(this.idle, id) || this.loaded(this.deck, id)) return;
    // Only the next track's failures matter; the rest are forgotten.
    for (const key of this.preloadFailures.keys()) if (key !== id) this.preloadFailures.delete(key);
    const failed = this.preloadFailures.get(id);
    if (failed && (failed.retryAt === Infinity || (!retrying && performance.now() < failed.retryAt))) return;
    this.point(this.idle, id, true);
    this.mixer.set(this.idle, 0);
  }

  /**
   * Clears a failed preload and tries it again later, a couple of times at
   * most (PRELOAD_RETRY_MS). Retried straight away, a refused stream turned
   * into hundreds of requests a minute.
   */
  private rewarmAfterError(el: HTMLAudioElement) {
    const id = currentVideoId(el);
    if (!id) return;
    const failed = this.preloadFailures.get(id) ?? { count: 0, retryAt: 0 };
    failed.count += 1;
    const delay = PRELOAD_RETRY_MS[failed.count - 1];
    failed.retryAt = delay === undefined ? Infinity : performance.now() + delay;
    this.preloadFailures.set(id, failed);
    window.setTimeout(() => {
      if (el !== this.idle || !el.error || el === this.releasing) return;
      el.removeAttribute("src");
      el.load();
      // The retry itself is due now; anything sooner waits for retryAt.
      this.warmNext(delay !== undefined);
    }, delay ?? 0);
  }

  /** Stops a deck once it has faded out, then lets it warm the next track. */
  private release(outgoing: HTMLAudioElement, fade: number) {
    this.releasing = outgoing;
    window.clearTimeout(this.releaseTimer);
    this.releaseTimer = window.setTimeout(() => {
      this.releasing = null;
      if (outgoing !== this.deck) {
        outgoing.pause();
        outgoing.removeAttribute("src");
        outgoing.load();
      }
      this.warmNext();
    }, fade + 120);
  }

  /**
   * The audio graph's level, for diagnostics. Null without a graph.
   *
   * Reports which track each deck holds as well, because the decks are
   * detached media elements: they never enter the document, so nothing
   * outside this class can find them to ask.
   */
  debugLevel() {
    const level = this.mixer.debugLevel(this.decks);
    if (!level) return null;
    return {
      ...level,
      tracks: this.decks.map((el) => currentVideoId(el)),
      active: this.active,
      // Whether the playing track's audible edges are known yet.
      edgesKnown: Boolean(this.current?.videoId && this.edges.has(this.current.videoId)),
      decks: this.decks.map((el) => ({
        id: currentVideoId(el),
        paused: el.paused,
        at: el.currentTime,
        dur: el.duration,
      })),
    };
  }

  /** Applies equaliser gains in decibels, one per band. */
  setEq(gains: number[]) {
    this.mixer.setEq(gains);
  }

  /**
   * Turns volume normalisation on or off, and picks what it aims for.
   *
   * Two mechanisms behind one switch. Tracks that publish their loudness get
   * an exact correction applied before they start; the rest fall back to the
   * leveller, which measures as it plays. The listener sets one thing and
   * does not need to know which one a given track got.
   */
  setNormalization(on: boolean, level: NormalizationLevel = "normal") {
    this.normalizing = on;
    this.target = NORMALIZATION_TARGETS[level] ?? NORMALIZATION_TARGETS.normal;
    if (!on) {
      this.mixer.setLevelling(false);
      this.mixer.clearTrackGains(this.decks);
      return;
    }
    // Whether to measure depends on what is playing, which reviewLevelling
    // decides once the loudness of the current track is known.
    this.reviewLevelling();
    // A level change has to reach what is already loaded, or it takes effect
    // only from the next track.
    for (const el of this.decks) {
      const id = currentVideoId(el);
      if (id) void this.normalise(el, id);
    }
  }

  /**
   * The deck actually holding the current track, or null.
   *
   * With two decks, "the active one" and "the one playing this track" can
   * disagree for a moment around a transition. Reporting a position from the
   * wrong deck tells the core the listener is somewhere they are not, and the
   * core believes it — a seek to 2:42 came straight back as 0:06 because the
   * idle deck answered first.
   */
  private playingDeck(): HTMLAudioElement | null {
    const want = this.current?.videoId;
    if (!want) return null;
    if (this.loaded(this.deck, want)) return this.deck;
    // A deck fading out still holds the old track until the core catches up
    // with the crossfade; flipping back to it would undo the transition.
    if (this.loaded(this.idle, want) && this.idle !== this.releasing) {
      // Self-heal: whichever deck holds the current track is the active one.
      this.active = 1 - this.active;
      return this.deck;
    }
    return null;
  }

  private startTicker() {
    if (this.ticker !== undefined) return;
    this.ticker = window.setInterval(() => {
      const el = this.playingDeck();
      // No report at all beats a wrong one: the core treats these as truth.
      if (!el) return;
      // While frozen, no position reports: each would clear the core's
      // "buffering" and put a stopped timer back on screen as "playing".
      if (this.watchForStall(el)) {
        this.maybeCrossfade(el);
        return;
      }
      this.emit({
        kind: "position",
        epoch: this.current?.epoch ?? 0,
        positionMs: Math.round(el.currentTime * 1000),
        // A live or still-loading stream reports Infinity or NaN.
        durationMs: Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0,
      });
      this.maybeCrossfade(el);
    }, 250);
  }

  /*
   * Begins a crossfade before the current track ends.
   *
   * The core advances when a track reports that it ended, which is too late
   * to fade anything: by then there is nothing left of the outgoing track to
   * fade out, and what you hear is the next one fading in on its own. A real
   * crossfade has to start while both tracks still have audio, and only the
   * engine knows the playhead closely enough to time it.
   *
   * So the engine starts it, then reports the end itself. The core advances
   * as it always did; it simply hears about it a few seconds earlier, which
   * is exactly the overlap the listener asked for.
   */
  private maybeCrossfade(playing: HTMLAudioElement) {
    const t = this.current;
    if (!t || !t.playing || this.fadingTo) return;
    if (t.transition.kind !== "crossfade") return;

    const ms = t.transition.ms ?? 0;
    if (ms <= 0 || !t.preloadVideoId) return;
    // Only into something already loaded, and buffered rather than merely
    // pointed at: a fade into a track still arriving fades into silence.
    if (!this.loaded(this.idle, t.preloadVideoId) || this.idle.readyState < 3) return;

    /*
     * Only once the element genuinely knows how long the track is.
     *
     * A media element reports a duration of NaN, and briefly a wrong one,
     * while it is still reading metadata. Trusting that makes "how much is
     * left" tiny at the very moment a track starts — which fires the fade
     * immediately and, because this also reports the end, advances the queue
     * out from under whatever the listener was doing. HAVE_METADATA and a
     * second of real playback are what make the figure meaningful.
     */
    if (playing.paused || playing.readyState < 1) return;
    if (!Number.isFinite(playing.duration) || playing.duration <= 0) return;
    if (playing.currentTime < 1) return;

    /*
     * Counted to the end of the sound, not the end of the file.
     *
     * Most files end with silence, some with several seconds of it. Timed
     * against the file, the fade spent itself on that silence: the music
     * stopped, the next song crept in late, and the transition sounded like
     * a gap. Spotify's crossfade is heard as one song flowing into the next,
     * and this is what that takes.
     */
    const measured = t.videoId ? this.edges.get(t.videoId) : undefined;
    // A measurement of part of the file is not a measurement of this track:
    // it once ended a nine-minute song at 0:30. Trusted only when it is as
    // long as what is playing.
    const sound =
      measured && Math.abs(measured.durationS - playing.duration) <= 2 ? measured : undefined;
    const end = sound ? Math.min(sound.endS, playing.duration) : playing.duration;
    // In real time, not track time: at 2× a second of track passes in half a
    // second, and a fade timed on the track would still be running when the
    // music ran out.
    const remaining = ((end - playing.currentTime) * 1000) / this.speed;
    if (!Number.isFinite(remaining) || remaining > ms) return;

    // Fade over what is actually left, so a short last track is not cut off
    // by a fade longer than the music remaining. Past the end of the sound
    // (a seek into the trailing silence), move on at once.
    const fade = Math.max(250, Math.min(ms, remaining));
    this.fadingTo = t.preloadVideoId;

    this.mixer.set(this.idle, 0);
    // From the next track's first sound, not the silence before it.
    const lead = this.edges.get(t.preloadVideoId)?.startS ?? 0;
    this.idle.currentTime = lead > 0.05 ? lead : 0;
    void this.idle.play().catch(() => {
      /* handled by the error listener on that element */
    });
    this.mixer.crossfade(playing, this.idle, fade, 1);

    const outgoing = playing;
    this.active = this.decks.indexOf(this.idle) === 0 ? 0 : 1;
    this.release(outgoing, fade);

    // Tell the core the track is done, so the queue moves with the sound.
    this.emit({ kind: "ended", epoch: t.epoch });
  }

  /*
   * A stall watchdog.
   *
   * A connection that stops delivering leaves the element waiting forever:
   * no error, no end, just silence with the pause button showing. So a deck
   * that should be playing and does not move is first reported as buffering,
   * after BUFFERING_MS, and then picked up again or failed (see STALL_MS).
   * Returns whether it is frozen, so no position report undoes the first.
   *
   * A seek is not exempt. A retry seeks back to where the track was, and when
   * the range it needs is refused the element stays "seeking" for good; with
   * seeking exempt the watchdog never fired and the player sat on "playing"
   * in silence until the app was restarted. A seek that lands within the
   * window moves currentTime, which counts as progress.
   */
  private watchForStall(el: HTMLAudioElement): boolean {
    const now = performance.now();
    const t = this.current;
    // A retry's reload leaves the element paused until it can play; that is
    // the wait being timed, not the listener pausing.
    if (!t?.playing || (el.paused && !this.reloading)) {
      this.progressAt = now;
      this.lastGoodAt = el.currentTime;
      this.stallShown = false;
      return false;
    }
    const moved = el.currentTime - this.lastGoodAt;
    if (!this.reloading && moved < 0 && this.recoveries === 0) {
      // Backwards outside a retry: someone scrubbed. Measure from here.
      this.lastGoodAt = el.currentTime;
      this.progressAt = now;
    } else if (!this.reloading && moved >= MIN_PROGRESS_S) {
      // Playing, not jumping: a seek resets lastGoodAt, so only what
      // actually played counts toward the refill below.
      this.playedSinceRetry += moved;
      this.lastGoodAt = el.currentTime;
      this.progressAt = now;
      this.progressedSinceLoad = true;
      this.playedThisTrack = true;
      this.stallShown = false;
      // A hiccup it came back from should not use up the track's retries.
      if (this.recoveries > 0 && this.playedSinceRetry >= RETRY_REFILL_S) this.recoveries = 0;
      return false;
    }
    const still = now - this.progressAt;
    if (still < BUFFERING_MS) return this.stallShown;
    if (!this.stallShown) {
      this.stallShown = true;
      this.emit({ kind: "stalled", epoch: t.epoch });
    }
    const limit = this.progressedSinceLoad
      ? STALL_MS
      : this.recoveries > 0 && this.playedThisTrack
        ? RECOVERY_STALL_MS
        : LOAD_STALL_MS;
    if (still < limit) return this.stallShown;
    this.progressAt = now;
    if (!this.recover(el)) this.fail(t.epoch, "stalled");
    return this.stallShown;
  }



  /*
   * Asks where a track's sound starts and ends. The file may not be ready, or
   * the request may give way to a track someone clicked, so a miss is asked
   * again while the track is in play — later each time, and not after
   * EDGE_RETRY_MS runs out, since every call re-applies the core's target
   * and a refused stream would otherwise be asked for every few seconds.
   */
  private learnEdges(videoId: string, retrying = false) {
    if (this.edges.has(videoId) || this.edgesAsking.has(videoId)) return;
    const failed = this.edgeFailures.get(videoId);
    if (failed && (failed.retryAt === Infinity || (!retrying && performance.now() < failed.retryAt))) return;
    this.edgesAsking.add(videoId);
    void audibleEdges(videoId, videoId !== this.current?.videoId).then((e) => {
      this.edgesAsking.delete(videoId);
      if (!e) {
        const miss = this.edgeFailures.get(videoId) ?? { count: 0, retryAt: 0 };
        miss.count += 1;
        const delay = EDGE_RETRY_MS[miss.count - 1];
        miss.retryAt = delay === undefined ? Infinity : performance.now() + delay;
        this.edgeFailures.set(videoId, miss);
        if (this.edgeFailures.size > 32)
          for (const id of this.edgeFailures.keys()) if (id !== videoId) this.edgeFailures.delete(id);
        const inPlay = videoId === this.current?.videoId || videoId === this.current?.preloadVideoId;
        if (inPlay && delay !== undefined) window.setTimeout(() => this.learnEdges(videoId, true), delay);
        return;
      }
      this.edgeFailures.delete(videoId);
      this.edges.set(videoId, e);
      // Only the tracks in play are worth keeping.
      if (this.edges.size > 32) {
        const keep = new Set([this.current?.videoId, this.current?.preloadVideoId]);
        for (const id of this.edges.keys()) if (!keep.has(id)) this.edges.delete(id);
      }
    });
  }

  private stopTicker() {
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  positionMs(): number {
    return Math.round((this.playingDeck() ?? this.deck).currentTime * 1000);
  }

  destroy() {
    this.stopTicker();
    for (const el of this.decks) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    this.mixer.destroy();
  }
}
