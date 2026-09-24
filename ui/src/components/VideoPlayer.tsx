import { useEffect, useRef } from "react";
import { attachVideo, retryVideo, setVideoEnabled, useVideo } from "../lib/video";
import { IconExpand, IconVideo } from "./Icon";
import { usePlayer } from "../lib/player";

export function useVideoControl() {
  const { availabilityID, availability, busy } = useVideo();
  const track = usePlayer(s => s.track);
  const following = usePlayer(s => s.followingRoom);
  const status = track?.isVideo ? "available" : availabilityID === track?.id ? availability : "checking";
  const reason = busy ? "Switching playback format…"
    : !track ? "Play a song to watch its video."
    : following && !track.isVideo ? "The Listen Together host chooses the video version."
    : status === "checking" ? "Checking for a music video…"
    : status === "unavailable" ? "No matching music video is available for this song."
    : status === "error" ? "Could not check video availability. Click to retry."
    : "Watch music video";
  return { blocked: busy || !track || (following && !track.isVideo) || status === "checking" || status === "unavailable", reason };
}

export function VideoSwitch({ iconOnly = false }: { iconOnly?: boolean }) {
  const { enabled, busy } = useVideo();
  const { blocked, reason } = useVideoControl();
  const track = usePlayer(s => s.track);
  if (!track) return null;
  if (iconOnly) return <button
    className="iconbtn"
    aria-label="Music video"
    title={enabled ? "Switch to song" : reason}
    aria-pressed={enabled}
    aria-busy={busy}
    data-active={enabled || undefined}
    aria-disabled={enabled ? busy : blocked}
    onClick={() => { if (!(enabled ? busy : blocked)) void setVideoEnabled(!enabled); }}
  ><IconVideo size={18} /></button>;
  return <div className="video-switch" role="group" aria-label="Playback format">
    <button className="chip" aria-pressed={!enabled} disabled={busy} onClick={() => void setVideoEnabled(false)}>Song</button>
    <button className="chip" aria-pressed={enabled} aria-disabled={blocked} title={reason} onClick={() => { if (!blocked) void setVideoEnabled(true); }}>{busy ? "Switching…" : "Video"}</button>
  </div>;
}

export function VideoSurface({ priority = 0, className = "", onExpand }: { priority?: number; className?: string; onExpand?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { enabled, loading, error } = useVideo();
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
  const { enabled, error } = useVideo();
  return !enabled && error ? <p className="video-notice" role="alert">{error}</p> : null;
}
