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
export function VolumeControl({ className = "" }: { className?: string }) {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const volumeMax = maxVolume(useSettings((s) => s.volumeBoost)) * 100;

  return (
    <div className={`volume ${className}`}>
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
