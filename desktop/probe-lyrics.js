/**
 * Does the lyrics view follow the song?
 *
 * Distinguishes two very different failures that look identical on screen:
 * the track having no timed lyrics at all, and timed lyrics that are present
 * but never advance. The first is missing data, the second is a bug.
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyr-"));
  const core = spawn(CORE, [
    "-addr", `127.0.0.1:${PORT}`,
    "-db", path.join(dir, "l.db"),
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

  // A track that definitely has timed lyrics, so missing data cannot be
  // mistaken for a stuck highlight.
  const VIDEO = "9RfVp-GhKfs"; // Radiohead — Creep
  const started = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/search?q=radiohead%20creep&filter=songs");' +
    'const res = await r.json();' +
    'let t = null;' +
    'for (const sh of (res.shelves || []))' +
    '  for (const it of (sh.items || []))' +
    '    if (it.kind === "track" && !t) t = it.track;' +
    'if (!t) return { ok: false };' +
    'const reg = await fetch("http://127.0.0.1:8674/v1/session/command", {' +
    '  method: "POST", headers: { "Content-Type": "application/json" },' +
    '  body: JSON.stringify({ deviceId: localStorage.getItem("spotifier.deviceId"),' +
    '    command: { Kind: "play", Tracks: [t], StartIndex: 0, Origin: "probe" } }) });' +
    'return { ok: reg.ok, title: t.title, id: t.id };'
  );
  console.log("playing:", JSON.stringify(started));
  await wait(7000);

  // The API's own answer, so the UI and the data can be compared.
  const api = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/tracks/' + VIDEO +
    '/lyrics?title=Creep&artist=Radiohead&durationMs=239000&timed=1");' +
    'if (!r.ok) return { status: r.status };' +
    'const d = await r.json();' +
    'return { synced: d.synced, lines: (d.lines || []).length, source: d.source };'
  );
  console.log("api lyrics:", JSON.stringify(api));

  // Open the panel.
  const b = await js(
    'const el = document.querySelector(\'.bar [aria-label="Lyrics"]\');' +
    'if (!el) return null; const r = el.getBoundingClientRect();' +
    'return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };'
  );
  if (b && !b.__error) {
    const at = { x: b.x, y: b.y, button: "left", clickCount: 1 };
    win.webContents.sendInputEvent({ type: "mouseMove", ...at });
    win.webContents.sendInputEvent({ type: "mouseDown", ...at });
    win.webContents.sendInputEvent({ type: "mouseUp", ...at });
  }
  await wait(4000);

  const sample = () => js(
    'const active = document.querySelector(\'li[data-state="active"] .lyrics__line\');' +
    'const all = document.querySelectorAll(".lyrics__line").length;' +
    'const plain = !!document.querySelector(".lyrics--plain");' +
    'const sr = await fetch("http://127.0.0.1:8674/v1/session");' +
    'const st = (await sr.json()).state;' +
    'return { active: active ? active.textContent.slice(0, 40) : null,' +
    '         lines: all, plain, serverMs: st?.positionMs, state: st?.state };'
  );

  // Seek past the intro, or "no active line" is simply correct: the song
  // starts well before the words do.
  await js(
    'await fetch("http://127.0.0.1:8674/v1/session/command", {' +
    '  method: "POST", headers: { "Content-Type": "application/json" },' +
    '  body: JSON.stringify({ deviceId: localStorage.getItem("spotifier.deviceId"),' +
    '    command: { Kind: "seek", PositionMs: 45000 } }) });'
  );
  await wait(5000);

  console.log("\\nsampling the active line every 3s:");
  for (let i = 0; i < 5; i += 1) {
    const s = await sample();
    console.log(`  t+${i * 3}s  lines=${s.lines} plain=${s.plain} server=${Math.round((s.serverMs ?? 0) / 1000)}s active=${JSON.stringify(s.active)}`);
    await wait(3000);
  }

  win.destroy();
  core.kill();
  app.exit(0);
});
