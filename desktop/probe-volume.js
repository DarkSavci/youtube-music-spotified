/**
 * Does the volume slider change anything?
 *
 * Drives the real control and reads back both the session's volume and the
 * audio graph's gain, so "the thumb does not move", "the command never
 * arrives" and "the sound does not change" are three distinguishable answers.
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

app.whenReady().then(async () => {
  ipcMain.handle("window:is-maximized", () => false);
  ipcMain.handle("core-port", () => PORT);
  ipcMain.on("window:minimize", () => {});
  ipcMain.on("window:close", () => {});
  ipcMain.on("window:toggle-maximize", () => {});

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vol-"));
  const core = spawn(CORE, [
    "-addr", `127.0.0.1:${PORT}`,
    "-db", path.join(dir, "v.db"),
    "-credentials", path.join(process.env.APPDATA || os.homedir(), "Spotifier", "credentials.json"),
  ], { stdio: "ignore", windowsHide: true });
  await waitPort(PORT);

  win = new BrowserWindow({
    show: true, width: 1440, height: 900, frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  await win.loadFile(PAGE);
  await wait(5000);

  const started = await js([
    'const r = await fetch("http://127.0.0.1:8674/v1/search?q=radiohead%20creep&filter=songs");',
    'const res = await r.json();',
    'let t = null;',
    'for (const sh of (res.shelves || []))',
    '  for (const it of (sh.items || [])) if (it.kind === "track" && !t) t = it.track;',
    'if (!t) return { ok: false };',
    'const c = await fetch("http://127.0.0.1:8674/v1/session/command", {',
    '  method: "POST", headers: { "Content-Type": "application/json" },',
    '  body: JSON.stringify({ deviceId: localStorage.getItem("spotifier.deviceId"),',
    '    command: { Kind: "play", Tracks: [t], StartIndex: 0, Origin: "probe" } }) });',
    'return { ok: c.ok };',
  ].join("\n"));
  console.log("playing:", JSON.stringify(started));
  await wait(7000);

  const read = () => js([
    'const r = await fetch("http://127.0.0.1:8674/v1/session");',
    'const s = await r.json();',
    'const ranges = [...document.querySelectorAll(".bar input[type=range]")]',
    '  .map((i) => ({ label: i.getAttribute("aria-label"), value: i.value, disabled: i.disabled }));',
    'const audio = window.__audio ? window.__audio() : null;',
    'return { sessionVolume: s.state?.volume, targetVolume: s.target?.Volume, ranges, audio };',
  ].join("\n"));

  console.log("before:", JSON.stringify(await read()));

  const moved = await js([
    'const inputs = [...document.querySelectorAll(".bar input[type=range]")];',
    'const vol = inputs.find((i) => (i.getAttribute("aria-label") || "").toLowerCase().includes("volume"));',
    'if (!vol) return { ok: false, labels: inputs.map((i) => i.getAttribute("aria-label")) };',
    'const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;',
    'set.call(vol, "30");',
    'vol.dispatchEvent(new Event("input", { bubbles: true }));',
    'vol.dispatchEvent(new Event("change", { bubbles: true }));',
    'return { ok: true, nowShows: vol.value };',
  ].join("\n"));
  console.log("moved:", JSON.stringify(moved));

  await wait(2500);
  console.log("after: ", JSON.stringify(await read()));

  win.destroy();
  core.kill();
  app.exit(0);
});
