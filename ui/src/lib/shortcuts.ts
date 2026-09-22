import { usePlayer } from "./player";
import { transport } from "./playback";
import { desktop } from "./desktop";
import { toggleMini } from "./miniplayer";

/**
 * Keyboard control.
 *
 * Registered once at the app root rather than per view, because transport
 * shortcuts must work wherever focus happens to be.
 *
 * Two rules keep this from fighting the rest of the interface. Typing is never
 * intercepted, so space in a search field inserts a space rather than pausing
 * playback. And anything the browser or OS already owns is left alone.
 */

export interface Shortcut {
  id: string;
  keys: string;
  label: string;
  group: "Playback" | "Navigation" | "Interface";
  run: (nav: Navigator) => void;
}

interface Navigator {
  go(path: string): void;
  back(): void;
  forward(): void;
  toggleQueue(): void;
  toggleLyrics(): void;
  toggleFullScreen(): void;
  focusSearch(): void;
  newPlaylist(): void;
  saveCurrent(): void;
}

/** True when the caret is in an editable surface. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

/** Normalises an event into a comparable chord, e.g. "ctrl+arrowup". */
function chordOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  parts.push(e.key.toLowerCase());
  return parts.join("+");
}

const VOLUME_STEP = 0.05;
const SEEK_STEP_MS = 5_000;

export const SHORTCUTS: Shortcut[] = [
  {
    id: "playpause",
    keys: " ",
    label: "Play / pause",
    group: "Playback",
    run: () => transport.toggle(),
  },
  {
    id: "next",
    keys: "ctrl+arrowright",
    label: "Next track",
    group: "Playback",
    run: () => transport.next(),
  },
  {
    id: "prev",
    keys: "ctrl+arrowleft",
    label: "Previous track",
    group: "Playback",
    run: () => transport.prev(),
  },
  {
    id: "seek-forward",
    keys: "arrowright",
    label: "Seek forward 5s",
    group: "Playback",
    run: () => {
      const s = usePlayer.getState();
      transport.seek(s.anchor.positionMs + SEEK_STEP_MS);
    },
  },
  {
    id: "seek-back",
    keys: "arrowleft",
    label: "Seek back 5s",
    group: "Playback",
    run: () => {
      const s = usePlayer.getState();
      transport.seek(Math.max(0, s.anchor.positionMs - SEEK_STEP_MS));
    },
  },
  {
    id: "volume-up",
    keys: "ctrl+arrowup",
    label: "Volume up",
    group: "Playback",
    run: () => {
      const s = usePlayer.getState();
      transport.setVolume(s.volume + VOLUME_STEP);
    },
  },
  {
    id: "volume-down",
    keys: "ctrl+arrowdown",
    label: "Volume down",
    group: "Playback",
    run: () => {
      const s = usePlayer.getState();
      transport.setVolume(s.volume - VOLUME_STEP);
    },
  },
  {
    id: "mute",
    keys: "m",
    label: "Mute",
    group: "Playback",
    run: () => transport.toggleMute(),
  },
  {
    id: "shuffle",
    keys: "s",
    label: "Shuffle",
    group: "Playback",
    run: () => transport.toggleShuffle(),
  },
  {
    id: "repeat",
    keys: "r",
    label: "Repeat mode",
    group: "Playback",
    run: () => transport.cycleRepeat(),
  },
  { id: "home", keys: "ctrl+h", label: "Home", group: "Navigation", run: (n) => n.go("/") },
  { id: "search", keys: "/", label: "Search", group: "Navigation", run: (n) => n.go("/search") },
  {
    id: "library",
    keys: "ctrl+l",
    label: "Your library",
    group: "Navigation",
    run: (n) => n.go("/stats"),
  },
  {
    id: "queue",
    keys: "q",
    label: "Toggle queue",
    group: "Interface",
    run: (n) => n.toggleQueue(),
  },
  {
    id: "repeat",
    keys: "r",
    label: "Cycle repeat",
    group: "Playback",
    run: () => transport.cycleRepeat(),
  },
  {
    id: "save",
    keys: "ctrl+s",
    label: "Save the current track",
    group: "Playback",
    run: (nav) => nav.saveCurrent(),
  },
  {
    id: "back",
    keys: "alt+arrowleft",
    label: "Back",
    group: "Navigation",
    run: (nav) => nav.back(),
  },
  {
    id: "forward",
    keys: "alt+arrowright",
    label: "Forward",
    group: "Navigation",
    run: (nav) => nav.forward(),
  },
  {
    id: "home",
    keys: "alt+shift+h",
    label: "Home",
    group: "Navigation",
    run: (nav) => nav.go("/"),
  },
  {
    id: "search",
    keys: "ctrl+k",
    label: "Search",
    group: "Navigation",
    run: (nav) => nav.focusSearch(),
  },
  {
    id: "listening",
    keys: "alt+shift+l",
    label: "Your listening",
    group: "Navigation",
    run: (nav) => nav.go("/stats"),
  },
  {
    id: "settings",
    keys: "ctrl+,",
    label: "Settings",
    group: "Navigation",
    run: (nav) => nav.go("/settings"),
  },
  {
    id: "lyrics",
    keys: "l",
    label: "Lyrics",
    group: "Interface",
    run: (nav) => nav.toggleLyrics(),
  },
  {
    id: "fullscreen",
    keys: "f",
    label: "Now playing, full screen",
    group: "Interface",
    run: (nav) => nav.toggleFullScreen(),
  },
  {
    // "m" is mute; "p" for picture-in-picture, which is what it is.
    id: "miniplayer",
    keys: "p",
    label: "Mini player",
    group: "Interface",
    run: () => toggleMini(),
  },
  {
    id: "newplaylist",
    keys: "ctrl+n",
    label: "New playlist",
    group: "Interface",
    run: (nav) => nav.newPlaylist(),
  },
];

/**
 * Puts a chord's parts in a fixed order.
 *
 * The table is written the way people say these — "alt+shift+h" — while
 * events are read modifier by modifier, which produces "shift+alt+h". Two
 * shortcuts silently never fired because of that difference, so both sides
 * are normalised through here rather than relying on authors matching an
 * internal ordering.
 */
function normaliseChord(chord: string): string {
  const parts = chord.split("+");
  const key = parts[parts.length - 1] ?? "";
  const mods = new Set(parts.slice(0, -1));
  const out: string[] = [];
  for (const m of ["ctrl", "shift", "alt"]) {
    if (mods.has(m)) out.push(m);
  }
  out.push(key);
  return out.join("+");
}

const byChord = new Map(SHORTCUTS.map((s) => [normaliseChord(s.keys), s]));

/**
 * Installs the global handler. Returns an unsubscribe function.
 *
 * Also binds hardware media keys when running in the desktop shell, so the
 * keyboard's transport buttons work even when the window is not focused.
 */
export function installShortcuts(nav: Navigator): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;

    // Escape is handled here so it works from anywhere, including when focus
    // sits on a row rather than in a panel.
    if (e.key === "Escape") return;

    const shortcut = byChord.get(normaliseChord(chordOf(e)));
    if (!shortcut) return;

    e.preventDefault();
    shortcut.run(nav);
  };

  window.addEventListener("keydown", onKey);

  const offMedia = desktop.onMediaKey((action) => {
    if (action === "playpause" || action === "stop") transport.toggle();
    else if (action === "next") transport.next();
    else if (action === "prev") transport.prev();
  });

  return () => {
    window.removeEventListener("keydown", onKey);
    offMedia();
  };
}

/** Human-readable chord, for the shortcuts list in settings. */
export function describeKeys(keys: string): string {
  return normaliseChord(keys)
    .split("+")
    .map((part) => {
      switch (part) {
        case " ":
          return "Space";
        case "ctrl":
          return navigator.platform.startsWith("Mac") ? "Cmd" : "Ctrl";
        case "arrowright":
          return "→";
        case "arrowleft":
          return "←";
        case "arrowup":
          return "↑";
        case "arrowdown":
          return "↓";
        default:
          return part.toUpperCase();
      }
    })
    .join(" + ");
}
