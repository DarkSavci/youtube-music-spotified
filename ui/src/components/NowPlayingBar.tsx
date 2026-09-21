import { useEffect, useRef, useState } from "react";
import { AlbumLink, ArtistLinks } from "./EntityLinks";
import { share } from "../lib/share";
import { usePlayer, currentPosition } from "../lib/player";
import { transport } from "../lib/playback";
import { artworkAtLeast, formatDuration } from "../lib/types";
import { Slider } from "./Slider";
import {
  IconExpand, IconHeart, IconLyrics, IconPause, IconPlay, IconQueue,
  IconRepeat, IconShuffle, IconSkipNext, IconSkipPrev, IconShare } from "./Icon";
import { useLikedIds, useToggleLike } from "../lib/liked";
import { VolumeControl } from "./VolumeControl";

/**
 * Persistent transport bar.
 *
 * Three columns — track identity, transport, output controls — which is the
 * arrangement every mature desktop player converges on, so muscle memory
 * transfers.
 *
 * The scrubber updates on an animation frame from the position anchor rather
 * than from React state. Position is a function of time, not state, and
 * treating it as state would re-render the whole bar sixty times a second.
 */
export function NowPlayingBar({
  onToggleQueue,
  queueOpen,
  onOpenFullScreen,
  onToggleLyrics,
  lyricsOpen,
}: {
  onToggleQueue: () => void;
  queueOpen: boolean;
  onOpenFullScreen: () => void;
  onToggleLyrics: () => void;
  lyricsOpen: boolean;
}) {
  const { track, state, repeat, shuffle, quality } = usePlayer();

  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const [position, setPosition] = useState(0);
  const frame = useRef<number>();

  useEffect(() => {
    const tick = () => {
      // Reading through the store rather than a subscription keeps this loop
      // from re-rendering anything but the two elements that show time.
      setPosition(currentPosition(usePlayer.getState()));
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, []);

  const duration = track?.durationMs ?? 0;
  const shown = scrubbing ?? position;
  /*
   * Intent, not observation.
   *
   * Buffering is still "trying to play": the user has not paused, so the
   * button must stay on Pause. Showing Play there invites a click that
   * pauses, which is the opposite of what someone staring at a stuck
   * progress bar is reaching for.
   */
  const playing = state === "playing" || state === "stalled" || state === "loading";
  const buffering = state === "loading" || state === "stalled";

  const likedIds = useLikedIds();
  const toggleLike = useToggleLike();
  const liked = Boolean(track && likedIds.has(track.id));

  return (
    <footer className="bar panel" aria-label="Playback">
      <div className="bar__now">
        {track ? (
          <>
            <button
              className="bar__artbtn"
              aria-label="Open now playing"
              onClick={onOpenFullScreen}
            >
              <img
                className="bar__art"
                src={artworkAtLeast(track.artwork, 120)}
                alt=""
              />
              <span className="bar__artexpand" aria-hidden="true">
                <IconExpand size={16} />
              </span>
            </button>
            <div className="bar__meta">
              <span className="bar__title truncate">{track.title}</span>
              <span className="bar__artist truncate">
                <ArtistLinks artists={track.artists} />
                {track.album?.name ? (
                  <>
                    {" • "}
                    <AlbumLink album={track.album} />
                  </>
                ) : null}
              </span>
            </div>
            <button
              className="iconbtn"
              aria-label={liked ? "Remove from your library" : "Save to your library"}
              aria-pressed={liked}
              data-active={liked || undefined}
              onClick={() => toggleLike.mutate({ trackId: track.id, liked, track })}
            >
              <IconHeart size={18} filled={liked} />
            </button>
            <button
              className="iconbtn"
              aria-label="Share"
              onClick={() => void share("track", track.id)}
            >
              <IconShare size={18} />
            </button>
          </>
        ) : (
          <div className="bar__meta">
            <span className="bar__artist">Nothing playing</span>
          </div>
        )}
      </div>

      <div className="bar__center">
        <div className="bar__transport">
          <button
            className="iconbtn"
            data-active={shuffle || undefined}
            aria-label="Shuffle"
            aria-pressed={shuffle}
            onClick={() => transport.toggleShuffle()}
          >
            <IconShuffle size={18} />
          </button>
          <button className="iconbtn" aria-label="Previous track" onClick={() => transport.prev()} disabled={!track}>
            <IconSkipPrev size={20} />
          </button>
          <button
            className="playbtn"
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => transport.toggle()}
            // Deliberately enabled while buffering: a stall is exactly when
            // someone wants to stop, and a dead control reads as a crash.
            disabled={!track}
          >
            {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
          </button>
          <button className="iconbtn" aria-label="Next track" onClick={() => transport.next()} disabled={!track}>
            <IconSkipNext size={20} />
          </button>
          <button
            className="iconbtn"
            data-active={repeat !== "off" || undefined}
            aria-label={`Repeat: ${repeat}`}
            onClick={() => transport.cycleRepeat()}
          >
            <IconRepeat size={18} />
            {/* "One" looked exactly like "all" before, so repeating a single song
                was easy to switch on without noticing. */}
            {repeat === "one" ? <span className="repeatone" aria-hidden="true">1</span> : null}
          </button>
        </div>

        <div className="bar__progress" data-buffering={buffering || undefined}>
          <span className="bar__time">{formatDuration(shown)}</span>
          <Slider
            label="Seek"
            value={shown}
            max={duration}
            disabled={!track}
            step={1000}
            onChange={(v) => {
              setScrubbing(v);
              transport.seek(v);
              // Release on the next frame so the anchor has taken effect and
              // the thumb does not snap back to the stale value.
              requestAnimationFrame(() => setScrubbing(null));
            }}
          />
          <span className="bar__time">{formatDuration(duration)}</span>
        </div>
      </div>

      <div className="bar__right">
        {quality ? <span className="bar__quality">{quality}</span> : null}
        <button
          className="iconbtn"
          aria-label="Lyrics"
          data-active={lyricsOpen || undefined}
          aria-pressed={lyricsOpen}
          onClick={onToggleLyrics}
        >
          <IconLyrics size={18} />
        </button>
        <button
          className="iconbtn"
          data-active={queueOpen || undefined}
          aria-label="Queue"
          aria-pressed={queueOpen}
          onClick={onToggleQueue}
        >
          <IconQueue size={18} />
        </button>
        <VolumeControl />
      </div>
    </footer>
  );
}
