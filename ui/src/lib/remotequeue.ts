import type { RemoteQueue, Track } from "./types";

/**
 * Carrying on from the queue the account has on another device.
 *
 * YouTube Music's website reads that queue at start-up; this app reads it
 * only when asked, since every request counts against the account's budget.
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
  const all = q?.tracks ?? [];
  // Unplayable entries are left out; the one the other device was on is
  // kept as the place to start, or the first playable one after it.
  const current = Math.min(Math.max(q?.index ?? 0, 0), Math.max(all.length - 1, 0));
  const tracks: Track[] = [];
  let start = -1;
  all.forEach((t, i) => {
    if (t.playable === false) return;
    if (start < 0 && i >= current) start = tracks.length;
    tracks.push(t);
  });
  if (tracks.length === 0) {
    deps.toast("Nothing is queued on your other devices.");
    return "empty";
  }
  if (start < 0) start = tracks.length - 1;
  deps.play(tracks, start, q.title?.trim() || "YouTube Music");
  return "played";
}
