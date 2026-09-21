import type { Track } from "./types";
import { apiUrl } from "./base";

/**
 * Play-log reporting.
 *
 * Events are buffered and flushed in batches rather than sent per track, so a
 * burst of skipping does not become a burst of requests.
 *
 * Each event carries a client-generated identifier and the server write is
 * idempotent on it. That is what makes retrying safe: a dropped connection
 * would otherwise either lose a listen or double-count one, and a
 * double-counted listen silently corrupts every statistic derived from it.
 */

export interface PlayEvent {
  EventUUID: string;
  TrackID: string;
  Title: string;
  Artist: string;
  ArtistID: string;
  Album: string;
  AlbumID: string;
  PlayedMs: number;
  Completed: boolean;
  Failed: boolean;
  FailReason: string;
  Origin: string;
  PlayedAt: string;
}

const STORAGE_KEY = "spotifier.playlog.pending";
const FLUSH_INTERVAL_MS = 15_000;
const MAX_BATCH = 100;

let pending: PlayEvent[] = loadPending();
let timer: number | undefined;

function uuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Pending events survive a reload.
 *
 * Without this, closing the app with unflushed events loses listening history
 * that cannot be reconstructed — the whole point of keeping our own log.
 */
function loadPending(): PlayEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PlayEvent[]) : [];
  } catch {
    return [];
  }
}

function savePending() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pending.slice(-500)));
  } catch {
    /* storage blocked; events still flush from memory this session */
  }
}

/** Records a listen. The identifier is assigned here so a retry is idempotent. */
export function recordPlay(
  track: Track,
  opts: { playedMs: number; completed?: boolean; failed?: boolean; failReason?: string; origin?: string },
) {
  const artist = track.artists?.[0];
  pending.push({
    EventUUID: uuid(),
    TrackID: track.id,
    Title: track.title,
    Artist: artist?.name ?? "",
    ArtistID: artist?.id ?? "",
    Album: track.album?.name ?? "",
    AlbumID: track.album?.id ?? "",
    PlayedMs: Math.max(0, Math.round(opts.playedMs)),
    Completed: Boolean(opts.completed),
    Failed: Boolean(opts.failed),
    FailReason: opts.failReason ?? "",
    Origin: opts.origin ?? "",
    PlayedAt: new Date().toISOString(),
  });
  savePending();
  scheduleFlush();
}

function scheduleFlush() {
  if (timer !== undefined) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

/** Sends buffered events. Safe to call at any time. */
export async function flush(): Promise<void> {
  if (pending.length === 0) return;
  const batch = pending.slice(0, MAX_BATCH);

  try {
    const res = await fetch(apiUrl("/v1/me/plays"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plays: batch }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);

    // Only drop what was accepted. Anything queued while the request was in
    // flight stays put rather than being discarded with the batch.
    pending = pending.slice(batch.length);
    savePending();
    if (pending.length > 0) scheduleFlush();
  } catch {
    // Keep the events and try again later. Losing history to a transient
    // network fault would be worse than sending it late.
    scheduleFlush();
  }
}

/**
 * Flush on the way out.
 *
 * `visibilitychange` rather than `beforeunload`: the latter is unreliable when
 * a window is closed abruptly, and `keepalive` lets the request outlive the
 * page.
 */
export function installFlushHooks() {
  const flushBeacon = () => {
    if (pending.length === 0) return;
    try {
      const blob = new Blob([JSON.stringify({ plays: pending.slice(0, MAX_BATCH) })], {
        type: "application/json",
      });
      if (navigator.sendBeacon(apiUrl("/v1/me/plays"), blob)) {
        pending = pending.slice(MAX_BATCH);
        savePending();
      }
    } catch {
      /* best effort; the events remain queued for next launch */
    }
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushBeacon();
  });
  window.addEventListener("pagehide", flushBeacon);
}

export function pendingCount(): number {
  return pending.length;
}
