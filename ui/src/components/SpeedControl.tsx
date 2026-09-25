import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Slider } from "./Slider";
import { usePlayer } from "../lib/player";
import { useSettings } from "../lib/settings";
import { useTogether } from "../lib/together";
import { availableSpeeds } from "../lib/playback";
import {
  MAX_SPEED, MIN_SPEED, SPEED_PRESETS, clampSpeed, formatSpeed, playableSpeed, sliderStep, stepSpeed,
} from "../lib/speed";
import { toast } from "../lib/toast";

/**
 * The playback speed button, and the panel it opens.
 *
 * The button shows the speed as its label — the number is the state — and
 * takes the accent colour off 1×, so a sped-up player is never mistaken for a
 * normal one. The panel follows YouTube's own: the speed large, a slider with
 * a step down and up either side for anything in between, and presets below.
 *
 * With an engine that offers only some speeds (the embedded player), the
 * slider snaps to the nearest one and presets it cannot play are disabled,
 * rather than accepting a choice that would not take. In Listen Together the
 * room holds everyone at 1×, and the button says so instead of opening.
 *
 * `titled` gives it a native tooltip, for the mini player, which has no
 * tooltip layer of its own.
 */
export function SpeedControl({ titled = false }: { titled?: boolean }) {
  // The button the panel hangs from, taken from the click itself. Read from a
  // ref during render instead, the mini player — which rebuilds its layout,
  // and this button with it — could open the panel with no element yet and
  // never draw it.
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const speed = usePlayer((s) => s.speed);
  const inRoom = useTogether((s) => s.status !== "disconnected");
  const label = inRoom
    ? "Playback speed: 1× in Listen Together"
    : `Playback speed: ${formatSpeed(speed)}`;

  return (
    <>
      <button
        className="iconbtn speedbtn"
        aria-label={label}
        title={titled ? label : undefined}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-disabled={inRoom || undefined}
        data-active={speed !== 1 || undefined}
        onClick={(e) => {
          if (inRoom) {
            toast("Listen Together keeps everyone at normal speed.");
            return;
          }
          const button = e.currentTarget;
          setAnchor((current) => (current ? null : button));
        }}
      >
        {formatSpeed(speed)}
      </button>
      {anchor ? (
        <SpeedPanel
          anchor={anchor}
          onClose={() => {
            anchor.focus();
            setAnchor(null);
          }}
        />
      ) : null}
    </>
  );
}

function SpeedPanel({ anchor, onClose }: { anchor: HTMLButtonElement; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const chosen = useSettings((s) => s.playbackSpeed);
  const setSetting = useSettings((s) => s.set);
  const support = availableSpeeds();
  // What is actually playing, which on a fixed-list engine can differ from
  // what was asked for; the panel shows the truth.
  const playing = usePlayer((s) => s.speed);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  // The button can live in the mini player's window, so everything here is
  // that window's rather than this one's.
  const doc = anchor.ownerDocument;
  const view = doc.defaultView ?? window;

  const choose = (rate: number) => setSetting("playbackSpeed", playableSpeed(rate, support));
  // Latest close handler, so the setup below runs once rather than on every
  // speed change — rerunning it would pull focus back to the slider mid-click.
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const place = () => {
      // Rebuilt away while open (the mini player changing shape): close
      // rather than hang from a button that is no longer there.
      if (!anchor.isConnected) {
        close.current();
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const width = panel.current?.offsetWidth ?? 360;
      const height = panel.current?.offsetHeight ?? 220;
      const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), view.innerWidth - width - 8);
      // Above the button, which usually sits at the bottom of the window;
      // below it where there is no room above, as in the mini player's top
      // strip; and where there is room for neither, as in its one-line bar,
      // over the window itself rather than off its edge.
      if (rect.top - height - 8 >= 8) setPosition({ left, bottom: view.innerHeight - rect.top + 8 });
      else if (rect.bottom + 8 + height <= view.innerHeight - 8) setPosition({ left, top: rect.bottom + 8 });
      else setPosition({ left, top: Math.max(8, (view.innerHeight - height) / 2) });
    };
    place();
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !anchor.contains(target)) close.current();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close.current();
    };
    doc.addEventListener("pointerdown", outside);
    view.addEventListener("keydown", escape, true);
    view.addEventListener("resize", place);
    return () => {
      doc.removeEventListener("pointerdown", outside);
      view.removeEventListener("keydown", escape, true);
      view.removeEventListener("resize", place);
    };
  }, [anchor, doc, view]);

  // Into the panel once it is shown: it starts hidden until placed, and a
  // hidden element cannot take focus, so focusing it any earlier did nothing
  // and left keyboard users on the button.
  const focused = useRef(false);
  useEffect(() => {
    if (!position || focused.current) return;
    focused.current = true;
    panel.current?.querySelector<HTMLElement>("input[type=range], .speedpanel__pill[data-active], .speedpanel__pill")?.focus();
  }, [position]);

  const presetPlayable = (rate: number) => support === "any" || support.includes(rate);
  // A window too short for the full panel — the mini player as a one-line
  // bar — gets the presets alone, with a step either side: the part used most.
  const compact = view.innerHeight < 260;

  const step = (dir: -1 | 1) => {
    const to = stepSpeed(chosen, dir, support);
    return (
      <button
        className="iconbtn iconbtn--round"
        aria-label={dir < 0 ? "Slower" : "Faster"}
        disabled={to === chosen}
        onClick={() => choose(to)}
      >
        {dir < 0 ? "−" : "+"}
      </button>
    );
  };

  const presets = SPEED_PRESETS.map((rate) => (
    <div key={rate} className="speedpanel__preset">
      <button
        className="speedpanel__pill"
        aria-pressed={chosen === rate}
        data-active={chosen === rate || undefined}
        disabled={!presetPlayable(rate)}
        onClick={() => choose(rate)}
      >
        {Number.isInteger(rate) ? rate.toFixed(1) : String(rate)}
      </button>
      {rate === 1 && !compact ? <span className="speedpanel__note">Normal</span> : null}
    </div>
  ));

  return createPortal(
    <div
      ref={panel}
      className="speedpanel"
      data-compact={compact || undefined}
      role="dialog"
      aria-label={`Playback speed: ${playing.toFixed(2)}×`}
      style={position ?? { visibility: "hidden" }}
    >
      {compact ? (
        <div className="speedpanel__row">
          {step(-1)}
          <div className="speedpanel__presets">{presets}</div>
          {step(1)}
        </div>
      ) : (
        <>
          <div className="speedpanel__title">Playback speed</div>
          <div className="speedpanel__value" aria-live="polite">{playing.toFixed(2)}×</div>
          <div className="speedpanel__row">
            {step(-1)}
            <Slider
              className="speedpanel__slider"
              label="Playback speed"
              value={chosen - MIN_SPEED}
              max={MAX_SPEED - MIN_SPEED}
              step={sliderStep(support)}
              onChange={(v) => choose(clampSpeed(v + MIN_SPEED))}
            />
            {step(1)}
          </div>
          <div className="speedpanel__presets">{presets}</div>
        </>
      )}
    </div>,
    doc.body,
  );
}
