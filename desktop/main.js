/**
 * Electron main process.
 *
 * Owns three things the web build cannot: the window, the Go sidecar's
 * lifetime, and the operating system's media integration.
 *
 * The sidecar is the delicate part. It holds the user's credentials and
 * resolves streams, so it must die with the app — an orphaned one keeps a port
 * bound and a session alive after the window is gone, which is the classic bug
 * in this shape of application. Every exit path below routes through one
 * shutdown function, including the abnormal ones.
 */

const { app, BrowserWindow, ipcMain, shell, globalShortcut, Menu, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs");
const auth = require("./auth");
const tray = require("./tray");
const miniplayer = require("./miniplayer");
const updater = require("./updater");
const logs = require("./logs");
const { vendorDirectory } = require("./platform");
const { stopChild } = require("./child-process");
const { waitForOwnedCore } = require("./core-ready");

const isDev = !app.isPackaged;
const CORE_PORT = 8674;
const CORE_HOST = "127.0.0.1";
const DEV_URL = "http://127.0.0.1:5219/";

let mainWindow = null;
let core = null;
let shuttingDown = false;
let devServerUp = false;

/* ---------- sidecar ---------- */

function corePath() {
  if (isDev) {
    // In development the binary is built into the repo root.
    return path.join(__dirname, "..", "bin", process.platform === "win32" ? "spotifier.exe" : "spotifier");
  }
  // Packaged: shipped alongside the app rather than inside the asar, which
  // cannot execute binaries.
  return path.join(process.resourcesPath, process.platform === "win32" ? "spotifier.exe" : "spotifier");
}

/*
 * yt-dlp, which build.js bundles next to the core.
 *
 * It is what reaches the subscriber audio tiers, so the core is pointed at a
 * known copy rather than left to find one on PATH — which on most machines
 * does not exist, and then every track plays at standard quality.
 *
 * The bundle is yt-dlp's unpacked Windows build (a folder, not the single
 * self-extracting .exe, which spends over a second unpacking itself on every
 * track). A newer copy fetched by updateYtdlp() takes precedence once it has
 * been verified and unpacked.
 */
const YTDLP_EXE = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";

function updatedYtdlpDir() {
  return path.join(dataDir(), "yt-dlp");
}

function ytdlpPath() {
  const updated = path.join(updatedYtdlpDir(), "current", YTDLP_EXE);
  if (!isDev && fs.existsSync(updated)) return updated;
  const bundled = isDev
    ? path.join(vendorDirectory(__dirname), "yt-dlp", YTDLP_EXE)
    : path.join(process.resourcesPath, "yt-dlp", YTDLP_EXE);
  return fs.existsSync(bundled) ? bundled : null;
}

/*
 * Deno, which build.js bundles beside yt-dlp.
 *
 * yt-dlp solves YouTube's player challenges in JavaScript and cannot play
 * anything without a runtime for it. Bundled rather than looked for on PATH,
 * which is how it only ever worked on machines that had Deno installed.
 */
function denoPath() {
  const exe = process.platform === "win32" ? "deno.exe" : "deno";
  const bundled = isDev
    ? path.join(vendorDirectory(__dirname), "deno", exe)
    : path.join(process.resourcesPath, "deno", exe);
  return fs.existsSync(bundled) ? bundled : null;
}

/*
 * Keeps yt-dlp current, at most once a day.
 *
 * yt-dlp tracks YouTube's changes, and a copy frozen at build time is the
 * usual reason it stops working — at which point playback quietly drops to
 * standard quality. Its own -U does not update the unpacked build, so this
 * does what -U would: fetch the release's checksum list, and if the archive
 * differs from the one in use, download it, verify it, and unpack it beside
 * the data. The switch happens at the next launch, never under a core that
 * may be running the old copy at that moment.
 */
const YTDLP_RELEASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const YTDLP_UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;

async function updateYtdlp() {
  if (isDev || process.platform !== "win32") return;
  const root = updatedYtdlpDir();
  const stamp = path.join(root, "checked");
  try {
    if (Date.now() - fs.statSync(stamp).mtimeMs < YTDLP_UPDATE_EVERY_MS) return;
  } catch {
    /* never checked */
  }
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(stamp, new Date().toISOString());

    const sums = await (await fetch(`${YTDLP_RELEASE}/SHA2-256SUMS`)).text();
    const line = sums.split(/\r?\n/).find((l) => / yt-dlp_win\.zip$/.test(l.trim()));
    const expected = line && line.trim().split(/\s+/)[0].toLowerCase();
    if (!expected) return;

    // The hash of what is in use: the last update's, or the bundle's.
    const inUse = path.join(root, "current.sha256");
    const bundledHash = path.join(process.resourcesPath, "yt-dlp", "release.sha256");
    const current = [inUse, bundledHash]
      .map((p) => {
        try {
          return fs.readFileSync(p, "utf8").trim();
        } catch {
          return "";
        }
      })
      .find(Boolean);
    if (current === expected) return;

    const res = await fetch(`${YTDLP_RELEASE}/yt-dlp_win.zip`);
    if (!res.ok) return;
    const zip = Buffer.from(await res.arrayBuffer());
    const actual = require("node:crypto").createHash("sha256").update(zip).digest("hex");
    if (actual !== expected) {
      console.warn("[yt-dlp] update rejected: checksum mismatch");
      return;
    }

    const zipPath = path.join(root, "yt-dlp_win.zip");
    const next = path.join(root, "next");
    fs.writeFileSync(zipPath, zip);
    fs.rmSync(next, { recursive: true, force: true });
    fs.mkdirSync(next, { recursive: true });
    await new Promise((resolve, reject) => {
      const tar = spawn(path.join(process.env.SystemRoot || "C:/Windows", "System32", "tar.exe"), ["-xf", zipPath, "-C", next], { windowsHide: true });
      tar.on("error", reject);
      tar.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
    });
    fs.rmSync(zipPath, { force: true });
    if (!fs.existsSync(path.join(next, YTDLP_EXE))) return;

    // Staged; promoted to "current" at the next launch.
    fs.writeFileSync(path.join(next, "release.sha256"), expected);
    console.log("[yt-dlp] update staged for the next launch");
  } catch (err) {
    console.warn("[yt-dlp] update failed:", err.message);
  }
}

/** Moves a staged update into place, before anything can be running it. */
function promoteYtdlpUpdate() {
  if (isDev) return;
  const root = updatedYtdlpDir();
  const next = path.join(root, "next");
  const hashFile = path.join(next, "release.sha256");
  if (!fs.existsSync(hashFile)) return;
  try {
    const current = path.join(root, "current");
    fs.rmSync(current, { recursive: true, force: true });
    fs.renameSync(next, current);
    fs.copyFileSync(path.join(current, "release.sha256"), path.join(root, "current.sha256"));
  } catch (err) {
    console.warn("[yt-dlp] could not apply the staged update:", err.message);
  }
}

/**
 * Credentials and the local database live in the per-user data directory, not
 * beside the executable — so an app update never touches them and a
 * multi-user machine keeps them separate.
 */
/*
 * The data directory keeps its original name.
 *
 * Electron derives userData from the app name, so renaming the product would
 * silently move it — and leave the credentials, the database and every
 * setting behind in a folder nothing looks in any more. Renaming an app is
 * not a reason to sign someone out, so the path is pinned to what it has
 * always been rather than following the name.
 */
const DATA_DIR_NAME = "Spotifier";

// Set at load, not when first asked for: Electron initialises its profile —
// the lock file, Local State — the moment it starts, under whatever name it
// has then. Setting the path later left a stray folder behind on every launch.
app.setPath("userData", path.join(app.getPath("appData"), DATA_DIR_NAME));

// The log opens next, before anything below has a chance to say something.
logs.init(dataDir());

/*
 * Keep playback running at full speed in the background.
 *
 * The audio engine lives in the renderer and runs on timers: the crossfade
 * trigger, the stall watchdog, the position reports. Chromium slows a hidden
 * or minimised window's timers down to once a minute, which is exactly when
 * a music player is most often running. The window's own
 * backgroundThrottling:false covers most of it; these cover the rest, the
 * same set ytmdesktop2 uses.
 */
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-features", "IntensiveWakeUpThrottling");

function dataDir() {
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function startCore() {
  const bin = corePath();
  if (!fs.existsSync(bin)) {
    console.error(`[core] binary not found at ${bin}`);
    throw new Error(`Core binary not found: ${bin}`);
  }

  const args = [
    "-addr", `${CORE_HOST}:${CORE_PORT}`,
    "-credentials", path.join(dataDir(), "credentials.json"),
    "-db", path.join(dataDir(), "spotifier.db"),
  ];
  const ytdlp = ytdlpPath();
  if (ytdlp) args.push("-ytdlp", ytdlp);
  const deno = denoPath();
  if (deno) args.push("-deno", deno);
  else console.warn("[core] no bundled deno; yt-dlp will look for one on PATH");

  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  child.ready = waitForOwnedCore(child);
  logs.attachCore(child);

  child.on("error", (err) => console.error("[core] could not start:", err.message));
  child.on("exit", (code, signal) => {
    if (core === child) core = null;
    if (shuttingDown || restartingCore) return;
    // The core dying under us leaves a window that can browse nothing. Say so
    // rather than letting every request fail silently.
    console.error(`[core] exited unexpectedly (code=${code} signal=${signal})`);
    mainWindow?.webContents.send("core-status", { running: false, code });
  });

  return child;
}

/*
 * Restarts the core after the account changes, then reloads the window.
 *
 * The core wires everything that needs the account — the catalogue client,
 * the cookies yt-dlp reaches Premium audio with, loudness, lyrics, reporting
 * — once, at startup. So a first launch that signed in without restarting
 * browsed anonymously: artist pages failed with 401 and Liked Music did not
 * parse, while the library, which reads the account live, looked fine.
 * Signing out had the mirror problem, and a worse one: the catalogue went on
 * using the account's cookies.
 *
 * A restart makes all of it take the new account at once. It happens only
 * when the account changes — when nothing is playing, or when what was
 * playing belonged to the account being dropped — and the resume point is
 * saved every few seconds, so a restart loses at most that. The window reloads afterwards
 * because every page it had cached was fetched as the previous account.
 */
let restartingCore = false;

async function restartCore() {
  const old = core;
  if (old && old.exitCode === null) {
    restartingCore = true;
    // The replacement binds the same port, so the old one must be gone first.
    await stopChild(old);
    restartingCore = false;
  }
  if (shuttingDown) return;
  try {
    if (await probe(CORE_PORT, 400)) throw new Error(`Port ${CORE_PORT} is already in use. Stop the other Spotifier core or development server, then reopen the app.`);
    core = startCore();
    await core.ready;
  } catch (err) {
    await stopChild(core);
    dialog.showErrorBox("Could not restart the music service", err.message);
    throw err;
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
}

/** Single connection probe, used to detect a running dev server. */
function probe(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect(port, CORE_HOST);
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Single shutdown path.
 *
 * Called from window-all-closed, before-quit, SIGINT/SIGTERM and from an
 * uncaught exception, because a sidecar that outlives the app holds a port and
 * a live session.
 */
let shutdownPromise = null;
let shutdownComplete = false;
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = Promise.all([stopChild(core, 6000), auth.cancelSignIn()]);
  return shutdownPromise;
}

/* ---------- window ---------- */

/**
 * Where the UI bundle is: `{ url }` or `{ dir }`.
 *
 * Prefer the dev server when it is up so hot reload works, and fall back to
 * the built bundle otherwise — so `electron .` runs standalone. Packaged, the
 * bundle is copied next to main.js; in development it is the sibling ui/dist
 * produced by the build. The tray flyout is a second page of the same bundle.
 */
function uiSource() {
  const dist = app.isPackaged
    ? path.join(__dirname, "ui", "dist")
    : path.join(__dirname, "..", "ui", "dist");
  if (isDev && devServerUp) return { url: DEV_URL };
  if (fs.existsSync(path.join(dist, "index.html"))) return { dir: dist };
  return { url: DEV_URL };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    // The window and its taskbar button. The .exe carries the .ico for
    // Explorer; this is what the running window shows.
    icon: path.join(__dirname, "branding", "icon.png"),
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#0f0f0f",
    show: false,
    autoHideMenuBar: true,
    // The app draws its own title bar. The default Windows one is a light
    // strip above a dark app with a menu we do not use, and it cannot be
    // themed — so the frame goes and the controls move into the top bar,
    // where the rest of the chrome already lives.
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Audio must keep playing when the window is minimised. Without this
      // Chromium throttles background timers and playback stutters — the
      // single most common complaint about players built this way.
      backgroundThrottling: false,
    },
  });

  // Avoid a white flash before the dark UI paints.
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Windows can maximise the window without us: snap layouts, a drag to the
  // top edge, Win+Up. The restore icon has to follow those too, not just our
  // own button.
  const sendMaximized = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("window:maximized", mainWindow.isMaximized());
  };
  mainWindow.on("maximize", sendMaximized);
  mainWindow.on("unmaximize", sendMaximized);
  mainWindow.on("enter-full-screen", sendMaximized);
  mainWindow.on("leave-full-screen", sendMaximized);

  const source = uiSource();
  if (source.url) mainWindow.loadURL(source.url);
  else mainWindow.loadFile(path.join(source.dir, "index.html"));

  // The mini player is the one window the page may open; external links
  // belong in the user's browser, not in the app shell.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    const mini = miniplayer.openHandler(details);
    if (mini) return mini;
    shell.openExternal(details.url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-create-window", (child, { frameName }) => {
    if (frameName === miniplayer.FRAME) miniplayer.adopt(child);
  });

  // Closing hides to the tray rather than quitting, while that setting is on.
  tray.attach(mainWindow);

  // A renderer that dies or hangs takes the player with it, and leaves no
  // trace of its own; the shell is the only one left to write it down.
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[window] renderer gone: ${details.reason} (exit ${details.exitCode})`);
  });
  mainWindow.webContents.on("unresponsive", () => console.warn("[window] renderer unresponsive"));
  mainWindow.webContents.on("responsive", () => console.log("[window] renderer responsive again"));
  mainWindow.webContents.on("did-fail-load", (_e, code, description, url) => {
    console.error(`[window] failed to load ${url}: ${description} (${code})`);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/* ---------- media keys ---------- */

function registerMediaKeys() {
  // Chromium Media Session owns Mac media keys and Now Playing. Registering
  // global shortcuts as well can toggle playback twice and require access.
  if (process.platform === "darwin") return;
  const send = (action) => () => mainWindow?.webContents.send("media-key", action);
  const bindings = {
    MediaPlayPause: send("playpause"),
    MediaNextTrack: send("next"),
    MediaPreviousTrack: send("prev"),
    MediaStop: send("stop"),
  };
  for (const [key, handler] of Object.entries(bindings)) {
    // Another application may already own a key; that is not fatal.
    if (!globalShortcut.register(key, handler)) {
      console.warn(`[keys] could not register ${key}`);
    }
  }
}

function installMacMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]));
}

/* ---------- lifecycle ---------- */

// A second launch should focus the running window rather than starting a
// second core against the same port and database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // The window may be hidden in the tray rather than minimised, so this
  // shows it as well as restoring it.
  app.on("second-instance", () => tray.showWindow());

  app.whenReady().then(async () => {
    if (process.platform === "darwin") installMacMenu();
    if (await probe(CORE_PORT, 400)) {
      dialog.showErrorBox("Music service port is busy", `Port ${CORE_PORT} is already in use. Stop the other Spotifier core or development server, then reopen the app. Your saved sign-in is unchanged.`);
      app.quit();
      return;
    }
    auth.register(dataDir, () => mainWindow, CORE_PORT, restartCore);
    miniplayer.register(dataDir());

    // Re-read the owned session before launching the core. This is what makes
    // YouTube's cookie rotation a non-issue: the session is ours, so the
    // current values are always available to copy forward.
    try {
      const refreshed = await auth.refreshCredentials(dataDir());
      if (refreshed.ok) console.log(`[auth] refreshed ${refreshed.count} cookies from owned session`);
    } catch (err) {
      console.warn("[auth] refresh failed:", err.message);
    }

    if (shuttingDown) return;
    // A yt-dlp update staged last time goes live before the core starts.
    promoteYtdlpUpdate();
    core = startCore();
    // And the next one is looked for in the background, well clear of startup.
    setTimeout(() => void updateYtdlp(), 60_000).unref?.();
    await core.ready;
    devServerUp = isDev && (await probe(5219, 400));
    createWindow();
    tray.create(() => mainWindow, uiSource());
    registerMediaKeys();
    updater.start();

    app.on("activate", () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      tray.showWindow();
    });
  }).catch((err) => {
    console.error("[core] startup failed:", err.message);
    dialog.showErrorBox("Could not start the music service", err.message);
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  void shutdown().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  tray.destroy();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    app.quit();
  });
}

// Even on an unhandled crash the sidecar must not be left behind.
process.on("uncaughtException", (err) => {
  console.error("[main] uncaught:", err);
  app.quit();
});

ipcMain.handle("core-port", () => CORE_PORT);

/* ---------- window controls ---------- */

// Drawing our own title bar means owning what the frame used to do. Each of
// these is addressed to the window the request came from, so a second window
// could never minimise the first.
ipcMain.on("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on("window:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on("window:toggle-maximize", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle("window:is-maximized", (e) =>
  BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false,
);
ipcMain.handle("data-dir", () => dataDir());
// The version this copy is, and one downloaded and waiting to install.
ipcMain.handle("app:version", () => ({ version: app.getVersion(), update: updater.status() }));
ipcMain.handle("app:check-update", () => updater.checkNow());
ipcMain.on("app:install-update", () => updater.install());

/* ---------- diagnostics ---------- */

ipcMain.on("logs:write", (_e, entries) => logs.fromPage(entries));
ipcMain.handle("logs:export", (_e, page) =>
  logs.exportBundle({ dataDir: dataDir(), corePort: CORE_PORT, ytdlp: ytdlpPath(), page }),
);
ipcMain.on("logs:open-folder", () => logs.openFolder());
// From the mini player and the tray: bring the full window back.
ipcMain.on("window:show-main", () => tray.showWindow());
