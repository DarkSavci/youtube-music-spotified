import { useEffect, useRef } from "react";
import { usePlayer } from "../lib/player";
import { transport } from "../lib/playback";
import { maxVolume, useSettings } from "../lib/settings";
import { IconVolume, IconVolumeMute } from "./Icon";
import { Slider } from "./Slider";

/**
 * Mute and volume, the same wherever playback can be controlled from: the
 * bar, the full-screen player and the lyrics view. The slider runs to 200%
 * when volume boost is on.
 */

/** Volume change per mouse-wheel notch (100px of scroll); touchpads scale smoothly. */
const WHEEL_STEP = 0.05;
/** Pixels per line when the wheel reports lines instead of pixels. */
const LINE_PX = 33;
export function VolumeControl({ className = "" }: { className?: string }) {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const volumeMax = maxVolume(useSettings((s) => s.volumeBoost)) * 100;
  const ref = useRef<HTMLDivElement>(null);

  // Scrolling over the control changes the volume. A native, non-passive
  // listener, because React's wheel handler cannot stop the page behind it
  // from scrolling too.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!raw) return;
      e.preventDefault();
      const px = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? raw * LINE_PX : raw;
      const { volume, muted } = usePlayer.getState();
      // Scrolling down while muted leaves it muted; scrolling up unmutes from 0.
      if (muted && px > 0) return;
      const next = (muted ? 0 : volume) - (px / 100) * WHEEL_STEP;
      transport.setVolume(Math.round(next * 1000) / 1000);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div ref={ref} className={`volume ${className}`}>
      <button
        className="iconbtn"
        aria-label={muted ? "Unmute" : "Mute"}
        onClick={() => transport.toggleMute()}
      >
        {muted || volume === 0 ? <IconVolumeMute size={18} /> : <IconVolume size={18} />}
      </button>
      <Slider
        className="slider--volume"
        label="Volume"
        value={muted ? 0 : Math.min(volume * 100, volumeMax)}
        max={volumeMax}
        onChange={(v) => transport.setVolume(v / 100)}
      />
    </div>
  );
}
