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

/** Prepares a track's opening in the background. Cheap to call repeatedly. */
export function warmTrack(videoId: string | null | undefined): void {
  if (!videoId || asked.has(videoId)) return;
  asked.add(videoId);
  void fetch(apiUrl(`/v1/prefetch/${encodeURIComponent(videoId)}`), { method: "POST" }).catch(() => {
    // Not reachable right now; worth asking again later.
    asked.delete(videoId);
  });
}

/** The first few playable tracks of a page: the likeliest to be played. */
export function warmFirst(
  tracks: { id: string; playable?: boolean }[] | undefined,
  count = 3,
): void {
  for (const t of (tracks ?? []).filter((t) => t.playable !== false).slice(0, count)) warmTrack(t.id);
}

/**
 * Warms a track once the pointer has settled on it.
 *
 * The short delay separates intent from a pointer crossing the list on its
 * way somewhere else. Returns the canceller, for the matching mouse-leave.
 */
export function warmOnHover(videoId: string | null | undefined): () => void {
  if (!videoId) return () => {};
  const timer = window.setTimeout(() => warmTrack(videoId), 150);
  return () => window.clearTimeout(timer);
}
