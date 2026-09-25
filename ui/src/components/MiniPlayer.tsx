import { EndTime } from "./EndTime";
import { VideoSurface, VideoNotice, useVideoControl } from "./VideoPlayer";
import { useVideo, setVideoEnabled } from "../lib/video";
import { useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { usePlayer } from "../lib/player";
import { transport } from "../lib/playback";
import { usePlaybackPosition, FrameWindow } from "../lib/tick";
import { useLikedIds, useToggleLike } from "../lib/liked";
import { useArtColor } from "../lib/artcolor";
import { desktop } from "../lib/desktop";
import { closeMini, ensureMiniSize, useMini } from "../lib/miniplayer";
import { artistNames, artworkAtLeast, formatDuration } from "../lib/types";
import { MenuProvider } from "./ContextMenu";
import { ArtistLinks } from "./EntityLinks";
import { QueueList } from "./QueuePanel";
import { LyricsBody } from "./Lyrics";
import { Slider } from "./Slider";
import { VolumeControl } from "./VolumeControl";
import { SpeedControl } from "./SpeedControl";
import {
  IconClose, IconHeart, IconLyrics, IconOpenApp, IconPause, IconPin, IconPlay,
  IconQueue, IconRepeat, IconShuffle, IconSkipNext, IconSkipPrev, IconVideo,
} from "./Icon";

/**
 * The mini player.
 *
 * Spotify's, with the two things people ask it for: the queue and the lyrics.
 * One component, four shapes, chosen by the window's size rather than by a
 * setting — drag a corner and it becomes whatever fits, as Spotify's does:
 *
 *   bar     a strip: artwork, title, transport
 *   square  the artwork, with the controls over it when the pointer is
 *   wide    artwork beside the controls, all of them visible
 *   tall    the controls under a panel: artwork, queue or lyrics
 *
 * Asking for the queue or the lyrics in a shape without room for them grows
 * the window into the tall one.
 *
 * Rendered from the main window's React tree into the mini player's window
 * (see lib/miniplayer.ts), so everything here is live without being synced.
 */

type Layout = "bar" | "square" | "wide" | "tall";
type Panel = "art" | "video" | "queue" | "lyrics";

// What the queue and the lyrics need to be worth showing.
const PANEL_SIZE = { width: 360, height: 580 };

/*
 * What each layout needs, measured: below these the square cuts off its
 * progress and buttons, and the wide one loses its title and squashes the
 * transport. The wide layout's artwork is a square the window's height, so
 * what it needs is the width left beside it.
 */
const SQUARE_MIN_HEIGHT = 260;
const WIDE_MIN_SIDE = 270;

/**
 * The layout for a window size: the one its proportions suggest, or where
 * that one would not fit, one that does — ending at the one-line bar, which
 * fits any window the shell allows.
 */
function layoutFor(w: number, h: number): Layout {
  if (h < 140) return "bar";
  if (h >= 400 || (h >= 300 && w / h < 0.8)) return "tall";
  const square = h >= SQUARE_MIN_HEIGHT;
  const wide = w - h >= WIDE_MIN_SIDE;
  if (w / h <= 1.35) return square ? "square" : wide ? "wide" : "bar";
  return wide ? "wide" : square ? "square" : "bar";
}

/** Mounted once by the app; draws into the mini window while it is open. */
export function MiniPlayerHost() {
  const { win, root } = useMini();
  if (!win || !root) return null;
  return createPortal(
    // Frames from the mini window, which is on screen even when the main one
    // is hidden in the tray; menus in it, not behind it in the main window.
    <FrameWindow.Provider value={win}>
      <MenuProvider>
        <MiniPlayer win={win} />
      </MenuProvider>
    </FrameWindow.Provider>,
    root,
  );
}

function useWindowSize(win: Window) {
  const [size, setSize] = useState({ w: win.innerWidth, h: win.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ w: win.innerWidth, h: win.innerHeight });
    win.addEventListener("resize", onResize);
    onResize();
    return () => win.removeEventListener("resize", onResize);
  }, [win]);
  return size;
}

function MiniPlayer({ win }: { win: Window }) {
  const { w, h } = useWindowSize(win);
  const layout = layoutFor(w, h);
  const video = useVideo(s => s.enabled);
  const [panel, setPanel] = useState<Panel>(() => useVideo.getState().enabled ? "video" : "art");
  const track = usePlayer((s) => s.track);
  const color = useArtColor(artworkAtLeast(track?.artwork ?? [], 300));

  const choosePanel = (next: Panel) => {
    // Queue and lyrics are only shown in the tall layout, so only there does
    // a second click close them.
    if (panel === next && (next === "video" ? video : layout === "tall")) return setPanel("art");
    setPanel(next);
    if (next === "video") {
      if (!useVideo.getState().enabled) void setVideoEnabled(true);
    } else if (layout !== "tall") ensureMiniSize(PANEL_SIZE.width, PANEL_SIZE.height);
  };

  // The taskbar and Alt+Tab name the window after what is playing.
  useEffect(() => {
    win.document.title = track ? `${track.title} • ${artistNames(track.artists)}` : "Mini player";
  }, [track, win]);

  // Space plays and pauses from anywhere in the window but a control, which
  // handles Space itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      if (e.key !== " " || target?.closest?.("button, input, textarea, [role='button']")) return;
      e.preventDefault();
      transport.toggle();
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [win]);

  const visiblePanel = panel === "video" && !video ? "art" : panel;
  const panelProps = { panel: layout === "tall" || visiblePanel === "video" ? visiblePanel : "art", onPanel: choosePanel };

  return (
    <div className="mini" data-layout={layout} style={{ "--art": color } as CSSProperties}>
      {layout === "bar" ? <Bar /> : null}
      {layout === "square" ? <Square {...panelProps} /> : null}
      {layout === "wide" ? <Wide {...panelProps} /> : null}
      {layout === "tall" ? <Tall {...panelProps} /> : null}
    </div>
  );
}

/* ---------- the four shapes ---------- */

interface PanelProps {
  panel: Panel;
  onPanel: (p: Panel) => void;
}

function Bar() {
  return (
    <>
      <div className="mini__bar mini__drag">
        <Cover size={120} className="mini__thumb" />
        <Meta />
        <LikeButton />
        <Transport compact />
        <SpeedControl titled />
        <WindowButtons />
      </div>
      <ThinProgress />
    </>
  );
}

function Square(props: PanelProps) {
  return (
    <div className="mini__square">
      <Cover size={544} className="mini__cover" video={props.panel === "video"} />
      <div className="mini__overlay">
        <Head />
        <div className="mini__bottom">
          <div className="mini__row">
            <Meta />
            <LikeButton />
          </div>
          <Progress />
          <Transport />
          <Extras {...props} />
        </div>
      </div>
      <ThinProgress />
    </div>
  );
}

function Wide(props: PanelProps) {
  return (
    <div className="mini__wide">
      <Cover size={544} className="mini__cover" video={props.panel === "video"} />
      <div className="mini__side">
        <Head>
          <Meta />
          <LikeButton />
        </Head>
        <Progress />
        <Transport />
        <Extras {...props} />
      </div>
    </div>
  );
}

function Tall({ panel, onPanel }: PanelProps) {
  return (
    <div className="mini__tall" data-panel={panel}>
      <Head>
        <span className="mini__label">
          {panel === "queue" ? "Queue" : panel === "lyrics" ? "Lyrics" : null}
        </span>
      </Head>
      <div className="mini__panel scroll">
        {panel === "art" || panel === "video" ? <Cover size={544} className="mini__cover" video={panel === "video"} /> : null}
        {panel === "queue" ? <QueueList onNavigate={desktop.showMainWindow} /> : null}
        {panel === "lyrics" ? <LyricsBody large={false} /> : null}
      </div>
      <div className="mini__foot">
        <div className="mini__row">
          {panel !== "art" && panel !== "video" ? <Cover size={120} className="mini__thumb" /> : null}
          <Meta />
          <LikeButton />
        </div>
        <Progress />
        <Transport />
        <Extras panel={panel} onPanel={onPanel} />
      </div>
    </div>
  );
}

/* ---------- pieces ---------- */

/**
 * The strip the window is dragged by, with its buttons on the right.
 *
 * Playback speed sits here rather than with the controls at the bottom, which
 * already hold as much as a window this narrow can: it is set once and left,
 * so it can live out of the way beside the window's own buttons.
 */
function Head({ children }: { children?: ReactNode }) {
  return (
    <div className="mini__head mini__drag">
      <div className="mini__headmain">{children}</div>
      <SpeedControl titled />
      <WindowButtons />
    </div>
  );
}

function Cover({ size, className, video = false }: { size: number; className: string; video?: boolean }) {
  const track = usePlayer((s) => s.track);
  const src = artworkAtLeast(track?.artwork ?? [], size);
  if (video && size > 120) return <VideoSurface priority={20} className={className} />;
  if (!src) return <div className={`${className} mini__cover--none`} />;
  return <img className={className} src={src} alt="" draggable={false} />;
}

function Meta() {
  const track = usePlayer((s) => s.track);
  if (!track) {
    return (
      <div className="mini__meta">
        <span className="mini__title">Nothing playing</span>
        <span className="mini__artist">Pick something in the app</span>
      </div>
    );
  }
  return (
    <div className="mini__meta">
      {/* Back to the full app, as clicking the title does in Spotify's. */}
      <button className="mini__title truncate" title={track.title} onClick={desktop.showMainWindow}>
        {track.title}
      </button>
      <span className="mini__artist truncate">
        <ArtistLinks artists={track.artists} onNavigate={desktop.showMainWindow} />
      </span>
    </div>
  );
}

function LikeButton() {
  const track = usePlayer((s) => s.track);
  const likedIds = useLikedIds();
  const toggleLike = useToggleLike();
  const canLike = useQueryClient().getQueryState(["liked"])?.status === "success";
  if (!track || !canLike) return null;
  const liked = likedIds.has(track.id);
  const label = liked ? "Remove from Liked Music" : "Add to Liked Music";
  return (
    <button
      className="iconbtn"
      aria-label={label}
      title={label}
      aria-pressed={liked}
      data-active={liked || undefined}
      onClick={() => toggleLike.mutate({ trackId: track.id, liked, track })}
    >
      <IconHeart size={18} filled={liked} />
    </button>
  );
}

function Transport({ compact = false }: { compact?: boolean }) {
  const { track, state, shuffle, repeat } = usePlayer();
  // Intent, as on the bar: buffering is still "playing".
  const playing = state === "playing" || state === "loading" || state === "stalled";
  return (
    <div className="mini__transport">
      {compact ? null : (
        <button
          className="iconbtn"
          aria-label="Shuffle"
          title="Shuffle"
          aria-pressed={shuffle}
          data-active={shuffle || undefined}
          onClick={() => transport.toggleShuffle()}
        >
          <IconShuffle size={18} />
        </button>
      )}
      <button className="iconbtn mini__skip" aria-label="Previous" title="Previous" disabled={!track} onClick={() => transport.prev()}>
        <IconSkipPrev size={22} />
      </button>
      <button
        className="playbtn mini__play"
        aria-label={playing ? "Pause" : "Play"}
        title={playing ? "Pause" : "Play"}
        disabled={!track}
        onClick={() => transport.toggle()}
      >
        {playing ? <IconPause size={22} /> : <IconPlay size={22} />}
      </button>
      <button className="iconbtn mini__skip" aria-label="Next" title="Next" disabled={!track} onClick={() => transport.next()}>
        <IconSkipNext size={22} />
      </button>
      {compact ? null : (
        <button
          className="iconbtn"
          aria-label={`Repeat: ${repeat}`}
          title={`Repeat: ${repeat}`}
          data-active={repeat !== "off" || undefined}
          onClick={() => transport.cycleRepeat()}
        >
          <IconRepeat size={18} />
          {repeat === "one" ? <span className="repeatone" aria-hidden="true">1</span> : null}
        </button>
      )}
    </div>
  );
}

function Progress() {
  const track = usePlayer((s) => s.track);
  const buffering = usePlayer((s) => s.state === "loading" || s.state === "stalled");
  const position = usePlaybackPosition();
  const frames = useContext(FrameWindow);
  const [scrub, setScrub] = useState<number | null>(null);
  const duration = track?.durationMs ?? 0;
  const shown = scrub ?? position;
  return (
    <div className="mini__progress" data-buffering={buffering || undefined}>
      <span className="mini__time">{formatDuration(shown)}</span>
      <Slider
        label="Seek"
        value={shown}
        max={duration}
        disabled={!track}
        step={1000}
        onChange={(v) => {
          setScrub(v);
          transport.seek(v);
          frames.requestAnimationFrame(() => setScrub(null));
        }}
      />
      <EndTime className="mini__time" duration={duration} position={shown} />
    </div>
  );
}

/** A hairline of progress for the shapes that hide the real control. */
function ThinProgress() {
  const duration = usePlayer((s) => s.track?.durationMs ?? 0);
  const position = usePlaybackPosition();
  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  return (
    <div className="mini__thin" aria-hidden="true">
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

function Extras({ panel, onPanel }: PanelProps) {
  const { blocked, reason } = useVideoControl();
  return (
    <div className="mini__extras">
      {/* The mini player has no custom tooltip layer, so title is its only tooltip. */}
      <button className="iconbtn" aria-label={panel === "video" ? "Hide music video" : reason} title={panel === "video" ? "Hide music video" : reason}
        aria-pressed={panel === "video"} data-active={panel === "video" || undefined}
        aria-disabled={panel !== "video" && blocked} onClick={() => { if (panel === "video" || !blocked) onPanel("video"); }}>
        <IconVideo size={18} />
      </button>
      <VideoNotice />
      <button
        className="iconbtn"
        aria-label="Queue"
        title="Queue"
        aria-pressed={panel === "queue"}
        data-active={panel === "queue" || undefined}
        onClick={() => onPanel("queue")}
      >
        <IconQueue size={18} />
      </button>
      <button
        className="iconbtn"
        aria-label="Lyrics"
        title="Lyrics"
        aria-pressed={panel === "lyrics"}
        data-active={panel === "lyrics" || undefined}
        onClick={() => onPanel("lyrics")}
      >
        <IconLyrics size={18} />
      </button>
      <VolumeControl className="mini__volume" />
    </div>
  );
}

/**
 * Keep on top, back to the app, close.
 *
 * The pin shows in every shape, the bar included. It used to be left out of
 * the bar, so a mini player turned off-top and then shrunk to a bar had no
 * way back: every other app went over it and nothing said why.
 */
function WindowButtons() {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const shell = window.spotifier?.mini;

  useEffect(() => {
    if (!shell) return;
    let live = true;
    void shell.prefs().then((p) => live && setPinned(p.alwaysOnTop));
    return () => {
      live = false;
    };
  }, [shell]);

  const pinLabel = pinned ? "Keeping on top — click to stop" : "Not on top — click to keep on top";
  return (
    <div className="mini__winbtns">
      {shell && pinned !== null ? (
        <button
          className="iconbtn mini__pin"
          aria-label={pinLabel}
          title={pinLabel}
          aria-pressed={pinned}
          data-active={pinned || undefined}
          onClick={() => {
            shell.setAlwaysOnTop(!pinned);
            setPinned(!pinned);
          }}
        >
          <IconPin size={16} filled={pinned} />
        </button>
      ) : null}
      <button className="iconbtn mini__openapp" aria-label="Open app" title="Open app" onClick={desktop.showMainWindow}>
        <IconOpenApp size={16} />
      </button>
      <button className="iconbtn" aria-label="Close mini player" title="Close" onClick={closeMini}>
        <IconClose size={16} />
      </button>
    </div>
  );
}
