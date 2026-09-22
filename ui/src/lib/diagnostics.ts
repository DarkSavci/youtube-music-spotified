/**
 * The page's half of the app log.
 *
 * The desktop shell keeps one log file for the core, the shell and the page,
 * so a failure can be read end to end. This forwards the page's share of it:
 * every warning and error, uncaught exceptions and rejections, and the
 * tagged lines ("[playback] …") the app writes on purpose. Untagged debug and
 * info output from libraries stays in DevTools, where it is useful, and out of
 * a file someone has to read.
 *
 * In a plain browser there is no shell and no file; everything here is a no-op.
 */

import { engineName, isServerAuthoritative } from "./playback";
import { usePlayer } from "./player";
import { useSettings } from "./settings";

type Level = "debug" | "info" | "warn" | "error";
interface Entry {
  level: Level;
  message: string;
}

interface LogBridge {
  write(entries: Entry[]): void;
  exportBundle(page: unknown): Promise<{ ok: boolean; path?: string; reason?: string }>;
  openFolder(): void;
}

function bridge(): LogBridge | undefined {
  return (window.spotifier as { logs?: LogBridge } | undefined)?.logs;
}

const pending: Entry[] = [];
let timer: number | undefined;

function flush() {
  timer = undefined;
  if (pending.length === 0) return;
  bridge()?.write(pending.splice(0));
}

function push(level: Level, message: string) {
  pending.push({ level, message });
  // Batched, so a burst of errors is one message to the shell rather than a
  // hundred; an error is sent promptly in case the page is about to go.
  if (level === "error") flush();
  else if (timer === undefined) timer = window.setTimeout(flush, 1000);
}

function format(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A line the app wrote on purpose carries a tag; library chatter does not. */
const TAGGED = /^\[[\w-]+\]/;

let installed = false;

/** Starts forwarding. Idempotent, and a no-op outside the desktop app. */
export function installLogForwarding() {
  if (installed || !bridge()) return;
  installed = true;

  const methods: [keyof Console & ("debug" | "log" | "info" | "warn" | "error"), Level, boolean][] = [
    ["debug", "debug", true],
    ["log", "info", true],
    ["info", "info", true],
    ["warn", "warn", false],
    ["error", "error", false],
  ];
  for (const [method, level, tagOnly] of methods) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      const message = args.map(format).join(" ");
      if (tagOnly && !TAGGED.test(message)) return;
      push(level, message);
    };
  }

  window.addEventListener("error", (e) => {
    push("error", `[page] uncaught: ${e.error ? format(e.error) : e.message} at ${e.filename}:${e.lineno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    push("error", `[page] unhandled rejection: ${format(e.reason)}`);
  });
  window.addEventListener("online", () => push("info", "[page] network online"));
  window.addEventListener("offline", () => push("warn", "[page] network offline"));
  window.addEventListener("pagehide", flush);

  push("info", `[page] started, route ${location.hash || "/"}`);
}

/**
 * What the page knows that the log may not: the player as it is now.
 *
 * Titles and IDs only — the queue itself is not sent, just its size and where
 * in it playback is.
 */
function pageState() {
  const p = usePlayer.getState();
  const s = useSettings.getState();
  const prefs = Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v !== "function"));
  return {
    route: location.hash || "/",
    online: navigator.onLine,
    engine: engineName(),
    coreAuthoritative: isServerAuthoritative(),
    player: {
      state: p.state,
      track: p.track ? { id: p.track.id, title: p.track.title } : null,
      index: p.index,
      queueLength: p.queue.length,
      unplayableInQueue: p.queue.filter((t) => t.playable === false).length,
      origin: p.origin,
      shuffle: p.shuffle,
      repeat: p.repeat,
      notice: p.notice,
    },
    settings: prefs,
  };
}

export const diagnostics = {
  get available(): boolean {
    return Boolean(bridge());
  },

  /** Writes the bundle to Downloads and shows it. */
  async exportBundle(): Promise<{ ok: boolean; path?: string; reason?: string }> {
    const logs = bridge();
    if (!logs) return { ok: false, reason: "unavailable" };
    flush();
    return logs.exportBundle(pageState());
  },

  openFolder(): void {
    bridge()?.openFolder();
  },
};
