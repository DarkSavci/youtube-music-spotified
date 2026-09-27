import { apiUrl } from "./base";

/**
 * Getting tracks ready before they are asked for.
 *
 * Resolving a track through yt-dlp takes four to five seconds. The answer
 * Spotify and YouTube Music both use is to not be asked cold: the core keeps
 * audio on disk, and these calls tell it which tracks are likely next — the
 * one under the pointer, the top of the page just opened. The core stores
 * each one's opening, so a click starts from disk at once while the rest is
 * fetched behind it. The queue itself needs nothing from here: the core
 * prefetches what is coming up on its own.
 *
 * The core bounds the upstream work, remembers what it already has, and
 * stops when YouTube asks it to; this side only avoids asking twice.
 */

const asked = new Set<string>();

/** Why a track is warmed; the core ranks and drops speculative work by it. */
export type WarmReason = "hover" | "page" | "search";

/** Prepares a track's opening in the background. Cheap to call repeatedly. */
export function warmTrack(videoId: string | null | undefined, reason: WarmReason = "hover"): void {
  if (!videoId || asked.has(videoId)) return;
  asked.add(videoId);
  void fetch(apiUrl(`/v1/prefetch/${encodeURIComponent(videoId)}?reason=${reason}`), { method: "POST" }).catch(() => {
    // Not reachable right now; worth asking again later.
    asked.delete(videoId);
  });
}

/** The first playable track of a page: the likeliest to be played. */
export function warmFirst(
  tracks: { id: string; playable?: boolean }[] | undefined,
  count = 1,
  reason: WarmReason = "page",
): void {
  for (const t of (tracks ?? []).filter((t) => t.playable !== false).slice(0, count)) warmTrack(t.id, reason);
}

/*
 * Hover warming is rationed.
 *
 * Each warm-up is a yt-dlp lookup and a download from YouTube, and moving the
 * pointer down a long list used to queue one per row. So the pointer has to
 * rest on a row for a while — long enough to mean it — and only a handful are
 * warmed a minute; past that, hovering does nothing until the minute is up.
 */
const HOVER_DELAY_MS = 600;
const HOVER_PER_MINUTE = 6;
let hoverTimes: number[] = [];

function hoverAllowed(now: number): boolean {
  hoverTimes = hoverTimes.filter((t) => now - t < 60_000);
  if (hoverTimes.length >= HOVER_PER_MINUTE) return false;
  hoverTimes.push(now);
  return true;
}

/**
 * Warms a track once the pointer has settled on it.
 *
 * The delay separates intent from a pointer crossing the list on its way
 * somewhere else. Returns the canceller, for the matching mouse-leave.
 */
export function warmOnHover(videoId: string | null | undefined): () => void {
  if (!videoId || asked.has(videoId)) return () => {};
  const timer = window.setTimeout(() => {
    if (hoverAllowed(Date.now())) warmTrack(videoId, "hover");
  }, HOVER_DELAY_MS);
  return () => window.clearTimeout(timer);
}
