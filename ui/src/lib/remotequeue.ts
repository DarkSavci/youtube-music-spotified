import type { RemoteQueue, Track } from "./types";

/**
 * Carrying on from the queue the account has on another device.
 *
 * YouTube Music's website reads that queue at start-up; this app reads it
 * when asked, and at launch only with the setting on, since every request
 * counts against the account's budget.
 * The dependencies are passed in so the decision can be tested on its own.
 */
export type ContinueResult = "played" | "empty" | "failed";

export interface ContinueDeps {
  fetchQueue: () => Promise<RemoteQueue>;
  play: (tracks: Track[], index: number, origin: string) => void;
  toast: (message: string) => void;
}

export async function continueFromRemote(deps: ContinueDeps): Promise<ContinueResult> {
  let q: RemoteQueue;
  try {
    q = await deps.fetchQueue();
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    deps.toast(
      status === 429
        ? "YouTube is limiting requests right now. Try again in a few minutes."
        : "Couldn't read your queue from YouTube Music.",
    );
    return "failed";
  }
  const picked = pickRemote(q);
  if (!picked) {
    deps.toast("Nothing is queued on your other devices.");
    return "empty";
  }
  deps.play(picked.tracks, picked.start, picked.origin);
  return "played";
}

/**
 * What of a remote queue can be played here, and where to start.
 *
 * Unplayable entries are left out; the one the other device was on is kept
 * as the place to start, or the first playable one after it. Null when
 * nothing playable is left.
 */
export function pickRemote(q: RemoteQueue | null | undefined): { tracks: Track[]; start: number; origin: string } | null {
  const all = q?.tracks ?? [];
  const current = Math.min(Math.max(q?.index ?? 0, 0), Math.max(all.length - 1, 0));
  const tracks: Track[] = [];
  let start = -1;
  all.forEach((t, i) => {
    if (t.playable === false) return;
    if (start < 0 && i >= current) start = tracks.length;
    tracks.push(t);
  });
  if (tracks.length === 0) return null;
  if (start < 0) start = tracks.length - 1;
  return { tracks, start, origin: q?.title?.trim() || "YouTube Music" };
}

/**
 * The launch-time pick-up, behind the "Continue from YouTube Music" setting.
 *
 * Quiet where the button is not: nobody asked at this moment, so a failed or
 * empty read says nothing and changes nothing. The queue is put in place
 * paused, and only if nothing started playing here while it was being read.
 * Already on the same song, it is left alone: this device kept up.
 */
export type LaunchResult = "loaded" | "empty" | "failed" | "busy" | "same";

export interface LaunchDeps {
  fetchQueue: () => Promise<RemoteQueue>;
  idle: () => Promise<boolean>;
  currentId: () => string | undefined;
  load: (tracks: Track[], index: number, origin: string) => Promise<boolean>;
  toast: (message: string) => void;
}

export async function continueOnLaunch(deps: LaunchDeps): Promise<LaunchResult> {
  if (!(await deps.idle())) return "busy";
  let q: RemoteQueue;
  try {
    q = await deps.fetchQueue();
  } catch {
    return "failed";
  }
  const picked = pickRemote(q);
  if (!picked) return "empty";
  if (!(await deps.idle())) return "busy";
  const first = picked.tracks[picked.start];
  if (first && deps.currentId() === first.id) return "same";
  if (!(await deps.load(picked.tracks, picked.start, picked.origin))) return "failed";
  deps.toast(`Picked up your queue from YouTube Music${first ? `: ${first.title}` : "."}`);
  return "loaded";
}
