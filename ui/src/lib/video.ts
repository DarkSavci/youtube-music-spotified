import { create } from "zustand";
import { apiUrl } from "./base";
import { usePlayer, currentPosition } from "./player";
import { switchTrackVariant } from "./playback";
import type { Track } from "./types";

export const useVideo = create(() => ({ enabled: false, busy: false, loading: false, error: null as string | null, revision: 0, availabilityID: "", availability: "checking" as "checking" | "available" | "unavailable" | "error" }));
const versions = new Map<string, Track[]>();
let request = 0;

const pendingVersions = new Map<string, Promise<Track[]>>();
async function loadVersions(track: Track): Promise<Track[]> {
  const cached = versions.get(track.id);
  if (cached) return cached;
  const pending = pendingVersions.get(track.id);
  if (pending) return pending;
  const task = (async () => {
    const response = await fetch(apiUrl(`/v1/tracks/${encodeURIComponent(track.id)}/versions`));
    if (!response.ok) throw new Error("Could not check for a music video. Please try again.");
    const pair = await response.json() as Track[];
    if (versions.size > 100) versions.clear();
    for (const version of pair) versions.set(version.id, pair);
    versions.set(track.id, pair);
    return pair;
  })();
  pendingVersions.set(track.id, task);
  try { return await task; } finally { pendingVersions.delete(track.id); }
}

/**
 * Whether a track is the video version. Its own flag can be missing: a queue
 * saved by an older version, or a list that does not report it, still holds
 * the video's id. YouTube's version list for that id settles it.
 */
export function isVideoTrack(track: Track | null | undefined): boolean {
  if (!track) return false;
  return track.isVideo || Boolean(versions.get(track.id)?.some(v => v.id === track.id && v.isVideo));
}

export async function checkVideoAvailability() {
  const track = usePlayer.getState().track;
  if (!track) return;
  useVideo.setState({ availabilityID: track.id, availability: track.isVideo ? "available" : "checking" });
  if (track.isVideo) return;
  try {
    const pair = await loadVersions(track);
    if (usePlayer.getState().track?.id === track.id) useVideo.setState({
      availabilityID: track.id, availability: pair.some(t => t.isVideo && t.playable) ? "available" : "unavailable",
    });
  } catch {
    if (usePlayer.getState().track?.id === track.id) useVideo.setState({ availabilityID: track.id, availability: "error" });
  }
}

export async function setVideoEnabled(enabled: boolean) {
  const track = usePlayer.getState().track;
  if (!track) return;
  const generation = ++request;
  useVideo.setState({ busy: true, error: null });
  // Hiding pictures always works, including while following a room.
  if (!enabled) useVideo.setState({ enabled: false });
  try {
    let pair: Track[];
    try { pair = await loadVersions(track); }
    catch (error) { if (isVideoTrack(track) || !enabled) pair = [track]; else throw error; }
    if (generation !== request || usePlayer.getState().track?.id !== track.id) return;
    useVideo.setState({ availabilityID: track.id, availability: isVideoTrack(track) || pair.some(t => t.isVideo && t.playable) ? "available" : "unavailable" });
    const alternative = pair?.find(t => t.playable && t.isVideo === enabled);
    if (enabled && !isVideoTrack(track) && !alternative) throw new Error("No matching music video is available for this song.");
    if (alternative && alternative.id !== track.id) {
      if (usePlayer.getState().followingRoom) {
        // Hiding the picture is enough; the host picks the version.
        if (enabled) throw new Error("The host chooses the song or video version. You can watch the current video when the host selects it.");
      } else if (!await switchTrackVariant(alternative, track.id)) throw new Error("Could not switch versions. Please try again.");
    }
    if (generation === request) useVideo.setState({ enabled, error: null, revision: useVideo.getState().revision + 1 });
  } catch (error) {
    if (generation === request) useVideo.setState({ enabled: false, error: error instanceof Error ? error.message : "Video unavailable." });
  } finally {
    if (generation === request) useVideo.setState({ busy: false });
  }
}

/** One muted picture element shared by main, fullscreen and mini-player views.
 * The existing audio engine remains the only sound source and timeline owner.
 * Moving the view never sends a play/seek command back to the music session. */
const hosts = new Map<HTMLElement, number>();
let picture: HTMLVideoElement | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let currentKey = "";
let attemptingPlay = false;
let waiting = false;

function tick() {
  if (!picture) return;
  const state = usePlayer.getState();
  const options = useVideo.getState();
  const key = options.enabled && !options.busy && state.track && isVideoTrack(state.track) ? `${state.track.id}:${options.revision}` : "";
  if (key !== currentKey) {
    currentKey = key;
    waiting = false;
    picture.pause();
    picture.removeAttribute("src");
    picture.load();
    useVideo.setState({ loading: Boolean(key), error: null });
    if (key && state.track) picture.src = apiUrl(`/v1/video-stream/${encodeURIComponent(state.track.id)}`);
  }
  if (!key || picture.readyState < 1 || picture.error) return;
  const position = currentPosition(state) / 1000;
  const target = Number.isFinite(picture.duration) ? Math.min(position, Math.max(0, picture.duration - 0.05)) : position;
  if (!picture.seeking && !waiting) {
    const drift = target - picture.currentTime;
    // Drift is closed by nudging the picture 5% either side of the playback
    // speed, so a sped-up track keeps its video in step.
    if (Math.abs(drift) > 2 || (state.state !== "playing" && Math.abs(drift) > 0.35)) picture.currentTime = target;
    else picture.playbackRate = (state.speed || 1) * (Math.abs(drift) > 0.1 ? (drift > 0 ? 1.05 : 0.95) : 1);
  }
  const playing = state.state === "playing";
  if (!playing) { picture.pause(); return; }
  if (picture.paused && !attemptingPlay && !picture.ended) {
    attemptingPlay = true;
    void picture.play().catch(() => {
      // A move between windows or a new source can interrupt play normally.
    }).finally(() => { attemptingPlay = false; });
  }
}

function place() {
  const host = [...hosts].sort((a,b) => b[1]-a[1])[0]?.[0];
  if (!host) {
    // React cleans up the old view before attaching the new one. Keep the
    // element through that commit so fullscreen does not restart its stream.
    queueMicrotask(() => {
      if (hosts.size) return;
      clearInterval(timer); timer = undefined;
      picture?.pause(); picture?.removeAttribute("src"); picture?.load(); picture?.remove();
      picture = null; currentKey = "";
    });
    return;
  }
  if (!picture) {
    picture = document.createElement("video");
    picture.crossOrigin = "anonymous";
    picture.muted = true;
    picture.defaultMuted = true;
    picture.playsInline = true;
    picture.controls = false;
    picture.preload = "auto";
    picture.setAttribute("aria-label", "Music video");
    const element = picture;
    const update = (patch: Partial<ReturnType<typeof useVideo.getState>>) => { if (picture === element) useVideo.setState(patch); };
    picture.addEventListener("loadedmetadata", tick);
    picture.addEventListener("playing", () => { waiting = false; update({ loading: false }); });
    picture.addEventListener("canplay", () => { waiting = false; });
    picture.addEventListener("loadeddata", () => { waiting = false; update({ loading: false }); });
    picture.addEventListener("waiting", () => { waiting = true; update({ loading: true }); });
    picture.addEventListener("error", () => update({ loading: false, error: "The video could not be loaded. You can keep listening or retry." }));
    timer = setInterval(tick, 100);
  }
  if (picture.parentElement !== host) host.appendChild(picture);
  tick();
}

export function attachVideo(host: HTMLElement, priority: number) {
  hosts.set(host, priority); place();
  return () => { hosts.delete(host); place(); };
}
export function retryVideo() { useVideo.setState({ error: null, revision: useVideo.getState().revision + 1 }); }
