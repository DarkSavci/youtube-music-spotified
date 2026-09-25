/**
 * The mini player's window.
 *
 * The renderer opens it with `window.open("", "miniplayer")` and draws into it
 * with a React portal — the approach Spotify took with Document
 * Picture-in-Picture — so the mini player is part of the main window's React
 * tree: same player store, same liked list, same lyrics cache, no messages in
 * between. This side only decides what kind of window that is.
 *
 * Two things Spotify's does not do and people ask it to: the size and place
 * survive a restart, and staying on top is a choice rather than a given.
 */

const { BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const FRAME = "miniplayer";

// Spotify's default is a square of artwork; so is this one.
const DEFAULT_SIZE = { width: 360, height: 360 };
// The smallest window every layout still fits. Narrower than 360, the
// one-line bar — the layout any short window falls back to — has too little
// left for the title once the transport and the window buttons are in. At
// 80 high the bar's tallest part, the 56px artwork, keeps 12px either side.
// The renderer picks a layout that fits within this; see layoutFor in
// ui/src/components/MiniPlayer.tsx.
const MIN_SIZE = { width: 360, height: 80 };

let win = null;
let keeper = null;
let prefsFile = null;
let prefs = { bounds: null, alwaysOnTop: true };
let saveTimer = null;

function load(dataDir) {
  prefsFile = path.join(dataDir, "miniplayer.json");
  try {
    const saved = JSON.parse(fs.readFileSync(prefsFile, "utf8"));
    prefs = {
      bounds: saved.bounds ?? null,
      alwaysOnTop: saved.alwaysOnTop !== false,
    };
  } catch {
    /* first run, or unreadable: defaults */
  }
}

function save() {
  clearTimeout(saveTimer);
  // Moving a window fires dozens of events; one write when it settles.
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(prefsFile, JSON.stringify(prefs));
    } catch (err) {
      console.warn("[mini] could not save:", err.message);
    }
  }, 400);
}

/**
 * Saved bounds, if they still land on a screen.
 *
 * A monitor unplugged since last time would otherwise open the mini player
 * somewhere nobody can see it — and an always-on-top window that cannot be
 * found is worse than one in the default place.
 */
function restoredBounds() {
  const b = prefs.bounds;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  const visible = screen.getAllDisplays().some(({ workArea: wa }) => {
    const overlapX = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x);
    const overlapY = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y);
    return overlapX >= 80 && overlapY >= 40;
  });
  return visible ? b : null;
}

/** Bottom-right of the primary display, where Picture-in-Picture goes. */
function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    ...DEFAULT_SIZE,
    x: wa.x + wa.width - DEFAULT_SIZE.width - 24,
    y: wa.y + wa.height - DEFAULT_SIZE.height - 24,
  };
}

/**
 * The answer to the main window's open handler, for a mini player request.
 * Anything else it opens is not ours.
 */
function openHandler({ frameName, url }) {
  if (frameName !== FRAME || (url && url !== "about:blank")) return null;
  const bounds = restoredBounds() ?? defaultBounds();
  return {
    action: "allow",
    overrideBrowserWindowOptions: {
      ...bounds,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      title: "Mini player",
      // Drawn by the app, like the main window. Frameless but still resizable
      // from its edges, and on Windows 11 still rounded and shadowed.
      frame: false,
      backgroundColor: "#121212",
      alwaysOnTop: prefs.alwaysOnTop,
      fullscreenable: false,
      maximizable: false,
      autoHideMenuBar: true,
    },
  };
}

/*
 * Staying on top, and staying there.
 *
 * Setting it once was not enough. On Windows a call to setAlwaysOnTop is
 * sometimes simply dropped — measured on this machine, one call in several,
 * with no pattern to which — and the window then never becomes topmost at
 * all: every app went over it. When a call does take, it holds through focus
 * changes, minimising and resizing, and Electron's own isAlwaysOnTop() always
 * agreed with the window's real WS_EX_TOPMOST flag.
 *
 * So the setting is checked and re-applied rather than trusted: every second
 * while the mini player is open, and at once whenever it is shown, restored or
 * loses focus. The check itself costs nothing (no call into the OS), and the
 * setting is only re-applied when the check fails.
 *
 * Being topmost is not the whole of it, either. Windows keeps its topmost
 * windows in the order they were last activated, so another app's own
 * always-on-top window (Task Manager, a chat overlay, a browser's picture-in-
 * picture) clicked after the mini player covered it — measured: every time,
 * old code and new alike, until the mini player also moved itself back to the
 * top of that band. It does that on the same one-second check. Moving to the
 * top does not activate the window, so it never takes focus from what you are
 * typing into; it only skips it while the mini player is the focused window,
 * where it is on top already.
 */
const ON_TOP_LEVEL = process.platform === "darwin" ? "floating" : "screen-saver";
const KEEP_EVERY_MS = 1000;

function applyOnTop() {
  if (!win || win.isDestroyed()) return;
  if (!prefs.alwaysOnTop) {
    win.setAlwaysOnTop(false);
    return;
  }
  if (!win.isAlwaysOnTop()) {
    win.setAlwaysOnTop(true, ON_TOP_LEVEL);
    if (!win.isAlwaysOnTop()) console.warn("[mini] always-on-top did not take; retrying");
  }
  if (process.platform === "win32" && win.isVisible() && !win.isMinimized() && !win.isFocused()) win.moveTop();
}

function keepOnTop() {
  clearInterval(keeper);
  keeper = null;
  applyOnTop();
  if (prefs.alwaysOnTop && win && !win.isDestroyed()) {
    keeper = setInterval(applyOnTop, KEEP_EVERY_MS);
    keeper.unref?.();
  }
}

/** Takes charge of the window once Electron has made it. */
function adopt(child) {
  win = child;
  keepOnTop();
  for (const event of ["show", "restore", "ready-to-show"]) win.on(event, applyOnTop);
  win.on("blur", applyOnTop);

  const remember = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    prefs.bounds = win.getBounds();
    save();
  };
  // "move" and "resize" rather than "moved" and "resized": those fire only
  // for a drag by hand, and the window also grows itself to fit the queue.
  // The write is debounced, so the stream of events during a drag is cheap.
  win.on("move", remember);
  win.on("resize", remember);
  win.on("close", remember);
  win.on("closed", () => {
    clearInterval(keeper);
    keeper = null;
    win = null;
  });
}

function register(dataDir) {
  load(dataDir);

  ipcMain.handle("mini:prefs", () => ({ alwaysOnTop: prefs.alwaysOnTop }));

  ipcMain.on("mini:always-on-top", (_e, on) => {
    prefs.alwaysOnTop = Boolean(on);
    save();
    keepOnTop();
  });

  /*
   * Growing to fit a panel. Opening the queue or the lyrics from the bar or
   * the square needs room they do not have; the window grows towards the
   * middle of its screen, so one pinned in a corner does not grow off it.
   */
  ipcMain.on("mini:ensure-size", (_e, size) => {
    if (!win || win.isDestroyed() || !size) return;
    const b = win.getBounds();
    const width = Math.max(b.width, Math.round(Number(size.width) || 0));
    const height = Math.max(b.height, Math.round(Number(size.height) || 0));
    if (width === b.width && height === b.height) return;
    const wa = screen.getDisplayMatching(b).workArea;
    const growLeft = b.x + b.width / 2 > wa.x + wa.width / 2;
    const growUp = b.y + b.height / 2 > wa.y + wa.height / 2;
    let x = growLeft ? b.x + b.width - width : b.x;
    let y = growUp ? b.y + b.height - height : b.y;
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - width);
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - height);
    win.setBounds({ x, y, width, height }, true);
  });
}

function isOpen() {
  return Boolean(win && !win.isDestroyed());
}

function close() { if (win && !win.isDestroyed()) win.close(); }

module.exports = { FRAME, register, openHandler, adopt, isOpen, close };
