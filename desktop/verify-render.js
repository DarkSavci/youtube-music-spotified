/**
 * Render check.
 *
 * Starts the packaged core, loads the packaged page in a hidden window, and
 * reports whether React mounted, whether real data arrived, and what failed.
 *
 * This exists because HTTP checks against the core proved nothing about the
 * window: the packaged build once served every endpoint correctly while
 * rendering an empty page, because its asset paths did not resolve over
 * file://. Verifying the process is not verifying the product.
 *
 * It then caught the same class of bug a second time — the shell rendered but
 * every request went to file:///C:/v1/... — which is why it now runs the core
 * as well. A window that renders chrome and reaches nothing is still broken,
 * so an unreachable core fails the check rather than appearing as a footnote.
 *
 * The core runs against fixtures, so this needs no account and no network:
 * the check must be runnable on any machine, at any time, without credentials.
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

const consoleErrors = [];
const failedRequests = [];
let core = null;

function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`core never listened on ${port}`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function startCore() {
  if (!fs.existsSync(CORE)) throw new Error(`core binary missing at ${CORE}`);
  // A scratch database, so a verification run never touches real play history.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spotifier-verify-"));
  core = spawn(CORE, [
    "-addr", `127.0.0.1:${PORT}`,
    "-catalog", "fixture",
    "-fixtures", path.join(__dirname, "..", "testdata", "fixtures"),
    "-db", path.join(dir, "verify.db"),
    "-credentials", path.join(dir, "credentials.json"),
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  core.stderr.on("data", (b) => process.stderr.write(`[core] ${b}`));
  await waitForPort(PORT);
}

app.whenReady().then(async () => {
  // The real shell registers these. Stub them so the page under test sees the
  // same bridge it will see in production rather than a half-wired one.
  ipcMain.handle("window:is-maximized", () => false);
  ipcMain.handle("core-port", () => PORT);
  ipcMain.on("window:minimize", () => {});
  ipcMain.on("window:close", () => {});
  ipcMain.on("window:toggle-maximize", () => {});

  try {
    await startCore();
  } catch (err) {
    console.log(`core            : FAILED — ${err.message}`);
    app.exit(1);
    return;
  }
  console.log("core            : listening on", PORT, "(fixture catalog)");

  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    frame: false,
    backgroundColor: "#0f0f0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    failedRequests.push(`${desc} (${code}) ${url}`);
  });
  win.webContents.session.webRequest.onErrorOccurred((details) => {
    if (!details.url.startsWith("devtools:")) {
      failedRequests.push(`${details.error} ${details.url}`);
    }
  });

  await win.loadFile(PAGE);
  // Give React a moment to mount and the first queries to settle.
  await new Promise((r) => setTimeout(r, 4000));

  const result = await win.webContents.executeJavaScript(`
    (() => {
      const root = document.getElementById("root");
      const shell = document.querySelector(".app-shell");
      const q = (sel) => !!document.querySelector(sel);
      const text = (document.body.innerText || "").trim();
      return {
        rootChildren: root ? root.children.length : -1,
        hasShell: !!shell,
        hasSidebar: q(".sidebar"),
        hasTransportBar: q(".bar"),
        hasTopBar: q(".topbar"),
        shelves: document.querySelectorAll(".shelf").length,
        windowControls: document.querySelectorAll(".wincontrols__btn").length,
        cards: document.querySelectorAll(".card").length,
        libraryRows: document.querySelectorAll(".sidebar__item").length,
        /* The failure this check was built for looked fine until you read it. */
        unreachable: /Can't reach the player|Something went wrong/i.test(text),
        stylesApplied: shell ? getComputedStyle(document.body).backgroundColor : "(no shell)",
        fontApplied: getComputedStyle(document.body).fontFamily,
        visibleText: text.slice(0, 200),
      };
    })()
  `);

  const benign = /Electron Security Warning|Autofill\.|devtools/i;
  const realErrors = [...new Set(consoleErrors)].filter((e) => !benign.test(e));
  /*
   * Click a song card.
   *
   * Rendering is not working: every song on Home was a link to /track/:id, a
   * route that does not exist, so the page rendered perfectly and then took
   * the user to "not found" the moment they tried to play something. Only
   * interacting catches that.
   */
  const interaction = await win.webContents.executeJavaScript(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const cards = [...document.querySelectorAll(".card")];
      const trackCard = cards.find((c) => c.tagName === "BUTTON");
      if (!trackCard) {
        return { clicked: false, why: "no track card rendered as a play control" };
      }
      const title = trackCard.querySelector(".card__title")?.textContent ?? "";
      trackCard.click();
      await wait(2500);
      const body = (document.body.innerText || "");
      return {
        clicked: true,
        title,
        route: location.hash || location.pathname,
        notFound: /That page does not exist/i.test(body),
        /* The transport bar names the track once the session accepts it. */
        barText: (document.querySelector(".bar")?.innerText || "").trim().slice(0, 120),
      };
    })()
  `);

  const apiFailures = [...new Set(failedRequests)].filter((f) => f.includes("/v1/"));
  const assetFailures = [...new Set(failedRequests)].filter((f) => !f.includes("/v1/"));

  const ok =
    result.rootChildren > 0 &&
    result.hasShell &&
    result.hasSidebar &&
    result.hasTransportBar &&
    !result.unreachable &&
    apiFailures.length === 0 &&
    // A page that renders and then throws is not a working page. This caught
    // an unhandled rejection from the title-bar controls on its first run.
    realErrors.length === 0 &&
    // Chrome without content is the exact half-working state this check exists
    // to reject, so real rendered data is part of passing.
    result.shelves > 0 &&
    result.windowControls === 3 &&
    // Playing a song must not navigate anywhere, least of all to not-found.
    interaction.clicked &&
    !interaction.notFound;

  console.log("root children   :", result.rootChildren);
  console.log("app shell       :", result.hasShell);
  console.log("sidebar         :", result.hasSidebar, `(${result.libraryRows} library rows)`);
  console.log("transport bar   :", result.hasTransportBar);
  console.log("top bar         :", result.hasTopBar);
  console.log("content         :", result.shelves, "shelves,", result.cards, "cards");
  console.log("window controls :", result.windowControls, "(minimize/maximize/close)");
  console.log("clicked a song  :", interaction.clicked ? JSON.stringify(interaction.title) : `NO — ${interaction.why}`);
  if (interaction.clicked) {
    console.log("  not-found page:", interaction.notFound);
    console.log("  transport bar :", JSON.stringify(interaction.barText));
  }
  console.log("reached core    :", !result.unreachable);
  console.log("body background :", result.stylesApplied);
  console.log("font            :", result.fontApplied);
  console.log("visible text    :", JSON.stringify(result.visibleText));
  if (apiFailures.length) {
    console.log("FAILED API CALLS:");
    for (const f of apiFailures.slice(0, 8)) console.log("   ", f);
  }
  if (assetFailures.length) {
    console.log("other failures  :");
    for (const f of assetFailures.slice(0, 6)) console.log("   ", f);
  }
  if (realErrors.length) {
    console.log("CONSOLE ERRORS  :");
    for (const e of realErrors.slice(0, 6)) console.log("   ", e);
  }
  console.log(ok ? "\nRENDER OK" : "\nRENDER FAILED");

  // A screenshot, so the window can be looked at rather than only asserted
  // about. The failure that started all of this was invisible to assertions.
  try {
    const shot = await win.webContents.capturePage();
    const out = path.join(__dirname, "..", "render-check.png");
    fs.writeFileSync(out, shot.toPNG());
    console.log("screenshot      :", out);
  } catch (err) {
    console.log("screenshot      : failed —", err.message);
  }

  win.destroy();
  core?.kill();
  app.exit(ok ? 0 : 1);
});
