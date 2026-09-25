import { useEffect, useRef } from "react";
import { attachVideo, isVideoTrack, retryVideo, setVideoEnabled, useVideo } from "../lib/video";
import { IconExpand, IconVideo } from "./Icon";
import { usePlayer } from "../lib/player";

export function useVideoControl() {
  const availabilityID = useVideo(s => s.availabilityID);
  const availability = useVideo(s => s.availability);
  const busy = useVideo(s => s.busy);
  const track = usePlayer(s => s.track);
  const following = usePlayer(s => s.followingRoom);
  const video = isVideoTrack(track);
  const status = video ? "available" : availabilityID === track?.id ? availability : "checking";
  const reason = busy ? "Switching playback format…"
    : !track ? "Play a song to watch its video."
    : following && !video ? "The Listen Together host chooses the video version."
    : status === "checking" ? "Checking for a music video…"
    : status === "unavailable" ? "No matching music video is available for this song."
    : status === "error" ? "Could not check video availability. Click to retry."
    : "Watch music video";
  return { blocked: busy || !track || (following && !video) || status === "checking" || status === "unavailable", reason };
}

/** Song/video toggle: one icon, lit while the video shows, as in the mini player. */
export function VideoSwitch() {
  const enabled = useVideo(s => s.enabled);
  const busy = useVideo(s => s.busy);
  const { blocked, reason } = useVideoControl();
  const track = usePlayer(s => s.track);
  if (!track) return null;
  return <button
    className="iconbtn video-toggle"
    // The app's tooltip reads aria-label; a title would show a second one.
    aria-label={enabled ? "Switch to song" : reason}
    aria-pressed={enabled}
    aria-busy={busy}
    data-active={enabled || undefined}
    aria-disabled={enabled ? busy : blocked}
    onClick={() => { if (!(enabled ? busy : blocked)) void setVideoEnabled(!enabled); }}
  ><IconVideo size={18} /></button>;
}

export function VideoSurface({ priority = 0, className = "", onExpand }: { priority?: number; className?: string; onExpand?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = useVideo(s => s.enabled);
  const loading = useVideo(s => s.loading);
  const error = useVideo(s => s.error);
  useEffect(() => {
    if (!enabled || !ref.current) return;
    return attachVideo(ref.current, priority);
  }, [enabled, priority]);
  if (!enabled) return null;
  return <div className={`video-surface ${className}`}>
    <div className="video-surface__picture" ref={ref} />
    {onExpand ? <button className="iconbtn video-surface__expand" aria-label="Watch video full screen" onClick={onExpand}><IconExpand size={20} /></button> : null}
    {loading && !error ? <span className="video-surface__status" role="status">Loading video…</span> : null}
    {error ? <div className="video-surface__status" role="alert">{error} <button className="chip" onClick={retryVideo}>Retry video</button></div> : null}
  </div>;
}

export function VideoNotice() {
  const enabled = useVideo(s => s.enabled);
  const error = useVideo(s => s.error);
  return !enabled && error ? <p className="video-notice" role="alert">{error}</p> : null;
}
