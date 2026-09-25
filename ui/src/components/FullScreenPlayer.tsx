import { ShareIcon } from "./ShareIcon";
import { trapTab, watchFullscreenIdle } from "../lib/fullscreenIdle";
import { EndTime } from "./EndTime";
import { VideoSurface, VideoSwitch, VideoNotice } from "./VideoPlayer";
import { useVideo } from "../lib/video";
import { useEffect, useRef, useState } from "react";
import { AlbumLink, ArtistLinks } from "./EntityLinks";
import { usePlayer } from "../lib/player";
import { VolumeControl } from "./VolumeControl";
import { transport } from "../lib/playback";
import { share } from "../lib/share";
import { usePlaybackPosition } from "../lib/tick";
import { Slider } from "./Slider";
import {
  IconClose, IconPause, IconPlay, IconRepeat, IconShuffle, IconSkipNext, IconSkipPrev,
} from "./Icon";
import { artworkAtLeast, formatDuration } from "../lib/types";

/**
 * Full-screen now playing.
 *
 * The artwork bleeds to all four edges and everything else sits over it: the
 * context label top-left, the track bottom-left beside a small cover, and the
 * transport across the bottom. That layout is Spotify's, and the reason for it
 * is that the cover is the subject — a centred square with a blur behind it
 * makes the blur the subject and the cover a stamp on top of it.
 */
export function FullScreenPlayer({ onClose }: { onClose: () => void }) {
  const video = useVideo(s => s.enabled);
  const videoError = useVideo(s => s.error);
  const notice = usePlayer(s => s.notice);
  const rootRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);
  const { track, state, repeat, shuffle, origin } = usePlayer();
  const position = usePlaybackPosition();
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    rootRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    setHidden(false);
    if (state !== "playing" || videoError || notice || !rootRef.current) return;
    return watchFullscreenIdle(rootRef.current, setHidden);
  }, [state, track?.id, videoError, notice]);

  if (!track) return null;

  const playing = state === "playing" || state === "stalled" || state === "loading";
  const duration = track.durationMs ?? 0;
  const shown = scrubbing ?? position;
  const art = artworkAtLeast(track.artwork, 1000);

  return (
    <div ref={rootRef} tabIndex={-1} data-controls-hidden={hidden || undefined} className="fsp" role="dialog" aria-modal="true" aria-label="Now playing"
      // Also while paused, when the idle watcher is not running.
      onKeyDown={(e) => { if (e.key === "Tab" && rootRef.current) trapTab(rootRef.current, e.nativeEvent); }}>
      {video ? <VideoSurface priority={10} className="fsp__video" /> : <img className="fsp__bleed" src={art} alt="" aria-hidden="true" />}
      {/* A gradient only at the bottom, where the controls are: the artwork
          stays untouched everywhere the eye actually looks. */}
      <div className="fsp__scrim" aria-hidden="true" />

      <div className="fsp__context">
        <VideoNotice />
        <span className="fsp__contextlabel">
          {origin ? "Playing from" : "Playing"}
        </span>
        <span className="fsp__contextname truncate">{origin || "Youtube Music Spotified"}</span>
      </div>

      <button
        ref={closeRef}
        className="fsp__close iconbtn"
        aria-label="Exit full screen"
        onClick={onClose}
      >
        <IconClose size={20} />
      </button>

      <div className="fsp__foot">
        <div className="fsp__track">
          <img className="fsp__thumb" src={artworkAtLeast(track.artwork, 160)} alt="" />
          <div className="fsp__meta">
            <h1 className="fsp__title truncate">{track.title}</h1>
            <p className="fsp__artist truncate">
              <ArtistLinks artists={track.artists} onNavigate={onClose} />
              {track.album?.name ? (
                <>
                  {" • "}
                  <AlbumLink album={track.album} onNavigate={onClose} />
                </>
              ) : null}
            </p>
          </div>
        </div>

        <div className="fsp__progress">
          <span className="fsp__time">{formatDuration(shown)}</span>
          <Slider
            label="Seek"
            value={shown}
            max={duration}
            step={1000}
            onChange={(v) => {
              setScrubbing(v);
              transport.seek(v);
              requestAnimationFrame(() => setScrubbing(null));
            }}
          />
          <EndTime className="fsp__time" duration={duration} position={shown} />
        </div>

        <div className="fsp__controls">
          <div className="fsp__side">
            <button className="iconbtn" aria-label="Share" onClick={() => void share("track", track.id)}>
              <ShareIcon size={18} />
            </button>
          </div>
          <div className="fsp__transport">
            <button
              className="iconbtn"
              aria-label="Shuffle"
              aria-pressed={shuffle}
              data-active={shuffle || undefined}
              onClick={() => transport.toggleShuffle()}
            >
              <IconShuffle size={20} />
            </button>
            <button className="iconbtn" aria-label="Previous track" onClick={() => transport.prev()}>
              <IconSkipPrev size={24} />
            </button>
            <button
              className="playbtn playbtn--lg"
              aria-label={playing ? "Pause" : "Play"}
              onClick={() => transport.toggle()}
            >
              {playing ? <IconPause size={22} /> : <IconPlay size={22} />}
            </button>
            <button className="iconbtn" aria-label="Next track" onClick={() => transport.next()}>
              <IconSkipNext size={24} />
            </button>
            <button
              className="iconbtn"
              aria-label={`Repeat: ${repeat}`}
              aria-pressed={repeat !== "off"}
              data-active={repeat !== "off" || undefined}
              onClick={() => transport.cycleRepeat()}
            >
              <IconRepeat size={20} />
            {/* "One" looked exactly like "all" before, so repeating a single song
                was easy to switch on without noticing. */}
            {repeat === "one" ? <span className="repeatone" aria-hidden="true">1</span> : null}
            </button>
          </div>

          <div className="fsp__side fsp__side--end">
            <VideoSwitch />
            <VolumeControl className="fsp__volume" />
          </div>
        </div>
      </div>
    </div>
  );
}
