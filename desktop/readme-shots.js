/**
 * README screenshots.
 *
 * Captures the packaged app into docs/screenshots/. Run after a build:
 *
 *   node build.js && npx electron readme-shots.js
 *
 * The README is public, so these are taken signed out, against a fresh
 * database: no account, library, history or avatar can end up in them. The
 * core runs on its own port, so a running copy of the app is left alone, and
 * the window is muted because a track plays for the now-playing shots.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");

const PKG = path.join(__dirname, "..", "dist-desktop", "Youtube Music Spotified-win32-x64");
const PAGE = path.join(PKG, "resources", "app", "ui", "dist", "index.html");
const CORE = path.join(PKG, "resources", "spotifier.exe");
const OUT = path.join(__dirname, "..", "docs", "screenshots");
// The app's core listens on 8674; this one runs beside it.
const APP_PORT = 8674;
const PORT = 8675;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function waitPort(p, timeout = 20000) {
  const deadline = Date.now() + timeout;
  return new Promise((res, rej) => {
    const go = () => {
      const s = net.connect(p, "127.0.0.1");
      s.once("connect", () => { s.destroy(); res(); });
      s.once("error", () => {
        s.destroy();
        Date.now() > deadline ? rej(new Error("core never listened")) : setTimeout(go, 200);
      });
    };
    go();
  });
}

let win;
const js = (expr) =>
  win.webContents
    .executeJavaScript(`(async () => { try { ${expr} } catch (e) { return { __error: String(e) }; } })()`)
    .catch((e) => ({ __error: String(e) }));

async function shot(name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.jpg`), img.toJPEG(88));
  console.log("captured", name);
}

/** Clicks the first match with real input, so user activation is genuine. */
async function click(sel) {
  const b = await js(
    `const el = document.querySelector(${JSON.stringify(sel)});` +
    "if (!el) return null;" +
    'el.scrollIntoView({ block: "center" });' +
    "await new Promise((r) => setTimeout(r, 150));" +
    "const r = el.getBoundingClientRect();" +
    "if (r.width === 0) return null;" +
    "return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };"
  );
  if (!b || b.__error) {
    console.warn("not found:", sel);
    return false;
  }
  const p = { x: b.x, y: b.y, button: "left", clickCount: 1 };
  win.webContents.sendInputEvent({ type: "mouseMove", ...p });
  win.webContents.sendInputEvent({ type: "mouseDown", ...p });
  win.webContents.sendInputEvent({ type: "mouseUp", ...p });
  await wait(1200);
  return true;
}

async function go(hash, settle = 3500) {
  await js(`location.hash = ${JSON.stringify(hash)};`);
  await wait(settle);
}

/** The first item of a kind in a search, for pages that need an id. */
async function firstId(query, filter, kind) {
  return js(
    `const r = await fetch(${JSON.stringify(`${ORIGIN}/v1/search?q=`)} + encodeURIComponent(${JSON.stringify(query)}) + "&filter=${filter}");` +
    "const a = await r.json();" +
    "for (const sh of (a.shelves || [])) for (const it of (sh.items || []))" +
    `  if (it.kind === ${JSON.stringify(kind)}) return it[${JSON.stringify(kind)}].id;` +
    "return null;"
  );
}

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yms-shots-"));
  ipcMain.handle("window:is-maximized", () => false);
  ipcMain.handle("core-port", () => PORT);
  ipcMain.handle("data-dir", () => dir);
  ipcMain.on("window:minimize", () => {});
  ipcMain.on("window:close", () => {});
  ipcMain.on("window:toggle-maximize", () => {});

  // Copies of the preload and the bundle with the core's origin, which both
  // pin (the bundle in its CSP), pointed at this core.
  const repoint = (from, to) =>
    fs.writeFileSync(to, fs.readFileSync(from, "utf8").replaceAll(`:${APP_PORT}`, `:${PORT}`));
  const preload = path.join(dir, "preload.js");
  repoint(path.join(__dirname, "preload.js"), preload);
  const ui = path.join(dir, "ui");
  fs.cpSync(path.dirname(PAGE), ui, { recursive: true });
  for (const f of fs.readdirSync(ui, { recursive: true })) {
    if (/\.(html|js)$/.test(f)) repoint(path.join(ui, f), path.join(ui, f));
  }

  fs.mkdirSync(OUT, { recursive: true });
  const core = spawn(CORE, [
    "-addr", `127.0.0.1:${PORT}`,
    "-db", path.join(dir, "s.db"),
    // Does not exist: the core runs signed out.
    "-credentials", path.join(dir, "credentials.json"),
    "-ytdlp", path.join(PKG, "resources", "yt-dlp", "yt-dlp.exe"),
  ], { stdio: "ignore", windowsHide: true });

  try {
    await waitPort(PORT);
    win = new BrowserWindow({
      show: false, width: 1440, height: 900, frame: false, backgroundColor: "#0f0f0f",
      webPreferences: {
        preload,
        sandbox: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    win.webContents.setAudioMuted(true);
    await win.loadFile(path.join(ui, "index.html"));
    await wait(6000);
    // No home page: signed out, it is whatever is trending in this region,
    // community playlists with strangers' photos on them included.

    const artist = await firstId("daft punk", "artists", "artist");
    if (artist && !artist.__error) {
      await go(`#/artist/${encodeURIComponent(artist)}`);
      await shot("artist");
    }

    const album = await firstId("random access memories", "albums", "album");
    if (album && !album.__error) {
      await go(`#/album/${encodeURIComponent(album)}`);
      // Play it, so the bar, lyrics and now playing have a track.
      await click(".playbtn--accent.playbtn--lg");
      await wait(8000);
      await shot("album");
    }

    if (await click('.bar [aria-label="Lyrics"]')) {
      await wait(2000);
      if (await click('[aria-label="Expand lyrics"]')) {
        await wait(6000);
        await shot("lyrics");
      }
      await click('[aria-label="Close lyrics"]');
    }

    if (await click('[aria-label="Open now playing"]')) {
      await wait(3000);
      await shot("now-playing");
    }

    console.log("\nwritten to", OUT);
  } finally {
    win?.destroy();
    core.kill();
    await wait(1000);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    app.exit(0);
  }
});
