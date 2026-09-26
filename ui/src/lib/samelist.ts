import type { Track } from "./types";

/**
 * Whether playing `tracks` at `index` means the song already playing, in the
 * list already queued — in which case it resumes rather than restarts.
 *
 * Only within that list: the same origin and every song already queued. A
 * different list that happens to start on the current song (an artist's Play
 * after one of their Popular rows, or a Shuffle whose first pick is the song
 * playing) is a request for that list, and replaces the queue.
 */
export function isCurrentList(
  now: { track: Track | null; queue: Track[]; origin: string },
  tracks: Track[],
  index: number,
  origin: string,
): boolean {
  const clicked = tracks[index];
  if (!clicked || now.track?.id !== clicked.id || now.origin !== origin) return false;
  const queued = new Set(now.queue.map((t) => t.id));
  return tracks.every((t) => queued.has(t.id));
}
