import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  IconHeart, IconOpenApp, IconPause, IconPlay, IconRepeat, IconShuffle,
  IconSkipNext, IconSkipPrev,
} from "../components/Icon";
import { useArtColor } from "../lib/artcolor";
import type { TrayAction, TrayState } from "../lib/traystate";

interface FlyoutBridge {
  onState(fn: (s: TrayState | null) => void): () => void;
  onVisible(fn: (visible: boolean) => void): () => void;
  action(a: TrayAction | { type: "open" } | { type: "hide" }): void;
  setHeight(h: number): void;
}

declare global {
  interface Window {
    spotifierFlyout?: FlyoutBridge;
  }
}

const bridge = window.spotifierFlyout;
const send = (a: Parameters<FlyoutBridge["action"]>[0]) => bridge?.action(a);

/**
 * The tray flyout: controls, and only controls.
 *
 * What is playing, so you know what you are pressing, and the buttons to
 * change it. Anything to watch — progress, the queue, the lyrics — is the mini
 * player's job; this is for reaching the transport without finding a window.
 * The artwork's colour still tints it, as it does every now-playing surface.
 */
export function Flyout() {
  const [state, setState] = useState<TrayState | null>(null);
  const [visible, setVisible] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => bridge?.onState(setState), []);
  useEffect(() => bridge?.onVisible(setVisible), []);

  // The window is sized to the card, so its height is reported whenever it
  // changes — a track arriving, the empty state going.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !bridge) return;
    const report = () => bridge.setHeight(el.getBoundingClientRect().height);
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") send({ type: "hide" });
      // Space on the card itself, not on a focused control, which handles it.
      if (e.key === " " && e.target === document.body) {
        e.preventDefault();
        send({ type: "toggle" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const track = state?.track ?? null;
  const color = useArtColor(track?.artwork || undefined);

  return (
    <div
      ref={root}
      className="flyout"
      data-visible={visible || undefined}
      style={{ "--art": color } as CSSProperties}
    >
      {state && track ? <Controls state={state} /> : <Empty />}
    </div>
  );
}

function Controls({ state }: { state: TrayState }) {
  const track = state.track!;
  return (
    <>
      <div className="flyout__head">
        {/* Keyed on the track so a change of song fades in rather than
            swapping under the eye. */}
        <div className="flyout__now" key={track.id}>
          {track.artwork ? (
            <img className="flyout__art" src={track.artwork} alt="" draggable={false} />
          ) : (
            <div className="flyout__art" />
          )}
          <div className="flyout__meta">
            <span className="flyout__title truncate" title={track.title}>{track.title}</span>
            <span className="flyout__artist truncate" title={track.artist}>{track.artist}</span>
          </div>
        </div>
        {state.canLike ? (
          <button
            className="iconbtn"
            aria-label={state.liked ? "Remove from Liked Music" : "Add to Liked Music"}
            aria-pressed={state.liked}
            data-active={state.liked || undefined}
            onClick={() => send({ type: "like" })}
          >
            <IconHeart size={20} filled={state.liked} />
          </button>
        ) : null}
      </div>

      <div className="flyout__transport">
        <button
          className="iconbtn"
          aria-label="Shuffle"
          aria-pressed={state.shuffle}
          data-active={state.shuffle || undefined}
          onClick={() => send({ type: "shuffle" })}
        >
          <IconShuffle size={18} />
        </button>
        <button className="iconbtn iconbtn--lg" aria-label="Previous track" onClick={() => send({ type: "prev" })}>
          <IconSkipPrev size={24} />
        </button>
        <button
          className="playbtn flyout__play"
          aria-label={state.playing ? "Pause" : "Play"}
          onClick={() => send({ type: "toggle" })}
        >
          {state.playing ? <IconPause size={24} /> : <IconPlay size={24} />}
        </button>
        <button className="iconbtn iconbtn--lg" aria-label="Next track" onClick={() => send({ type: "next" })}>
          <IconSkipNext size={24} />
        </button>
        <button
          className="iconbtn"
          aria-label={`Repeat: ${state.repeat}`}
          data-active={state.repeat !== "off" || undefined}
          onClick={() => send({ type: "repeat" })}
        >
          <IconRepeat size={18} />
          {state.repeat === "one" ? <span className="repeatone" aria-hidden="true">1</span> : null}
        </button>
      </div>
    </>
  );
}

function Empty() {
  return (
    <div className="flyout__empty">
      <div className="flyout__meta">
        <span className="flyout__title">Nothing playing</span>
        <span className="flyout__artist">Pick something in the app to start listening.</span>
      </div>
      <button className="flyout__open" onClick={() => send({ type: "open" })}>
        <IconOpenApp size={16} />
        Open app
      </button>
    </div>
  );
}
