import type { Track } from "./types";
import type { Capabilities } from "./player";
import { apiUrl } from "./base";

/**
 * Client for the authoritative session.
 *
 * Playback state lives in the Go core, not here. This module sends intents and
 * applies the projections that come back, which is what lets playback survive
 * the window closing and lets another device take over mid-track.
 *
 * The same transport serves the local sidecar and, later, a remote device —
 * the single-device case is the degenerate multi-device case, so there is no
 * separate "local" path to keep working.
 */

export interface SessionTrack extends Track {}

export interface SessionState {
  version: number;
  epoch: number;
  queue: { items: SessionTrack[]; index: number; origin?: string };
  state: "idle" | "loading" | "playing" | "paused" | "stalled";
  repeat: "off" | "one" | "all";
  shuffle: boolean;
  volume: number;
  positionMs: number;
  positionAt: string;
  ownerDeviceId?: string;
  degraded?: { index: number; reason: string }[];
}

export interface SessionTarget {
  Epoch: number;
  VideoID: string;
  StartAtMs: number;
  Playing: boolean;
  PreloadVideoID?: string;
  Volume: number;
  Transition: { Kind: string; Ms?: number };
  /** Set when the listener chose this track themselves: it cuts, never fades. */
  UserChange?: boolean;
}

export interface SessionDevice {
  id: string;
  name: string;
  owner: boolean;
  capabilities: Capabilities;
}

export interface Projection {
  followingRoom?: boolean;
  state: SessionState;
  target: SessionTarget;
  devices: SessionDevice[];
  capabilities: Capabilities;
}

export type Command =
  | { Kind: "switch_variant"; ExpectedID: string; Tracks: Track[] }
  | { Kind: "follow_room"; Tracks: Track[]; StartIndex?: number; ExpectedID?: string; PositionMs: number; Playing: boolean }
  | { Kind: "leave_room" }
  | { Kind: "play"; Tracks: Track[]; StartIndex: number; Origin: string }
  | { Kind: "toggle" }
  | { Kind: "next" }
  | { Kind: "prev" }
  | { Kind: "seek"; PositionMs: number }
  | { Kind: "set_repeat"; Repeat: "off" | "one" | "all" }
  | { Kind: "set_shuffle"; Shuffle: boolean }
  | { Kind: "set_volume"; Volume: number }
  | { Kind: "enqueue"; Insert: Track[]; At: number }
  | { Kind: "remove"; At: number }
  | { Kind: "move"; From: number; To: number }
  | { Kind: "transfer"; DeviceID: string }
  | { Kind: "jump"; At: number };

export interface EngineReport {
  Kind: "loaded" | "position" | "ended" | "failed" | "stalled" | "blocked";
  Epoch: number;
  PositionMs?: number;
  DurationMs?: number;
  Reason?: string;
}

/**
 * A stable per-install identifier.
 *
 * Persisted so a reload rejoins as the same device rather than accumulating
 * ghost entries in the device list on every refresh.
 */
function deviceID(): string {
  const KEY = "spotifier.deviceId";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const fresh = globalThis.crypto?.randomUUID?.() ?? `dev-${Date.now()}`;
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    // Storage blocked: a per-session identifier still works, it just will not
    // be recognised across reloads.
    return `dev-${Date.now()}`;
  }
}

export class SessionClient {
  readonly deviceID = deviceID();
  private source: EventSource | null = null;
  private onProjection: (p: Projection) => void;
  private connected = false;
  private retryMs = 1000;

  constructor(onProjection: (p: Projection) => void) {
    this.onProjection = onProjection;
  }

  /** Announces this device and begins streaming projections. */
  async start(name: string, capabilities: Capabilities): Promise<boolean> {
    try {
      const res = await fetch(apiUrl("/v1/session/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: this.deviceID, name, capabilities }),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { projection: Projection };
      this.onProjection(body.projection);
      this.connect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Opens the projection stream.
   *
   * EventSource reconnects on its own, but only for transport-level drops; a
   * server restart closes the stream in a way that needs an explicit retry, so
   * both are handled with a backoff.
   */
  private connect() {
    if (this.source) return;
    const url = apiUrl(`/v1/session/events?deviceId=${encodeURIComponent(this.deviceID)}`);
    const source = new EventSource(url);
    this.source = source;

    source.addEventListener("projection", (e) => {
      this.connected = true;
      this.retryMs = 1000;
      try {
        this.onProjection(JSON.parse((e as MessageEvent).data) as Projection);
      } catch {
        /* a malformed frame is superseded by the next full snapshot */
      }
    });

    source.onerror = () => {
      // Every projection is a complete snapshot, so a reconnect needs no
      // replay: the first message after reconnecting is current state.
      source.close();
      this.source = null;
      this.connected = false;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 15_000);
    };
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Sends an intent. The projection that comes back is applied immediately. */
  async command(command: Command): Promise<boolean> {
    try {
      const res = await fetch(apiUrl("/v1/session/command"), {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: this.deviceID, command }),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { rejected: string; projection: Projection };
      if (body.rejected) {
        // A rejection is a normal outcome — an empty queue, an out-of-range
        // edit — not an error to surface.
        console.debug("[session] command rejected:", body.rejected);
      }
      this.onProjection(body.projection);
      return !body.rejected;
    } catch {
      return false;
    }
  }

  /** Plays a track and makes its radio the queue, as YouTube Music does. */
  async startRadio(track: unknown, origin?: string): Promise<void> {
    try {
      const res = await fetch(apiUrl("/v1/session/radio"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: this.deviceID, track, origin }),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { projection: Projection };
      this.onProjection(body.projection);
    } catch {
      /* the stream will deliver the authoritative state regardless */
    }
  }

  /** Reports what this device's engine is doing. */
  report(event: EngineReport): void {
    void fetch(apiUrl("/v1/session/engine-event"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: this.deviceID, event }),
      keepalive: true,
    }).catch(() => {
      /* position reports are frequent and individually disposable */
    });
  }

  /** Updates capabilities, which change when an engine falls back. */
  setCapabilities(capabilities: Capabilities): void {
    void fetch(apiUrl("/v1/session/capabilities"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: this.deviceID, capabilities }),
    }).catch(() => {});
  }

  stop(): void {
    this.source?.close();
    this.source = null;
    this.connected = false;
  }
}
