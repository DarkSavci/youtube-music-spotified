import { useVirtualizer } from "@tanstack/react-virtual";
import { AlbumLink, ArtistLinks } from "./EntityLinks";
import { warmOnHover } from "../lib/warm";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Track } from "../lib/types";
import { artworkAtLeast, formatDuration } from "../lib/types";
import { usePlayer } from "../lib/player";
import { transport } from "../lib/playback";
import { useMenu } from "./ContextMenu";
import { useTrackFilter } from "../lib/videos";
import { useTrackMenu } from "../lib/trackmenu";
import { useLikedIds, useToggleLike } from "../lib/liked";
import { IconEqualizer, IconExplicit, IconHeart, IconMore, IconPlay } from "./Icon";

const ROW_HEIGHT = 56;

interface Props {
  tracks: Track[];
  onPlayTrack?: (index: number) => void;
  /** Where these tracks came from, shown as the queue's origin. */
  origin?: string;
  /** Album pages number their rows and omit the album column. */
  variant?: "playlist" | "album";
  /** Set when these rows belong to one playlist, enabling removal. */
  playlistId?: string;
  showArtwork?: boolean;
  /**
   * "radio" for search results: a song picked from them plays its radio.
   * Lists that are a whole (an album, a playlist) play as themselves.
   */
  playMode?: "list" | "radio";
  /**
   * Keeps music videos even with them hidden in Settings. A video in a
   * playlist was put there on purpose, like one found under the Videos filter.
   */
  keepVideos?: boolean;
}

/**
 * The track list.
 *
 * Virtualised from the outset: playlists reach thousands of rows, five views
 * depend on this component, and retrofitting windowing later means unpicking
 * every one of them. Rows are rendered into an absolutely-positioned window
 * over a spacer of the full list height, so scroll position and scrollbar
 * length stay honest.
 */
export function TrackTable({
  tracks: allTracks,
  onPlayTrack,
  origin = "",
  variant = "playlist",
  playlistId,
  showArtwork = true,
  playMode = "list",
  keepVideos = false,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const currentId = usePlayer((s) => s.track?.id);
  const playing = usePlayer((s) => s.state === "playing");
  const menu = useMenu();
  const filterTracks = useTrackFilter();
  const trackMenu = useTrackMenu();
  const likedIds = useLikedIds();
  const toggleLike = useToggleLike();

  /*
   * Filtered before virtualising, not while rendering.
   *
   * The virtualiser indexes into this list, and playback is started from the
   * same indices — filtering later would play a different track from the one
   * the row shows.
   */
  const tracks = useMemo(
    () => (keepVideos ? allTracks : filterTracks(allTracks)),
    [keepVideos, filterTracks, allTracks],
  );

  useLayoutEffect(() => {
    const list = parentRef.current;
    const scroll = list?.closest<HTMLElement>(".main__scroll");
    if (!list || !scroll) return;
    const measure = () => setScrollMargin(list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    return () => observer.disconnect();
  // Empty tables render no DOM; reattach measurements when rows first arrive.
  }, [tracks.length === 0]);

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parentRef.current?.closest<HTMLElement>(".main__scroll") ?? null,
    scrollMargin,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  /*
   * Columns for what the rows actually carry.
   *
   * Search's All tab lists songs as "Song • artist" and a play count, with
   * no album and no length. An Album column that is empty on every row, and
   * a Time column full of play counts, read as broken; so the album column
   * appears only when some row has one, and the last column says what it
   * holds.
   */
  const showAlbum = variant !== "album" && showArtwork && tracks.some((t) => t.album?.name);
  const lastColumn = tracks.some((t) => t.durationMs > 0) ? "Time" : "Plays";
  const showListened = variant !== "album" && tracks.some((t) => t.listenedMs !== undefined);
  const columns =
    variant === "album"
      ? "32px 1fr 96px 56px"
      : ["32px", "minmax(0,3fr)", showAlbum ? "minmax(0,2fr)" : "", showListened ? "96px" : "", "96px", "56px"]
          .filter(Boolean)
          .join(" ");

  if (tracks.length === 0) return null;

  return (
    <div className="tracktable" style={{ "--track-cols": columns } as React.CSSProperties}>
      <div className="tracktable__head" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader">Title</span>
        {showAlbum ? <span role="columnheader">Album</span> : null}
        {showListened ? (
          <span role="columnheader" className="trackrow__duration">
            Listened
          </span>
        ) : null}
        <span role="columnheader" className="trackrow__duration">
          {lastColumn}
        </span>
        <span role="columnheader" aria-label="Actions" />
      </div>

      <div ref={parentRef}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((row) => {
            const track = tracks[row.index];
            if (!track) return null;
            const isCurrent = track.id === currentId;
            return (
              <div
                key={`${track.id}:${row.index}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${row.start - scrollMargin}px)`,
                }}
              >
                <TrackRow
                  track={track}
                  index={row.index}
                  isCurrent={isCurrent}
                  isPlaying={isCurrent && playing}
                  variant={variant}
                  showArtwork={showArtwork}
                  showAlbum={showAlbum}
                  showListened={showListened}
                  onPlay={() =>
                    onPlayTrack ? onPlayTrack(row.index) : playMode === "radio"
                      ? transport.playRadio(track)
                      : transport.play(tracks, row.index, origin)
                  }
                  onContextMenu={(e) => menu.open(e, trackMenu(track, { origin, playlistId }))}
                  liked={likedIds.has(track.id)}
                  onToggleLike={() =>
                    toggleLike.mutate({ trackId: track.id, liked: likedIds.has(track.id), track })
                  }
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TrackRow({
  track,
  index,
  isCurrent,
  isPlaying,
  variant,
  showArtwork,
  showAlbum,
  showListened,
  onPlay,
  onContextMenu,
  liked,
  onToggleLike,
}: {
  track: Track;
  index: number;
  isCurrent: boolean;
  isPlaying: boolean;
  variant: "playlist" | "album";
  showArtwork: boolean;
  showAlbum: boolean;
  showListened: boolean;
  onPlay: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  liked: boolean;
  onToggleLike: () => void;
}) {
  const cancelWarm = useRef<(() => void) | null>(null);
  return (
    <div
      className="trackrow"
      data-playing={isCurrent || undefined}
      data-playable={track.playable}
      role="row"
      tabIndex={0}
      onDoubleClick={track.playable ? onPlay : undefined}
      onContextMenu={onContextMenu}
      /*
       * Resolve while the pointer is still on its way to the click.
       *
       * Starting a track costs about three seconds of upstream round trips
       * that cannot be made faster, only made earlier. Hovering is the
       * earliest honest signal that this is the one.
       */
      onMouseEnter={track.playable ? () => { cancelWarm.current = warmOnHover(track.id); } : undefined}
      onMouseLeave={() => { cancelWarm.current?.(); }}
      onKeyDown={(e) => {
        if (track.playable && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onPlay();
        }
      }}
    >
      <span className="trackrow__index">
        {isPlaying ? (
          <IconEqualizer />
        ) : (
          <>
            <span className="trackrow__num">{index + 1}</span>
            <button
              className="trackrow__play iconbtn"
              aria-label={`Play ${track.title}`}
              onClick={onPlay}
              disabled={!track.playable}
            >
              <IconPlay size={14} />
            </button>
          </>
        )}
      </span>

      <span className="trackrow__main">
        {showArtwork && variant !== "album" ? (
          <img
            className="trackrow__art"
            src={artworkAtLeast(track.artwork, 80)}
            alt=""
            loading="lazy"
          />
        ) : null}
        <span className="trackrow__text">
          <span className="trackrow__title truncate">{track.title}</span>
          <span className="trackrow__artist truncate trackrow__badges">
            {track.explicit ? <IconExplicit size={14} title="Explicit" /> : null}
            <ArtistLinks artists={track.artists} />
          </span>
        </span>
      </span>

      {showAlbum ? (
        <span className="truncate">
          <AlbumLink album={track.album} />
        </span>
      ) : null}

      {showListened ? (
        <span className="trackrow__duration">{formatListened(track.listenedMs ?? 0)}</span>
      ) : null}

      <span className="trackrow__duration">
        {track.durationMs > 0
          ? formatDuration(track.durationMs)
          : track.playCount || formatDuration(0)}
      </span>

      {/* Their own controls: a click here likes or opens the menu, and never
          reaches the row, whose double-click plays. */}
      <span
        style={{ display: "flex", gap: 4 }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button
          className="iconbtn"
          aria-label={liked ? `Remove ${track.title} from your library` : `Save ${track.title}`}
          aria-pressed={liked}
          data-active={liked || undefined}
          onClick={onToggleLike}
        >
          <IconHeart size={16} filled={liked} />
        </button>
        <button
          className="iconbtn"
          aria-label={`More options for ${track.title}`}
          onClick={(e) => onContextMenu(e)}
        >
          <IconMore size={16} />
        </button>
      </span>
    </div>
  );
}

/** Listening time as minutes, or hours and minutes once it runs past an hour. */
function formatListened(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (ms > 0 && minutes === 0) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
