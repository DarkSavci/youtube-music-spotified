import { apiUrl } from "./base";

/**
 * Where a track's sound actually starts and ends.
 *
 * Files carry silence: a second or two of lead-in, and often several
 * seconds after the last note — more on albums mastered with a gap between
 * tracks. A crossfade timed against the file's edges then fades the next
 * song in over that silence, which is heard as the music stopping, a pause,
 * and a late fade-in rather than one song flowing into the next. Timed
 * against the sound instead, the overlap lands on music at both ends.
 */
export interface Edges {
  /** First moment with sound, in seconds. */
  startS: number;
  /** Last moment with sound, in seconds. */
  endS: number;
  durationS: number;
}

/** Decoded at a low rate: this only needs loudness over time, not fidelity. */
const RATE = 8000;
/** Loudness is measured over windows this long. */
const WINDOW_S = 0.05;
/** Below this, a window is silence: -48 dBFS. */
const SILENT = Math.pow(10, -48 / 20);
/** At most this much is trimmed from either end, so a quiet intro or a
 *  hidden track after a long gap is never mistaken for silence to skip. */
const MAX_LEAD_S = 6;
const MAX_TAIL_S = 20;

const known = new Map<string, Promise<Edges | null>>();

/** A track's audible edges, measured once and remembered. Null when the
 *  track cannot be read — the caller then uses the file's own edges. */
export function audibleEdges(videoId: string, preload = true): Promise<Edges | null> {
  let pending = known.get(videoId);
  if (!pending) {
    pending = measure(videoId, preload).catch(() => null);
    known.set(videoId, pending);
    // A failure is not remembered: the file may simply not be cached yet.
    void pending.then((e) => {
      if (!e) known.delete(videoId);
    });
  }
  return pending;
}

// The playing track is read as itself; the next one as a preload, so reading
// it never holds up a track someone is waiting for.
async function measure(videoId: string, preload: boolean): Promise<Edges | null> {
  const res = await fetch(apiUrl(`/v1/stream/${encodeURIComponent(videoId)}${preload ? "?preload=1" : ""}`));
  if (!res.ok) return null;
  const bytes = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, RATE);
  const audio = await ctx.decodeAudioData(bytes);
  return edgesOf(audio);
}

/** The audible edges of decoded audio. Exported for tests. */
export function edgesOf(audio: AudioBuffer): Edges {
  const rate = audio.sampleRate;
  const win = Math.max(1, Math.round(rate * WINDOW_S));
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
  const frames = Math.floor(audio.length / win);
  const loud = (f: number) => {
    let sum = 0;
    for (const data of channels) {
      for (let i = f * win; i < (f + 1) * win; i++) sum += data[i]! * data[i]!;
    }
    return Math.sqrt(sum / (win * channels.length)) >= SILENT;
  };

  const durationS = audio.duration;
  let first = 0;
  while (first < frames && !loud(first)) first++;
  let last = frames - 1;
  while (last > first && !loud(last)) last--;

  const startS = Math.min(first * WINDOW_S, MAX_LEAD_S);
  const endS = Math.max((last + 1) * WINDOW_S, durationS - MAX_TAIL_S);
  return { startS, endS: Math.min(endS, durationS), durationS };
}

// For measuring from the diagnostics harness.
(window as unknown as { __edges?: typeof audibleEdges }).__edges = audibleEdges;
