/**
 * Page capture.
 *
 * Takes one screenshot per surface so the app can be looked at rather than
 * only asserted about. The feature sweep answers "does it work"; this is for
 * "does it look right", which no assertion has ever settled.
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
const OUT = path.join(__dirname, "..", "shots");
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

async function shot(name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  console.log("captured", name);
}

/**
 * Records a journey rather than a destination.
 *
 * A page shot shows the end state; a flow shows what the person saw on the
 * way, which is where the joins are — an empty moment before data arrives, a
 * panel that opens over the wrong thing, a step that gives no feedback. Those
 * are invisible in a single frame.
 */
async function flow(name, steps) {
  console.log("flow:", name);
  for (let i = 0; i < steps.length; i += 1) {
    const [label, run] = steps[i];
    await run();
    await shot(`flow-${name}-${String(i + 1).padStart(2, "0")}-${label}`);
  }
}

/** Clicks a selector with real input, so user activation is genuine. */
async function clickSel(sel, nth = 0) {
  const b = await js(
    `const els = [...document.querySelectorAll(${JSON.stringify(sel)})];` +
    `const el = els[${nth}];` +
    'if (!el) return null;' +
    'el.scrollIntoView({ block: "center" });' +
    'await new Promise((r) => setTimeout(r, 150));' +
    'const r = el.getBoundingClientRect();' +
    'if (r.width === 0) return null;' +
    'return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };'
  );
  if (!b || b.__error) return false;
  const p = { x: b.x, y: b.y, button: "left", clickCount: 1 };
  win.webContents.sendInputEvent({ type: "mouseMove", ...p });
  win.webContents.sendInputEvent({ type: "mouseDown", ...p });
  win.webContents.sendInputEvent({ type: "mouseUp", ...p });
  await wait(500);
  return true;
}

async function go(hash, name, settle = 3000) {
  await js(`location.hash = ${JSON.stringify(hash)};`);
  await wait(settle);
  await shot(name);
}

app.whenReady().then(async () => {
  ipcMain.handle("window:is-maximized", () => false);
  ipcMain.handle("core-port", () => PORT);
  ipcMain.on("window:minimize", () => {});
  ipcMain.on("window:close", () => {});
  ipcMain.on("window:toggle-maximize", () => {});

  fs.mkdirSync(OUT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spotifier-shots-"));
  const core = spawn(CORE, [
    "-addr", `127.0.0.1:${PORT}`,
    "-db", path.join(dir, "s.db"),
    "-credentials", path.join(process.env.APPDATA || os.homedir(), "Spotifier", "credentials.json"),
  ], { stdio: "ignore", windowsHide: true });
  await waitPort(PORT);

  win = new BrowserWindow({
    show: false, width: 1440, height: 900, frame: false, backgroundColor: "#0f0f0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  await win.loadFile(PAGE);
  await wait(5000);

  await shot("01-home");
  await go("#/search", "02-search-empty");

  // Search results need a query typed into the real field.
  await js(
    'const i = document.querySelector(".searchfield input");' +
    'const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;' +
    'set.call(i, "radiohead");' +
    'i.dispatchEvent(new Event("input", { bubbles: true }));'
  );
  await wait(2600);
  await shot("03-search-results");

  const ids = await js(
    'const out = {};' +
    'const r = await fetch("http://127.0.0.1:8674/v1/search?q=radiohead&filter=albums");' +
    'const a = await r.json();' +
    'for (const sh of (a.shelves || [])) for (const it of (sh.items || []))' +
    '  if (it.kind === "album" && !out.album) out.album = it.album.id;' +
    'const r2 = await fetch("http://127.0.0.1:8674/v1/search?q=radiohead&filter=artists");' +
    'const b = await r2.json();' +
    'for (const sh of (b.shelves || [])) for (const it of (sh.items || []))' +
    '  if (it.kind === "artist" && !out.artist) out.artist = it.artist.id;' +
    'return out;'
  );
  if (ids.album) await go(`#/album/${encodeURIComponent(ids.album)}`, "04-album", 3500);
  if (ids.artist) await go(`#/artist/${encodeURIComponent(ids.artist)}`, "05-artist", 3500);
  await go("#/playlist/LM", "06-playlist-liked", 4000);
  await go("#/stats", "07-your-listening");
  await go("#/settings", "08-settings");

  // Playing surfaces: start something first.
  await js('location.hash = "#/";');
  await wait(2500);
  const box = await js(
    'const c = document.querySelector("button.card");' +
    'if (!c) return null;' +
    'const r = c.getBoundingClientRect();' +
    'return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };'
  );
  if (box && !box.__error) {
    const at = { x: box.x, y: box.y, button: "left", clickCount: 1 };
    win.webContents.sendInputEvent({ type: "mouseMove", ...at });
    win.webContents.sendInputEvent({ type: "mouseDown", ...at });
    win.webContents.sendInputEvent({ type: "mouseUp", ...at });
    await wait(6000);
    await shot("09-playing-home");

    const click = async (sel) => {
      const b = await js(
        `const el = document.querySelector(${JSON.stringify(sel)});` +
        'if (!el) return null; const r = el.getBoundingClientRect();' +
        'return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };'
      );
      if (!b || b.__error) return false;
      const p = { x: b.x, y: b.y, button: "left", clickCount: 1 };
      win.webContents.sendInputEvent({ type: "mouseMove", ...p });
      win.webContents.sendInputEvent({ type: "mouseDown", ...p });
      win.webContents.sendInputEvent({ type: "mouseUp", ...p });
      await wait(1200);
      return true;
    };

    await click('.bar [aria-label="Lyrics"]');
    await wait(3000);
    await shot("10-lyrics-panel");
    await click('[aria-label="Expand lyrics"]');
    await wait(2500);
    await shot("11-lyrics-full");
    await click('[aria-label="Close lyrics"]');
    await wait(800);

    await click('.bar [aria-label="Queue"]');
    await wait(1200);
    await shot("12-queue");
    await click('[aria-label="Close queue"]');
    await wait(600);

    await click(".bar__artbtn");
    await wait(1500);
    await shot("13-now-playing");
  }

  /* ---------------- flows ---------------- */

  await flow("play-from-home", [
    ["home", async () => { await js('location.hash = "#/";'); await wait(2500); }],
    ["clicked-song", async () => { await clickSel("button.card"); await wait(1800); }],
    ["playing", async () => { await wait(4500); }],
  ]);

  await flow("search-to-album", [
    ["open-search", async () => { await clickSel('.sidebar a[href="#/search"]'); await wait(1200); }],
    ["typed", async () => {
      await js(
        'const i = document.querySelector(".searchfield input");' +
        'const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;' +
        'set.call(i, "daft punk");' +
        'i.dispatchEvent(new Event("input", { bubbles: true }));'
      );
      await wait(2600);
    }],
    ["opened-album", async () => { await clickSel("a[href*='album/']"); await wait(3200); }],
    ["played-track", async () => { await clickSel(".trackrow__play"); await wait(3500); }],
  ]);

  await flow("queue-and-menu", [
    ["queue-open", async () => { await clickSel('.bar [aria-label="Queue"]'); await wait(1400); }],
    ["queue-closed", async () => { await clickSel('[aria-label="Close queue"]'); await wait(900); }],
    ["context-menu", async () => {
      await js(
        'const row = document.querySelector(".trackrow");' +
        'if (!row) return false;' +
        'const r = row.getBoundingClientRect();' +
        'row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,' +
        '  clientX: Math.round(r.x + 60), clientY: Math.round(r.y + r.height / 2) }));' +
        'return true;'
      );
      await wait(800);
    }],
  ]);

  await flow("lyrics", [
    ["panel", async () => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await wait(400);
      await clickSel('.bar [aria-label="Lyrics"]');
      await wait(3500);
    }],
    ["expanded", async () => { await clickSel('[aria-label="Expand lyrics"]'); await wait(2500); }],
    ["following", async () => { await wait(7000); }],
  ]);

  await flow("full-screen", [
    ["closed-lyrics", async () => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await wait(900);
    }],
    ["opened", async () => { await clickSel(".bar__artbtn"); await wait(1800); }],
  ]);


  console.log("\nshots written to", OUT);
  win.destroy();
  core.kill();
  app.exit(0);
});
