/**
 * When to give up on the native engine, and when to try it again.
 *
 * One failure is an unavailable track and skipping it is correct. Failures on
 * several different tracks in a row mean the resolver itself is broken (an
 * upstream change, an expired session, a blocked address), and continuing to
 * skip would silently race to the end of the queue.
 *
 * What counts is distinct tracks. One dead track used to arrive as a burst of
 * identical reports, which tripped the fallback by itself; a report for a
 * track already counted is therefore ignored here.
 *
 * Falling back is not for good. The broken thing is usually transient, and the
 * embedded player gives up the equaliser, crossfade and normalisation. So
 * after a while the next track change tries the native engine again, and it
 * earns its place back by loading.
 */
export interface FailureLadder {
  /**
   * A failure report; "fallback" when this one should swap the engine.
   * `current` is the track now meant to play: a report for any other (a
   * preload, a load the queue already left) is stale and not counted.
   */
  failed(epoch: number, current?: number | null): "fallback" | "counted" | "duplicate" | "stale";
  /** A track loaded: the resolver works, so the run of failures is over. */
  loaded(): void;
  /**
   * A position report. A track that plays from a deck warmed in advance
   * (gapless, crossfade) never reports "loaded", so actual progress on the
   * current track ends the run of failures too.
   */
  progress(epoch: number, positionMs: number): void;
  /** At a track change: whether to leave the fallback and retry native. */
  retryNative(): boolean;
  /** Whether playback is currently on the fallback engine. */
  readonly fellBack: boolean;
  reset(): void;
}

export function failureLadder(
  threshold: number,
  retryAfterMs: number,
  now: () => number = () => Date.now(),
): FailureLadder {
  let failures = 0;
  let lastEpoch: number | null = null;
  let fellBack = false;
  let fellBackAt = 0;
  // The first position seen for the current epoch, to tell progress apart
  // from a report of where a stalled track is stuck.
  let seen: { epoch: number; positionMs: number } | null = null;
  return {
    failed(epoch, current) {
      if (current != null && epoch !== current) return "stale";
      if (epoch === lastEpoch) return "duplicate";
      lastEpoch = epoch;
      failures += 1;
      if (fellBack || failures < threshold) return "counted";
      fellBack = true;
      fellBackAt = now();
      return "fallback";
    },
    loaded() {
      failures = 0;
      lastEpoch = null;
    },
    progress(epoch, positionMs) {
      if (seen?.epoch !== epoch) {
        seen = { epoch, positionMs };
        return;
      }
      if (positionMs - seen.positionMs < 1000) return;
      seen = { epoch, positionMs };
      failures = 0;
      lastEpoch = null;
    },
    retryNative() {
      if (!fellBack || now() - fellBackAt < retryAfterMs) return false;
      fellBack = false;
      failures = 0;
      lastEpoch = null;
      return true;
    },
    get fellBack() {
      return fellBack;
    },
    reset() {
      failures = 0;
      lastEpoch = null;
      fellBack = false;
      fellBackAt = 0;
    },
  };
}
