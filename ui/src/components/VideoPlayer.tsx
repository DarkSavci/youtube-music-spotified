import { useEffect, useRef } from "react";
import { attachVideo, retryVideo, setVideoEnabled, useVideo } from "../lib/video";
import { IconExpand } from "./Icon";
import { usePlayer } from "../lib/player";

export function VideoSwitch() {
  const { enabled, busy } = useVideo();
  const track = usePlayer(s => s.track);
  if (!track) return null;
  return <div className="video-switch" role="group" aria-label="Playback format">
    <button className="chip" aria-pressed={!enabled} disabled={busy} onClick={() => void setVideoEnabled(false)}>Song</button>
    <button className="chip" aria-pressed={enabled} disabled={busy} onClick={() => void setVideoEnabled(true)}>{busy ? "Switching…" : "Video"}</button>
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
