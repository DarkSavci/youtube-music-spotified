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
const DEFAULT_SIZE = { width: 320, height: 320 };
const MIN_SIZE = { width: 260, height: 72 };

let win = null;
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

/** Takes charge of the window once Electron has made it. */
function adopt(child) {
  win = child;
  // Above ordinary always-on-top windows too, as Picture-in-Picture is.
  if (prefs.alwaysOnTop) win.setAlwaysOnTop(true, "floating");

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
    win = null;
  });
}

function register(dataDir) {
  load(dataDir);

  ipcMain.handle("mini:prefs", () => ({ alwaysOnTop: prefs.alwaysOnTop }));

  ipcMain.on("mini:always-on-top", (_e, on) => {
    prefs.alwaysOnTop = Boolean(on);
    save();
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(prefs.alwaysOnTop, "floating");
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

module.exports = { FRAME, register, openHandler, adopt, isOpen };
