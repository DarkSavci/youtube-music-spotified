import type { Capabilities } from "./player";
import type { Engine, EngineEvent, Target } from "./engine";
import { MAX_SPEED, MIN_SPEED, type SpeedSupport } from "./speed";

/**
 * Embedded engine: plays through YouTube's own player.
 *
 * The fallback for accounts where native stream resolution is unavailable, and
 * the circuit breaker for the day the resolver breaks. It asks nothing of us —
 * no decipher, no proof-of-origin, no maintenance treadmill — because YouTube
 * is playing its own content in its own player.
 *
 * The cost is real and is reported honestly through `capabilities` rather than
 * hidden: the frame is cross-origin, so there is no Web Audio graph and
 * therefore no equaliser, no loudness normalisation and no visualiser. Volume
 * is an integer 0-100. Crossfade can only be approximated by running two
 * players and trading their volumes.
 */

const API_SRC = "https://www.youtube.com/iframe_api";

/** Player states, as the embedded API reports them. */
const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;

interface YTPlayer {
  loadVideoById(opts: { videoId: string; startSeconds?: number }): void;
  cueVideoById(opts: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  getAvailablePlaybackRates(): number[];
  destroy(): void;
}

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement | string, opts: Record<string, unknown>) => YTPlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

/** Loads the player API once, shared by every engine instance. */
let apiPromise: Promise<void> | null = null;

function loadAPI(): Promise<void> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve();

    const timeout = setTimeout(() => reject(new Error("player api timeout")), 15_000);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      previous?.();
      resolve();
    };

    const script = document.createElement("script");
    script.src = API_SRC;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("player api failed to load"));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

export class EmbeddedEngine implements Engine {
  readonly name = "embedded";

  /**
   * Capabilities are data, not a narrower interface. The UI reads these and
   * hides the equaliser rather than asking which engine is running, which is
   * what lets two very unalike engines share one seam.
   */
  readonly capabilities: Capabilities = {
    eq: false,
    crossfade: "approx",
    normalization: false,
    preciseSeek: false,
    volumeSteps: 101,
  };

  private player: YTPlayer | null = null;
  private host: HTMLElement;
  private current: Target | null = null;
  private emit: (e: EngineEvent) => void;
  private ticker?: number;
  private ready = false;
  private pendingTarget: Target | null = null;
  /** The speed asked for; applied once the player exists, and on every track. */
  private speed = 1;
  /** What YouTube offers for the loaded video; its usual list until it says. */
  private available: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  constructor(emit: (e: EngineEvent) => void) {
    this.emit = emit;

    // Offscreen rather than display:none — a hidden frame is throttled or
    // refused playback by some engines, while an offscreen one plays normally.
    this.host = document.createElement("div");
    this.host.setAttribute("aria-hidden", "true");
    Object.assign(this.host.style, {
      position: "fixed",
      width: "1px",
      height: "1px",
      left: "-9999px",
      top: "0",
      pointerEvents: "none",
    });
    document.body.appendChild(this.host);

    void this.init();
  }

  private async init() {
    try {
      await loadAPI();
    } catch (err) {
      this.emit({
        kind: "failed",
        epoch: this.current?.epoch ?? 0,
        reason: err instanceof Error ? err.message : "api_unavailable",
      });
      return;
    }
    if (!window.YT?.Player) return;

    const mount = document.createElement("div");
    this.host.appendChild(mount);

    this.player = new window.YT.Player(mount, {
      width: 1,
      height: 1,
      playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1 },
      events: {
        onReady: () => {
          this.ready = true;
          this.applySpeed();
          // A target may have arrived before the player existed; apply it now
          // rather than dropping it.
          if (this.pendingTarget) {
            const t = this.pendingTarget;
            this.pendingTarget = null;
            this.apply(t);
          }
        },
        onStateChange: (e: { data: number }) => this.onState(e.data),
        onError: (e: { data: number }) => {
          this.emit({
            kind: "failed",
            epoch: this.current?.epoch ?? 0,
            reason: `player_error_${e.data}`,
          });
        },
      },
    });
  }

  private onState(state: number) {
    const epoch = this.current?.epoch ?? 0;
    switch (state) {
      case PLAYING:
        // YouTube can reset the rate when a new video loads.
        this.applySpeed();
        this.emit({
          kind: "loaded",
          epoch,
          durationMs: Math.round((this.player?.getDuration() ?? 0) * 1000),
        });
        this.startTicker();
        break;
      case PAUSED:
        this.stopTicker();
        break;
      case BUFFERING:
        this.emit({ kind: "stalled", epoch });
        break;
      case ENDED:
        this.stopTicker();
        this.emit({ kind: "ended", epoch });
        break;
    }
  }

  apply(target: Target) {
    if (!this.ready || !this.player) {
      this.pendingTarget = target;
      this.current = target;
      return;
    }

    const prev = this.current;
    this.current = target;

    if (!target.videoId) {
      this.player.pauseVideo();
      this.stopTicker();
      return;
    }

    if (!prev || prev.videoId !== target.videoId) {
      const opts = { videoId: target.videoId, startSeconds: target.startAtMs / 1000 };
      if (target.playing) this.player.loadVideoById(opts);
      else this.player.cueVideoById(opts);
    } else if (Math.abs(this.player.getCurrentTime() * 1000 - target.startAtMs) > 2000) {
      // Seeking is coarser here than in the native engine, so only chase a
      // genuinely moved position rather than normal playback drift.
      this.player.seekTo(target.startAtMs / 1000, true);
    }

    // Volume is an integer here. A linear mapping sounds wrong at the quiet
    // end, so apply a perceptual curve before rounding.
    this.player.setVolume(Math.round(perceptual(target.volume) * 100));

    if (target.playing) this.player.playVideo();
    else this.player.pauseVideo();
  }

  private startTicker() {
    if (this.ticker !== undefined) return;
    this.ticker = window.setInterval(() => {
      if (!this.player) return;
      this.emit({
        kind: "position",
        epoch: this.current?.epoch ?? 0,
        positionMs: Math.round(this.player.getCurrentTime() * 1000),
        durationMs: Math.round((this.player.getDuration() || 0) * 1000),
      });
    }, 1000);
  }

  private stopTicker() {
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  positionMs(): number {
    return Math.round((this.player?.getCurrentTime() ?? 0) * 1000);
  }

  speeds(): SpeedSupport {
    return this.available;
  }

  setSpeed(rate: number) {
    this.speed = rate;
    this.applySpeed();
  }

  private applySpeed() {
    if (!this.player || !this.ready) return;
    try {
      const offered = this.player.getAvailablePlaybackRates();
      if (offered?.length) this.available = offered.filter((r) => r >= MIN_SPEED && r <= MAX_SPEED);
      if (this.player.getPlaybackRate() !== this.speed) this.player.setPlaybackRate(this.speed);
    } catch {
      /* the player is between videos; the next PLAYING state applies it */
    }
  }

  destroy() {
    this.stopTicker();
    try {
      this.player?.destroy();
    } catch {
      /* already torn down */
    }
    this.player = null;
    this.host.remove();
  }
}

/**
 * Maps a linear 0-1 control onto perceived loudness.
 *
 * Human hearing is roughly logarithmic, so a linear slider feels dead across
 * its upper half and lurches near the bottom. Squaring is a cheap
 * approximation that behaves much better.
 */
function perceptual(v: number): number {
  const clamped = Math.min(1, Math.max(0, v));
  return clamped * clamped;
}
