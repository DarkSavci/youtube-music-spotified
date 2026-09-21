/**
 * Finds controls that look interactive and do nothing.
 *
 * The feature sweep checks the transport bar only, which is how a "Create
 * playlist or folder" button sat in the sidebar with no handler. A control
 * with no handler is indistinguishable from a working one until pressed, so
 * the only way to find them is to ask the rendered tree.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");

const PKG = path.join(__dirname, "..", "dist-desktop", "Spotifier-win32-x64");
const PAGE = path.join(PKG, "resources", "app", "ui", "dist", "index.html");
const CORE = path.join(PKG, "resources", "spotifier.exe");
const PORT = 8674;
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

const SCAN = `
  const out = [];
  for (const b of document.querySelectorAll("button")) {
    if (b.disabled) continue;
    const keys = Object.keys(b);
    const pk = keys.find((k) => k.startsWith("__reactProps$"));
    const fk = keys.find((k) => k.startsWith("__reactFiber$"));
    const props = pk ? b[pk] : null;
    const fiber = fk ? b[fk] : null;
    if (!props && !fiber) continue;
    const handler = props?.onClick ?? fiber?.memoizedProps?.onClick;
    const submits = b.type === "submit";
    if (typeof handler !== "function" && !submits) {
      out.push((b.getAttribute("aria-label") || b.textContent || "(unlabelled)").trim().slice(0, 48));
    }
  }
  return out;
`;

app.whenReady().then(async () => {
  ipcMain.handle("window:is-maximized", () => false);
  ipcMain.handle("core-port", () => PORT);
  ipcMain.on("window:minimize", () => {});
  ipcMain.on("window:close", () => {});
  ipcMain.on("window:toggle-maximize", () => {});

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
  const core = spawn(CORE, [
    "-addr", `127.0.0.1:${PORT}`,
    "-db", path.join(dir, "s.db"),
    "-credentials", path.join(process.env.APPDATA || os.homedir(), "Spotifier", "credentials.json"),
  ], { stdio: "ignore", windowsHide: true });
  await waitPort(PORT);

  win = new BrowserWindow({
    show: false, width: 1440, height: 900, frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  await win.loadFile(PAGE);
  await wait(5000);

  const seen = new Map();
  const visit = async (hash, label, settle = 3000) => {
    await js(`location.hash = ${JSON.stringify(hash)};`);
    await wait(settle);
    const dead = await js(SCAN);
    if (Array.isArray(dead)) {
      for (const d of dead) {
        if (!seen.has(d)) seen.set(d, label);
      }
    }
  };

  await visit("#/", "home");
  await visit("#/search", "search");
  await visit("#/stats", "your listening");
  await visit("#/settings", "settings");
  await visit("#/playlist/LM", "playlist", 4000);

  const ids = await js(
    'const out = {};' +
    'const r = await fetch("http://127.0.0.1:8674/v1/search?q=radiohead&filter=artists");' +
    'const a = await r.json();' +
    'for (const sh of (a.shelves || [])) for (const it of (sh.items || []))' +
    '  if (it.kind === "artist" && !out.artist) out.artist = it.artist.id;' +
    'const r2 = await fetch("http://127.0.0.1:8674/v1/search?q=radiohead&filter=albums");' +
    'const b = await r2.json();' +
    'for (const sh of (b.shelves || [])) for (const it of (sh.items || []))' +
    '  if (it.kind === "album" && !out.album) out.album = it.album.id;' +
    'return out;'
  );
  if (ids.artist) await visit(`#/artist/${ids.artist}`, "artist", 3500);
  if (ids.album) await visit(`#/album/${ids.album}`, "album", 3500);

  console.log("\ncontrols with no click handler:");
  if (seen.size === 0) {
    console.log("  none");
  } else {
    for (const [label, where] of seen) console.log(`  ${label}  (first seen on ${where})`);
  }

  win.destroy();
  core.kill();
  app.exit(0);
});
