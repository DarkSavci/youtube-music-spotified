import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ArtistLinks } from "./EntityLinks";
import { VolumeControl } from "./VolumeControl";
import { useQuery } from "@tanstack/react-query";
import { usePlayer } from "../lib/player";
import { transport } from "../lib/playback";
import { usePlaybackPosition } from "../lib/tick";
import { useArtColor } from "../lib/artcolor";
import { apiUrl } from "../lib/base";
import { useSettings } from "../lib/settings";
import { artworkAtLeast, formatDuration } from "../lib/types";
import {
  IconClose, IconExpand, IconPause, IconPlay, IconRepeat, IconShuffle,
  IconSkipNext, IconSkipPrev,
} from "./Icon";
import { Slider } from "./Slider";
import { PageState, ShelfSkeleton } from "./States";

/**
 * Lyrics, in the two places they appear.
 *
 * Both are the same list of lines on a colour taken from the cover: a side
 * panel for reading while browsing, and a view that fills the app. The flat
 * extracted colour is for legibility rather than decoration — a blurred cover
 * has light and dark regions, and large white type has to survive both.
 */

interface Lyrics {
  source: string;
  plain: string;
  lines: { atMs: number; text: string }[];
  synced: boolean;
}

function useLyrics() {
  const track = usePlayer((s) => s.track);
  const timed = useSettings((s) => s.timedLyrics);

  const query = useQuery({
    queryKey: ["lyrics", track?.id, timed],
    enabled: Boolean(track?.id),
    staleTime: 60 * 60 * 1000,
    retry: false,
    queryFn: async ({ signal }) => {
      const q = new URLSearchParams({
        title: track?.title ?? "",
        artist: track?.artists?.[0]?.name ?? "",
        durationMs: String(track?.durationMs ?? 0),
      });
      if (track?.album?.name) q.set("album", track.album.name);
      if (timed) q.set("timed", "1");
      const res = await fetch(
        apiUrl(`/v1/tracks/${encodeURIComponent(track!.id)}/lyrics?${q}`),
        { signal },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()) as Lyrics;
    },
  });

  return { track, timed, ...query };
}

/**
 * The lines themselves.
 *
 * Three states rather than two, which is what makes a synced view readable at
 * a glance: lines already sung fade back, the current line is the only pure
 * white, and lines still to come are darkened into the background. The eye
 * finds "now" without the rest becoming unreadable.
 */
function LyricsLines({
  lines,
  positionMs,
  large,
}: {
  lines: { atMs: number; text: string }[];
  positionMs: number;
  large: boolean;
}) {
  const activeIndex = useMemo(() => {
    let lo = 0;
    let hi = lines.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((lines[mid]?.atMs ?? Infinity) <= positionMs) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }, [lines, positionMs]);

  const activeRef = useRef<HTMLLIElement>(null);
  const lastIndex = useRef(-2);

  // A layout effect, so the scroll happens in the same frame as the highlight
  // rather than one frame behind it.
  useLayoutEffect(() => {
    if (activeIndex === lastIndex.current) return;
    const first = lastIndex.current === -2;
    lastIndex.current = activeIndex;
    activeRef.current?.scrollIntoView({
      block: "center",
      // Opening part-way through a song should not animate from the top.
      behavior: first ? "auto" : "smooth",
    });
  }, [activeIndex]);

  return (
    <ol className={`lyrics ${large ? "lyrics--lg" : ""}`}>
      {lines.map((line, i) => (
        <li
          key={`${line.atMs}:${i}`}
          ref={i === activeIndex ? activeRef : undefined}
          data-state={i === activeIndex ? "active" : i < activeIndex ? "sung" : "upcoming"}
        >
          {line.text ? (
            <button
              className="lyrics__line"
              onClick={() => transport.seek(line.atMs)}
              title="Jump to this line"
            >
              {line.text}
            </button>
          ) : (
            <span className="lyrics__gap" aria-hidden="true">
              &#9834;
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The body shared by the panel and the full view. */
function LyricsBody({ large }: { large: boolean }) {
  const { track, timed, data, isPending, error } = useLyrics();
  const positionMs = usePlaybackPosition();

  if (!track) {
    return <PageState title="Nothing playing" body="Play something to see its lyrics." />;
  }
  if (isPending) return <ShelfSkeleton />;
  if (error) return <PageState title="Could not load lyrics" body={String(error)} />;
  if (!data) {
    return (
      <PageState
        title="No lyrics"
        body={
          timed
            ? "Neither YouTube Music nor LRCLIB has words for this track."
            : "YouTube Music has no words for this track. Turn on timed lyrics in Settings to also search LRCLIB."
        }
      />
    );
  }

  return (
    <>
      {data.synced ? (
        <LyricsLines lines={data.lines} positionMs={positionMs} large={large} />
      ) : (
        <>
          <p className={`lyrics lyrics--plain ${large ? "lyrics--lg" : ""}`}>{data.plain}</p>
          {/* Untimed words cannot follow the music. Saying so beats letting
              someone wait for a highlight that is never coming. */}
          <p className="lyrics__note">
            {timed
              ? "No timings available for this track."
              : "Turn on timed lyrics in Settings to follow along."}
          </p>
        </>
      )}
      <p className="lyrics__source">Source: {data.source}</p>
    </>
  );
}

/** Lyrics beside the content, for reading while browsing. */
export function LyricsPanel({
  onClose,
  onExpand,
}: {
  onClose: () => void;
  onExpand: () => void;
}) {
  const track = usePlayer((s) => s.track);
  const color = useArtColor(artworkAtLeast(track?.artwork ?? [], 300));

  return (
    <aside
      className="nowplaying panel lyricspanel"
      aria-label="Lyrics"
      style={{ "--lyric-bg": color } as React.CSSProperties}
    >
      <div className="nowplaying__head">
        <span>Lyrics</span>
        <span className="lyricspanel__actions">
          <button className="iconbtn" aria-label="Expand lyrics" onClick={onExpand}>
            <IconExpand size={16} />
          </button>
          <button className="iconbtn" aria-label="Close lyrics" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </span>
      </div>
      <div className="nowplaying__body scroll lyricspanel__body">
        <LyricsBody large={false} />
      </div>
    </aside>
  );
}

/** Lyrics filling the app, the way Spotify shows them. */
export function LyricsView({ onClose }: { onClose: () => void }) {
  const track = usePlayer((s) => s.track);
  const color = useArtColor(artworkAtLeast(track?.artwork ?? [], 300));
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="lyricsview"
      role="dialog"
      aria-modal="true"
      aria-label="Lyrics"
      style={{ "--lyric-bg": color } as React.CSSProperties}
    >
      <header className="lyricsview__head">
        <img
          className="lyricsview__thumb"
          src={artworkAtLeast(track?.artwork ?? [], 160)}
          alt=""
        />
        <div className="lyricsview__meta">
          <span className="lyricsview__title truncate">{track?.title ?? ""}</span>
          <span className="lyricsview__artist truncate">
            <ArtistLinks artists={track?.artists} onNavigate={onClose} />
          </span>
        </div>
        <button ref={closeRef} className="iconbtn" aria-label="Close lyrics" onClick={onClose}>
          <IconClose size={20} />
        </button>
      </header>

      <div className="lyricsview__body scroll">
        <LyricsBody large />
      </div>

      {/* Playback controls, because a view that fills the app has to be
          usable without leaving it — Spotify keeps the progress bar and the
          play button on its lyrics screen for the same reason. */}
      <LyricsTransport />
    </div>
  );
}

function LyricsTransport() {
  const track = usePlayer((s) => s.track);
  const state = usePlayer((s) => s.state);
  const position = usePlaybackPosition();
  const playing = state === "playing" || state === "stalled" || state === "loading";
  const duration = track?.durationMs ?? 0;

  const repeat = usePlayer((s) => s.repeat);
  const shuffle = usePlayer((s) => s.shuffle);

  return (
    <div className="lyricsview__transport">
      <div className="lyricsview__progress">
        <span className="lyricsview__time">{formatDuration(position)}</span>
        <Slider
          label="Seek"
          value={position}
          max={duration}
          step={1000}
          disabled={!track}
          onChange={(v) => transport.seek(v)}
        />
        <span className="lyricsview__time">{formatDuration(duration)}</span>
      </div>

      {/* The same transport as the full-screen player: leaving a view means
          leaving the music, so both have to be operable where they are. */}
      <div className="lyricsview__controls">
        <button
          className="iconbtn"
          aria-label="Shuffle"
          aria-pressed={shuffle}
          data-active={shuffle || undefined}
          onClick={() => transport.toggleShuffle()}
        >
          <IconShuffle size={18} />
        </button>
        <button className="iconbtn" aria-label="Previous track" onClick={() => transport.prev()}>
          <IconSkipPrev size={22} />
        </button>
        <button
          className="playbtn"
          aria-label={playing ? "Pause" : "Play"}
          disabled={!track}
          onClick={() => transport.toggle()}
        >
          {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
        </button>
        <button className="iconbtn" aria-label="Next track" onClick={() => transport.next()}>
          <IconSkipNext size={22} />
        </button>
        <button
          className="iconbtn"
          aria-label={`Repeat: ${repeat}`}
          aria-pressed={repeat !== "off"}
          data-active={repeat !== "off" || undefined}
          onClick={() => transport.cycleRepeat()}
        >
          <IconRepeat size={18} />
            {/* "One" looked exactly like "all" before, so repeating a single song
                was easy to switch on without noticing. */}
            {repeat === "one" ? <span className="repeatone" aria-hidden="true">1</span> : null}
        </button>
        <VolumeControl className="lyricsview__volume" />
      </div>
    </div>
  );
}
