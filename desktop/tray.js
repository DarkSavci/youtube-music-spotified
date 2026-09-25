/**
 * Notification-area icon, its flyout, and the taskbar thumbnail buttons.
 *
 * What makes closing the window different from quitting. A music player is
 * mostly listened to, not looked at, so the close button hides the window and
 * the music carries on; the icon is how the player stays within reach. The
 * same trade Spotify makes with its "close button should minimise" setting,
 * which is why it is a setting here too.
 *
 * Three surfaces, one state:
 *
 *   click        a flyout above the icon, drawn by the UI bundle (tray.html)
 *                in the app's own design: what is playing, like, and the
 *                transport. Controls only — anything to watch, like progress,
 *                the queue or lyrics, is the mini player's.
 *   right-click  a native menu, dark, for the things menus are for: quick
 *                transport, the mini player, showing the window, a waiting
 *                update, quitting.
 *   taskbar      previous / play-pause / next on the window's thumbnail, as
 *                Spotify has.
 *
 * The main window's renderer owns the truth — the player, the liked list, the
 * close preference — and pushes a snapshot here whenever it changes. Every
 * action, from any surface, goes back to it as a `tray:action`, so there is
 * one place that knows how to like a track or skip one.
 */

const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, nativeTheme, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const miniplayer = require("./miniplayer");
const updater = require("./updater");

// Windows truncates a tray tooltip past 127 characters, mid-word.
const TOOLTIP_MAX = 127;
const FLYOUT_WIDTH = 360;
// Gap between the flyout and the taskbar, the one Windows' own flyouts keep.
const FLYOUT_MARGIN = 12;

let tray = null;
let flyout = null;
let getWindow = () => null;
let pageSource = null;
let quitting = false;
let flyoutHeight = 150;
let flyoutHiddenAt = 0;

/** Last snapshot from the renderer. See ui/src/components/TrayBridge.tsx. */
let state = null;

/*
 * On until the renderer says otherwise, matching the setting's default. The
 * renderer reports the real value as soon as it loads, long before anyone can
 * reach the close button.
 */
let closeToTray = true;

const branding = (...p) => path.join(__dirname, "branding", ...p);

function trayIcon() {
  // The .ico carries the small sizes the notification area draws at; the PNG
  // scaled down is blurry there.
  if (process.platform === "darwin") {
    const icon = nativeImage.createFromPath(branding("trayTemplate.png"));
    icon.setTemplateImage(true);
    return icon;
  }
  return branding(process.platform === "win32" ? "icon.ico" : "icon.png");
}

/* ---------- actions ---------- */

function mainWindow() {
  const win = getWindow();
  return win && !win.isDestroyed() ? win : null;
}

function showWindow() {
  const win = mainWindow();
  if (!win) return;
  hideFlyout();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Hands an action to the renderer that owns playback. */
function dispatch(action) {
  mainWindow()?.webContents.send("tray:action", action);
}

/* ---------- tooltip and menu ---------- */

function nowPlayingLine() {
  const t = state?.track;
  if (!t) return null;
  return t.artist ? `${t.title} — ${t.artist}` : t.title;
}

function tooltip() {
  const line = nowPlayingLine() ?? app.getName();
  return line.length > TOOLTIP_MAX ? `${line.slice(0, TOOLTIP_MAX - 1)}…` : line;
}

function buildMenu() {
  const hasTrack = Boolean(state?.track);
  const win = mainWindow();
  const visible = Boolean(win?.isVisible());
  const line = nowPlayingLine();

  const template = [];
  if (line) {
    // A menu item cannot wrap, and a long title pushes the menu across the
    // screen; the tooltip carries the full line.
    const short = line.length > 48 ? `${line.slice(0, 47)}…` : line;
    template.push({ label: short, enabled: false }, { type: "separator" });
  }
  template.push(
    {
      label: state?.playing ? "Pause" : "Play",
      enabled: hasTrack,
      click: () => dispatch({ type: "toggle" }),
    },
    { label: "Next", enabled: hasTrack, click: () => dispatch({ type: "next" }) },
    { label: "Previous", enabled: hasTrack, click: () => dispatch({ type: "prev" }) },
  );
  if (hasTrack && state.canLike) {
    template.push({
      label: state.liked ? "Remove from Liked Music" : "Add to Liked Music",
      click: () => dispatch({ type: "like" }),
    });
  }
  template.push(
    { type: "separator" },
    {
      label: "Mini player",
      type: "checkbox",
      checked: Boolean(state?.miniOpen) || miniplayer.isOpen(),
      click: () => dispatch({ type: "mini" }),
    },
    visible
      ? { label: "Hide window", click: () => mainWindow()?.hide() }
      : { label: `Open ${app.getName()}`, click: showWindow },
    { type: "separator" },
  );
  const update = updater.pending();
  if (update) {
    template.push({ label: `Restart to update to ${update}`, click: updater.install });
  }
  template.push({ label: `Quit ${app.getName()}`, click: () => app.quit() });
  return Menu.buildFromTemplate(template);
}

/* ---------- taskbar thumbnail buttons ---------- */

/*
 * The icons come in one PNG per Windows scaling step; see
 * make-thumbar-icons.js for where they come from.
 *
 * Electron hands Windows only an image's 1x bitmap, so a nativeImage with @2x
 * siblings still sends the 16px one, and Windows stretches it on a scaled
 * display. Instead the file drawn for the window's scale is loaded as the 1x
 * image itself, so Windows receives exactly the pixels it will draw.
 */
const THUMB_SCALES = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
const thumbIcons = new Map();
let thumbScale = 1;

/** The smallest drawn scale that covers the display's, so Windows only ever shrinks. */
function thumbScaleFor(win) {
  const factor = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
  return THUMB_SCALES.find((s) => s >= factor - 0.01) ?? THUMB_SCALES[THUMB_SCALES.length - 1];
}

function thumbIcon(name) {
  const key = `${name}@${thumbScale}`;
  if (!thumbIcons.has(key)) {
    const file = thumbScale === 1 ? `${name}.png` : `${name}@${thumbScale}x.png`;
    const png = fs.readFileSync(branding("thumbar", file));
    thumbIcons.set(key, nativeImage.createFromBuffer(png, { scaleFactor: 1 }));
  }
  return thumbIcons.get(key);
}

let lastThumbar = "";
function updateThumbar(force = false) {
  const win = mainWindow();
  // Buttons added before the window has a taskbar button are silently
  // dropped, and Electron only ever adds once — later calls merely update
  // buttons that are not there. The "show" handler sets them once it exists.
  if (process.platform !== "win32" || !win || !win.isVisible()) return;
  const hasTrack = Boolean(state?.track);
  const playing = Boolean(state?.playing);
  thumbScale = thumbScaleFor(win);
  const canLike = hasTrack && Boolean(state?.canLike);
  const liked = Boolean(state?.liked);
  const key = `${hasTrack}:${playing}:${canLike}:${liked}:${thumbScale}`;
  if (!force && key === lastThumbar) return;
  lastThumbar = key;
  // No "nobackground": the button background is also where Windows draws the
  // hover and pressed states, and without it the buttons give no feedback.
  const flags = hasTrack ? [] : ["disabled"];
  win.setThumbarButtons([
    // First, as Spotify places it. Hidden while there is nothing to like —
    // signed out, or the liked list still loading: Windows dims a disabled
    // button's frame and glyph together, which on a thin heart reads as broken.
    {
      tooltip: liked ? "Remove from Liked Music" : "Add to Liked Music",
      icon: thumbIcon(liked ? "liked" : "like"),
      flags: canLike ? [] : ["hidden"],
      click: () => dispatch({ type: "like" }),
    },
    { tooltip: "Previous", icon: thumbIcon("prev"), flags, click: () => dispatch({ type: "prev" }) },
    {
      tooltip: playing ? "Pause" : "Play",
      icon: thumbIcon(playing ? "pause" : "play"),
      flags,
      click: () => dispatch({ type: "toggle" }),
    },
    { tooltip: "Next", icon: thumbIcon("next"), flags, click: () => dispatch({ type: "next" }) },
  ]);
}

/* ---------- flyout ---------- */

function createFlyout() {
  flyout = new BrowserWindow({
    width: FLYOUT_WIDTH,
    height: flyoutHeight,
    show: false,
    frame: false,
    // Opaque rather than transparent on purpose: an opaque frameless window
    // gets Windows 11's own rounded corners and shadow, which is what makes it
    // read as part of the shell rather than a web page floating over it.
    backgroundColor: "#181818",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "flyout-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // It resets to its closed look while hidden, so the next open animates
      // in rather than flashing the last frame; that needs it to keep
      // rendering when not on screen.
      backgroundThrottling: false,
    },
  });

  // A flyout is dismissed by looking away from it, like the ones Windows
  // draws: clicking anywhere else closes it.
  flyout.on("blur", hideFlyout);
  flyout.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  flyout.webContents.on("did-finish-load", () => {
    if (state) flyout.webContents.send("flyout:state", state);
  });

  if (pageSource?.url) flyout.loadURL(`${pageSource.url}tray.html`);
  else if (pageSource?.dir) flyout.loadFile(path.join(pageSource.dir, "tray.html"));
}

/**
 * Where the flyout goes: against the taskbar, centred on the icon.
 *
 * The taskbar can sit on any edge, and the work area says which: it is the
 * display minus the taskbar. When the two are equal the taskbar auto-hides,
 * and the icon's position on the display decides instead.
 */
function flyoutPosition() {
  const icon = tray.getBounds();
  const cx = icon.x + icon.width / 2;
  const cy = icon.y + icon.height / 2;
  const display = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
  const b = display.bounds;
  const wa = display.workArea;
  const w = FLYOUT_WIDTH;
  const h = flyoutHeight;

  let edge;
  if (wa.y > b.y) edge = "top";
  else if (wa.x > b.x) edge = "left";
  else if (wa.width < b.width) edge = "right";
  else if (wa.height < b.height) edge = "bottom";
  else edge = cy < b.y + b.height / 2 ? "top" : "bottom";

  const clampX = (x) => Math.min(Math.max(x, wa.x + FLYOUT_MARGIN), wa.x + wa.width - w - FLYOUT_MARGIN);
  const clampY = (y) => Math.min(Math.max(y, wa.y + FLYOUT_MARGIN), wa.y + wa.height - h - FLYOUT_MARGIN);

  switch (edge) {
    case "top":
      return { x: clampX(cx - w / 2), y: wa.y + FLYOUT_MARGIN };
    case "left":
      return { x: wa.x + FLYOUT_MARGIN, y: clampY(cy - h / 2) };
    case "right":
      return { x: wa.x + wa.width - w - FLYOUT_MARGIN, y: clampY(cy - h / 2) };
    default:
      return { x: clampX(cx - w / 2), y: wa.y + wa.height - h - FLYOUT_MARGIN };
  }
}

function placeFlyout() {
  const { x, y } = flyoutPosition();
  flyout.setBounds({ x: Math.round(x), y: Math.round(y), width: FLYOUT_WIDTH, height: flyoutHeight });
}

function showFlyout() {
  if (!flyout || flyout.isDestroyed()) createFlyout();
  placeFlyout();
  flyout.show();
  flyout.focus();
  flyout.webContents.send("flyout:visible", true);
}

function hideFlyout() {
  if (!flyout || flyout.isDestroyed() || !flyout.isVisible()) return;
  flyoutHiddenAt = Date.now();
  flyout.hide();
  flyout.webContents.send("flyout:visible", false);
}

function toggleFlyout() {
  // Clicking the icon while the flyout is open blurs the flyout first, which
  // hides it — and then the click would open it straight back up. A click
  // that lands just after a blur-hide was aimed at closing it.
  if (Date.now() - flyoutHiddenAt < 250) return;
  if (flyout && !flyout.isDestroyed() && flyout.isVisible()) hideFlyout();
  else showFlyout();
}

/* ---------- state ---------- */

function refresh() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(tooltip());
  updateThumbar();
}

/** Keeps only what the surfaces draw, so the renderer cannot hand us more. */
function sanitise(s) {
  if (!s || typeof s !== "object") return null;
  const t = s.track;
  const str = (v) => (typeof v === "string" ? v : "");
  return {
    track:
      t && typeof t === "object" && typeof t.title === "string"
        ? {
            id: str(t.id),
            title: t.title,
            artist: str(t.artist),
            artwork: /^https:\/\//.test(str(t.artwork)) ? t.artwork : "",
          }
        : null,
    playing: Boolean(s.playing),
    liked: Boolean(s.liked),
    canLike: Boolean(s.canLike),
    shuffle: Boolean(s.shuffle),
    repeat: ["off", "one", "all"].includes(s.repeat) ? s.repeat : "off",
    miniOpen: Boolean(s.miniOpen),
  };
}

/* ---------- setup ---------- */

/**
 * Creates the icon and the flyout, and takes over the close button.
 *
 * `windowGetter` is a function rather than the window itself because the main
 * window can be recreated (macOS `activate`), and the tray outlives any one of
 * them. `source` is where the UI bundle is: `{ url }` for the dev server,
 * `{ dir }` for the built files.
 */
function create(windowGetter, source) {
  getWindow = windowGetter;
  pageSource = source;

  // The app is dark and has no light theme; the native menu should not be the
  // one light thing in it.
  nativeTheme.themeSource = "dark";

  // Held in a module variable on purpose: a Tray nothing references is
  // garbage-collected, and the icon vanishes from the notification area.
  tray = new Tray(trayIcon());
  tray.on("click", toggleFlyout);
  tray.on("double-click", showWindow);
  // Built on demand rather than kept set, so it always reflects the moment it
  // is opened — including whether the window is currently visible.
  tray.on("right-click", () => {
    hideFlyout();
    tray.popUpContextMenu(buildMenu());
  });
  refresh();

  // Loaded now, hidden, so the first click opens it without a blank frame.
  createFlyout();

  // A real quit — from the menu, the OS, an update — must not be turned into
  // a hide by the close handler.
  app.on("before-quit", () => {
    quitting = true;
  });

  ipcMain.on("tray:state", (_e, next) => {
    state = sanitise(next);
    refresh();
    if (flyout && !flyout.isDestroyed()) flyout.webContents.send("flyout:state", state);
  });

  ipcMain.on("tray:close-to-tray", (_e, on) => {
    closeToTray = Boolean(on);
  });

  // The flyout's requests. Only its own window may send these.
  const fromFlyout = (e) => flyout && !flyout.isDestroyed() && e.sender === flyout.webContents;

  ipcMain.on("flyout:action", (e, action) => {
    if (!fromFlyout(e) || !action || typeof action.type !== "string") return;
    if (action.type === "open") return showWindow();
    if (action.type === "hide") return hideFlyout();
    dispatch(action);
  });

  // The page sizes itself to its content; the window follows.
  ipcMain.on("flyout:height", (e, h) => {
    if (!fromFlyout(e) || !Number.isFinite(h)) return;
    flyoutHeight = Math.max(80, Math.min(600, Math.ceil(h)));
    if (flyout.isVisible()) placeFlyout();
    else flyout.setContentSize(FLYOUT_WIDTH, flyoutHeight);
  });
}

/**
 * Makes the close button hide `win` instead of closing it, while the setting
 * is on, and gives it the taskbar buttons. Called for each main window as it
 * is created.
 */
function attach(win) {
  win.on("close", (e) => {
    if (quitting) return;
    if (!closeToTray) {
      if (process.platform === "darwin") {
        e.preventDefault();
        app.quit();
      }
      return;
    }
    e.preventDefault();
    win.hide();
  });
  // Windows drops thumbnail buttons when a window is hidden and shown again.
  win.on("show", () => updateThumbar(true));
  // Dragged onto a display with other scaling, or the scaling changed under it:
  // the icons have to be redrawn at the new size. Unchanged scale is a no-op.
  win.on("moved", () => updateThumbar());
  screen.on("display-metrics-changed", () => updateThumbar());
  win.once("ready-to-show", () => updateThumbar(true));
}

function destroy() {
  if (flyout && !flyout.isDestroyed()) flyout.destroy();
  flyout = null;
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

module.exports = { create, attach, showWindow, destroy };
