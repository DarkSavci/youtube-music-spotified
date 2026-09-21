import { useEffect, useState } from "react";
import { currentPosition, usePlayer } from "./player";

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
  const [, force] = useState(0);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      force((n) => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  return currentPosition({ anchor, track });
}
