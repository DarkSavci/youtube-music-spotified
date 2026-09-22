import { createContext, useContext, useEffect, useState } from "react";
import { currentPosition, usePlayer } from "./player";

/**
 * The window whose frames drive the loop below.
 *
 * Normally this one. The mini player is drawn into its own window from this
 * one's React tree, and must tick on that window's frames: this window may be
 * hidden in the tray, and a hidden window's frames are not the ones on
 * screen.
 */
export const FrameWindow = createContext<Window>(window);

/**
 * The playback position, sampled on a frame loop.
 *
 * The store holds an anchor corrected about once a second rather than a
 * ticking value, so anything that needs smooth motion has to interpolate. Two
 * components were doing that with their own copies of this loop; this is the
 * one place it lives.
 *
 * The loop runs only while playing, so a paused window does no work.
 */
export function usePlaybackPosition(): number {
  const anchor = usePlayer((s) => s.anchor);
  const track = usePlayer((s) => s.track);
  const playing = usePlayer((s) => s.state === "playing");
  const frames = useContext(FrameWindow);
  const [, force] = useState(0);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      force((n) => n + 1);
      raf = frames.requestAnimationFrame(tick);
    };
    raf = frames.requestAnimationFrame(tick);
    return () => frames.cancelAnimationFrame(raf);
  }, [playing, frames]);

  return currentPosition({ anchor, track });
}
