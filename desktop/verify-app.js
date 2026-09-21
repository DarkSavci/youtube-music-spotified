/**
 * Feature sweep.
 *
 * Drives the packaged app through every surface and reports what works. This
 * is the harness for "does the product do what it claims", where
 * verify-render.js only answers "did the window come up".
 *
 * Two deliberate choices:
 *
 * Real credentials and the real catalog, because the identity surfaces — the
 * merged library, liked songs, history, statistics — are exactly the ones a
 * fixture run cannot exercise, and they are half the reason this app exists.
 * The play log goes to a scratch database so a sweep never edits real history.
 *
 * Real input events rather than element.click(), because Chromium only grants
 * user activation to trusted input. A synthetic click cannot start audio, so a
 * harness built on one would report playback broken on a working app — and,
 * the first time this ran, hid a genuine bug behind that false alarm.
 */
const { app, BrowserWindow, ipcMain, clipboard } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");

const PKG = path.join(__dirname, "..", "dist-desktop", "Youtube Music Spotified-win32-x64");
const PAGE = path.join(PKG, "resources", "app", "ui", "dist", "index.html");
const CORE = path.join(PKG, "resources", "spotifier.exe");
const PORT = 8674;
const REAL_CREDENTIALS = path.join(
  process.env.APPDATA || os.homedir(),
  "Spotifier",
  "credentials.json",
);

const results = [];
let throttled = false;
const consoleErrors = [];
const failedRequests = [];
let win = null;
let core = null;

function record(feature, ok, detail) {
  results.push({ feature, ok, detail: detail ?? "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${feature}${detail ? ` — ${detail}` : ""}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForPort(port, timeoutMs = 20000) {
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

// The scratch directory the core keeps its database and cache in, so a
// restart can come back to the same state.
let coreDir = null;

async function stopCore() {
  if (!core) return;
  try {
    require("node:child_process").execFileSync("taskkill", ["/F", "/PID", String(core.pid)], { stdio: "ignore" });
  } catch {
    core.kill();
  }
  // Until nothing answers on the port.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const open = await new Promise((res) => {
      const sock = net.connect(PORT, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); res(true); });
      sock.once("error", () => { sock.destroy(); res(false); });
    });
    if (!open) return;
    await wait(200);
  }
}

async function startCore(reuse = false) {
  if (!fs.existsSync(CORE)) throw new Error(`core binary missing at ${CORE}`);
  const dir = reuse && coreDir ? coreDir : fs.mkdtempSync(path.join(os.tmpdir(), "spotifier-sweep-"));
  coreDir = dir;
  // A scratch song cache too: a sweep must not fill, or read from, the real one.
  const args = ["-addr", `127.0.0.1:${PORT}`, "-db", path.join(dir, "sweep.db"), "-cache", path.join(dir, "audio-cache")];
  // The yt-dlp the app ships, as the app passes it — not whatever is on PATH.
  const ytdlp = path.join(PKG, "resources", "yt-dlp", "yt-dlp.exe");
  if (fs.existsSync(ytdlp)) args.push("-ytdlp", ytdlp);
  if (fs.existsSync(REAL_CREDENTIALS)) {
    args.push("-credentials", REAL_CREDENTIALS);
  } else {
    args.push("-credentials", path.join(dir, "none.json"));
  }
  core = spawn(CORE, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  core.stderr.on("data", (b) => {
    const line = String(b);
    if (/level=ERROR/.test(line)) process.stderr.write(`[core] ${line}`);
  });
  await waitForPort(PORT);
}

/**
 * Runs an expression in the page and returns its value.
 *
 * Wrapped so a rejected fetch inside the page cannot hang the whole run: a
 * harness that stops reporting at the first network hiccup tells you less
 * than one that records the hiccup and keeps going.
 */
function js(expr) {
  return win.webContents
    .executeJavaScript(`(async () => { try { ${expr} } catch (e) { return { __error: String(e) }; } })()`)
    .catch((e) => ({ __error: String(e) }));
}

/**
 * Clicks an element the way a person does.
 *
 * Chromium grants user activation only to trusted input, and audio playback
 * depends on having it, so the coordinates are read from the page and the
 * events are sent through the browser rather than dispatched in it.
 */
async function click(selector, nth = 0) {
  const box = await js(`
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = els[${nth}];
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    await new Promise((r) => setTimeout(r, 120));
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  `);
  if (!box) return false;
  // Synthetic input reaches the focused window, so a window that has lost
  // focus swallows the click and the check fails for a reason that has
  // nothing to do with the app.
  win.focus();
  const at = { x: box.x, y: box.y, button: "left", clickCount: 1 };
  win.webContents.sendInputEvent({ type: "mouseMove", ...at });
  win.webContents.sendInputEvent({ type: "mouseDown", ...at });
  win.webContents.sendInputEvent({ type: "mouseUp", ...at });
  await wait(400);
  return true;
}

async function typeText(selector, text) {
  const ok = await click(selector);
  if (!ok) return false;
  // Clear first: this used to append to whatever was already there, so a
  // second search in one run produced a query nobody would ever type.
  await js(
    `const i = document.querySelector(${JSON.stringify(selector)});` +
    'if (!i) return;' +
    'const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;' +
    'set.call(i, "");' +
    'i.dispatchEvent(new Event("input", { bubbles: true }));'
  );
  await wait(300);
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: "char", keyCode: ch });
    await wait(45);
  }
  await wait(900);
  return true;
}

const text = () => js(`return (document.body.innerText || "").trim();`);
const count = (sel) => js(`return document.querySelectorAll(${JSON.stringify(sel)}).length;`);
const route = () => js(`return location.hash || location.pathname;`);
const notFound = async () => /That page does not exist/i.test(await text());

async function goHome() {
  await click('.sidebar__nav a[href="#/"], .sidebar a[href="#/"]');
  await wait(600);
}

/* ---------------- the sweep ---------------- */

async function sweepShell() {
  record("shell renders", (await count(".app-shell")) === 1);
  record("sidebar", (await count(".sidebar")) === 1);
  record("transport bar", (await count(".bar")) === 1);
  record("window controls", (await count(".wincontrols__btn")) === 3);
}

async function sweepAccount() {
  const me = await js(`
    const r = await fetch("http://127.0.0.1:${PORT}/v1/me");
    return r.json();
  `);
  record(
    "signed in",
    me.state === "signed_in",
    me.state === "signed_in" ? me.account?.name : `state=${me.state}`,
  );
  return me.state === "signed_in";
}

async function sweepHome() {
  await goHome();
  const shelves = await count(".shelf");
  const cards = await count(".card");
  record("home shelves", shelves > 0, `${shelves} shelves, ${cards} cards`);

  const trackCards = await count("button.card");
  record("song cards are play controls", trackCards > 0, `${trackCards} playable cards`);
}

/**
 * Is upstream refusing everything right now?
 *
 * googlevideo rate-limits an address that has made a lot of requests, and in
 * that state every stream returns 403 no matter what the app does. Reporting
 * that as broken playback would be a lie the next reader has to re-debug, so
 * it is called out as its own condition.
 */
async function upstreamThrottled() {
  const res = await js(`
    const r = await fetch("http://127.0.0.1:${PORT}/v1/home");
    const page = await r.json();
    for (const sh of (page.shelves || [])) {
      for (const it of (sh.items || [])) {
        if (it.kind === "track" && it.track?.id) {
          const probe = await fetch("http://127.0.0.1:${PORT}/v1/resolve/" + it.track.id);
          return { status: probe.status, id: it.track.id };
        }
      }
    }
    return { status: 0, id: "" };
  `);
  // 429 is the core saying so outright; 403 is upstream refusing the bytes.
  // A failed probe is inconclusive, not a throttle.
  if (!res || res.__error) return false;
  return res.status === 429 || res.status === 403;
}

async function sweepPlayback() {
  if (await upstreamThrottled()) {
    record("play a song", false, "SKIPPED — YouTube is rate-limiting this address");
    throttled = true;
    return;
  }
  await goHome();
  const clicked = await click("button.card");
  if (!clicked) return record("play a song", false, "no song card to click");

  await wait(5000);
  const state = await js(`
    const r = await fetch("http://127.0.0.1:${PORT}/v1/session");
    const s = await r.json();
    const q = s.state?.queue ?? {};
    const items = q.items ?? [];
    return { state: s.state?.state, id: items[q.index]?.id, title: items[q.index]?.title,
             len: items.length, degraded: (s.state?.degraded || []).length,
             reasons: (s.state?.degraded || []).map((d) => d.reason).join(", ") };
  `);
  record("play a song", state.state === "playing", `${state.state}: ${state.title ?? "(none)"}`);
  record("queue has context", (state.len ?? 0) > 1, `${state.len} tracks queued`);
  record("no tracks faulted on play", (state.degraded ?? 0) === 0,
    `${state.degraded} faults${state.reasons ? `: ${state.reasons}` : ""}`);
  record("did not navigate away", !(await notFound()));

  const bar = await js(`return (document.querySelector(".bar")?.innerText || "").trim();`);
  record("now-playing bar shows the track", bar.length > 0 && !/Nothing playing/.test(bar),
    JSON.stringify(bar.split("\\n")[0] ?? ""));

  // Transport controls, each read back from the authoritative session.
  const snap = async () => js(`
    const r = await fetch("http://127.0.0.1:${PORT}/v1/session");
    const s = await r.json();
    return { state: s.state?.state, index: s.state?.queue?.index,
             shuffle: s.state?.shuffle, repeat: s.state?.repeat, volume: s.state?.volume };
  `);

  /*
   * Wait for the state to settle rather than for a fixed moment.
   *
   * A command goes to the core and comes back as a projection, and how long
   * that round trip takes depends on what else the machine is doing —
   * resolving a track in the background, most often. A fixed 900ms failed
   * intermittently reporting "playing -> playing", which reads like a lost
   * click and was really an answer that had not arrived yet.
   */
  const settles = async (want, ms = 6000) => {
    const deadline = Date.now() + ms;
    let last = await snap();
    while (last.state !== want && Date.now() < deadline) {
      await wait(250);
      last = await snap();
    }
    return last;
  };

  const before = await snap();
  await click('.bar [aria-label="Pause"], .bar [aria-label="Play"]');
  const paused = await settles("paused");
  record("pause", paused.state === "paused", `${before.state} -> ${paused.state}`);

  await click('.bar [aria-label="Play"], .bar [aria-label="Pause"]');
  const resumed = await settles("playing");
  record("resume", resumed.state === "playing", `-> ${resumed.state}`);

  await click('.bar [aria-label="Next track"]');
  await wait(1500);
  const next = await snap();
  record("next", next.index === before.index + 1, `index ${before.index} -> ${next.index}`);

  await click('.bar [aria-label="Previous track"]');
  await wait(1500);
  record("previous", (await snap()).index === before.index);

  await click('.bar [aria-label*="Shuffle" i]');
  await wait(700);
  record("shuffle toggles", (await snap()).shuffle === !before.shuffle);
  await click('.bar [aria-label*="Shuffle" i]');

  await click('.bar [aria-label*="Repeat" i]');
  await wait(700);
  record("repeat toggles", (await snap()).repeat !== before.repeat);
  // Leave it off, so the checks after this are not quietly on repeat.
  await command({ Kind: "set_repeat", Repeat: "off" });
}

/**
 * Seeking.
 *
 * Scrubbing is the one transport control that changes where bytes come from
 * rather than only whether they flow, so it exercises the relay's range
 * handling as well as the session. It is driven through the real slider —
 * React's controlled input needs the native value setter — so the whole path
 * from the thumb to the audio element is under test.
 */
async function sweepSeek() {
  if (throttled) return;

  const before = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/session");' +
    'const st = (await r.json()).state;' +
    'const items = st?.queue?.items ?? [];' +
    'return { state: st?.state, positionMs: st?.positionMs,' +
    '         durationMs: items[st?.queue?.index]?.durationMs ?? 0 };'
  );
  if (before.state !== "playing") {
    return record("seek", false, "not playing before the seek (" + before.state + ")");
  }

  // Far enough in that it cannot be mistaken for drift, and past the first
  // window the relay fetches.
  const targetMs = Math.max(60000, Math.floor(before.durationMs * 0.6));

  const moveTo = async (ms) => js(
    'const input = document.querySelector(".bar__progress input[type=range]");' +
    'if (!input) return false;' +
    'const setter = Object.getOwnPropertyDescriptor(' +
    '  window.HTMLInputElement.prototype, "value").set;' +
    'setter.call(input, String(' + ms + '));' +
    'input.dispatchEvent(new Event("input", { bubbles: true }));' +
    'input.dispatchEvent(new Event("change", { bubbles: true }));' +
    'return true;'
  );

  const snap = async () => js(
    'const r = await fetch("http://127.0.0.1:8674/v1/session");' +
    'const st = (await r.json()).state;' +
    'const audio = document.querySelector("audio");' +
    'return { state: st?.state, positionMs: st?.positionMs ?? 0,' +
    '         degraded: (st?.degraded || []).length,' +
    '         audioTime: audio ? Math.round(audio.currentTime * 1000) : -1,' +
    '         paused: audio ? audio.paused : null };'
  );

  if (!(await moveTo(targetMs))) {
    return record("seek", false, "no seek slider in the transport bar");
  }

  await wait(1500);
  const at = await snap();
  record("seek moves the position", Math.abs(at.positionMs - targetMs) < 6000,
    "asked " + Math.round(targetMs / 1000) + "s, session says " +
    Math.round(at.positionMs / 1000) + "s");

  /*
   * The part that matters: does it keep playing from there?
   *
   * Sampled twice, because a frozen position and a moving one look identical
   * in a single reading — and "it breaks when I go to a different time" is
   * exactly the difference between the two.
   */
  await wait(4500);
  const after = await snap();

  record("still playing after a seek", after.state === "playing", after.state);
  record("position advances after a seek", after.positionMs > at.positionMs,
    Math.round(at.positionMs / 1000) + "s -> " + Math.round(after.positionMs / 1000) + "s");
  record("seek did not jump back", after.positionMs > targetMs - 10000,
    "at " + Math.round(after.positionMs / 1000) + "s, asked " +
    Math.round(targetMs / 1000) + "s");
  record("seek faulted nothing", after.degraded === 0, after.degraded + " faults");

  // Backwards uses a range the relay has already served, which is where a
  // cached resolution can be stale.
  await moveTo(10000);
  await wait(4500);
  const back = await snap();
  record("seek backwards works", back.state === "playing" && back.positionMs > 10000,
    back.state + " at " + Math.round(back.positionMs / 1000) + "s");
  record("seek backwards faulted nothing", back.degraded === 0, back.degraded + " faults");
}

async function sweepSearch() {
  await click('.sidebar a[href="#/search"]');
  await wait(600);
  const typed = await typeText(".searchfield input", "radiohead");
  if (!typed) return record("search", false, "no search field");
  await wait(1800);
  const body = await text();
  const rows = (await count(".trackrow")) + (await count(".card"));
  record("search returns results", rows > 0, `${rows} results`);
  record("search did not error", !/Something went wrong|does not exist/i.test(body));
}

async function sweepEntity(kind, selector, label) {
  await goHome();
  const ok = await click(selector);
  if (!ok) return record(`${label} page`, false, "no card to open");
  await wait(2200);
  if (await notFound()) return record(`${label} page`, false, "landed on not-found");
  const header = await count(".entityheader");
  const rows = await count(".trackrow");
  record(`${label} page`, header > 0, `${rows} tracks`);
  return true;
}

/**
 * Open an album page.
 *
 * The album is found through the search API rather than by hunting for a card
 * to click: which cards a search renders varies with what YouTube returns that
 * day, and a harness that fails when the layout shifts reports on itself
 * instead of on the app. The navigation and the page are still exercised.
 */
/** Reaches an artist through search, so a shifting Home cannot fail the check. */
async function sweepArtistViaSearch() {
  const found = await js(
    'for (const q of ["radiohead", "daft punk", "coldplay"]) {' +
    '  const r = await fetch("http://127.0.0.1:8674/v1/search?q=" + encodeURIComponent(q) + "&filter=artists");' +
    '  if (!r.ok) continue;' +
    '  const res = await r.json();' +
    '  for (const sh of (res.shelves || [])) {' +
    '    for (const it of (sh.items || [])) {' +
    '      if (it.kind === "artist" && it.artist?.id) return { id: it.artist.id, name: it.artist.name };' +
    '    }' +
    '  }' +
    '}' +
    'return null;'
  );
  if (!found || found.__error) return record("artist page", false, "search returned no artist");

  await js('location.hash = "#/artist/" + encodeURIComponent(' + JSON.stringify("") + ' + ' +
           JSON.stringify(found.id) + ');');
  await wait(2600);
  if (await notFound()) return record("artist page", false, "landed on not-found");
  const rows = await count(".trackrow");
  record("artist page", (await count(".entityheader")) > 0, found.name + ": " + rows + " tracks");
}

/**
 * Open a playlist page.
 *
 * Liked Music is always present and always a playlist, so this does not depend
 * on what Home happens to show today — a harness that fails when the shelves
 * shift is reporting on itself.
 */
async function sweepPlaylistDirect() {
  await js('location.hash = "#/playlist/LM";');
  await wait(3500);
  if (await notFound()) return record("playlist page", false, "landed on not-found");
  const rows = await count(".trackrow");
  record("playlist page", (await count(".entityheader")) > 0 && rows > 0, rows + " tracks");
}


async function sweepAlbumViaSearch() {
  const found = await js(`
    for (const q of ["in rainbows", "random access memories", "ok computer"]) {
      const r = await fetch("http://127.0.0.1:${PORT}/v1/search?q=" + encodeURIComponent(q) + "&filter=albums");
      if (!r.ok) continue;
      const res = await r.json();
      for (const sh of (res.shelves || [])) {
        for (const it of (sh.items || [])) {
          if (it.kind === "album" && it.album?.id) return { id: it.album.id, title: it.album.title };
        }
      }
    }
    return null;
  `);
  if (!found) return record("album page", false, "search returned no album on any query");

  await js(`location.hash = "#/album/" + encodeURIComponent(${JSON.stringify(found.id)});`);
  await wait(2600);
  if (await notFound()) return record("album page", false, "landed on not-found");
  const rows = await count(".trackrow");
  record("album page", (await count(".entityheader")) > 0, `${found.title}: ${rows} tracks`);
}

/**
 * A filtered search returns the kind it was asked for, and clicking a result
 * opens that kind's page.
 *
 * Searching for an album opened the artist instead. Two things had to be true
 * at once: an album row carries a play button, so it looked like a track, and
 * it links its artist in the subtitle, so the fallback could read the artist's
 * identifier instead of the album's — non-deterministically, because the
 * search that found it walks a Go map.
 *
 * Checking the identifier's prefix and not just the kind is what makes this
 * catch the second half: an album carrying a UC identifier is still wrong.
 */
async function sweepSearchFilters() {
  const expected = {
    albums: { kind: "album", prefixes: ["MPRE", "OLAK"] },
    artists: { kind: "artist", prefixes: ["UC"] },
    playlists: { kind: "playlist", prefixes: ["PL", "RD", "OLAK", "VL"] },
    songs: { kind: "track", prefixes: [] },
  };

  for (const [filter, want] of Object.entries(expected)) {
    const seen = await js(`
      const r = await fetch("http://127.0.0.1:${PORT}/v1/search?q=" +
        encodeURIComponent("mor ve otesi") + "&filter=${filter}");
      if (!r.ok) return { __error: "HTTP " + r.status };
      const res = await r.json();
      const out = [];
      for (const sh of (res.shelves || []))
        for (const it of (sh.items || []))
          out.push({ kind: it.kind, id: it[it.kind]?.id || "" });
      return out;
    `);
    if (!Array.isArray(seen) || seen.length === 0) {
      record(`search filter: ${filter}`, false, seen?.__error || "no results");
      continue;
    }
    const wrongKind = seen.filter((it) => it.kind !== want.kind);
    const wrongID = want.prefixes.length === 0 ? [] :
      seen.filter((it) => !want.prefixes.some((p) => it.id.startsWith(p)));
    record(`search filter: ${filter}`,
      wrongKind.length === 0 && wrongID.length === 0,
      wrongKind.length ? `${wrongKind.length}/${seen.length} came back as ${wrongKind[0].kind}`
        : wrongID.length ? `id ${wrongID[0].id} is not a ${want.kind}`
        : `${seen.length} ${want.kind}s`);
  }

  // The click-through, which is how the bug was actually seen: the album card
  // navigated to the artist and the page drew an artist header.
  await js('location.hash = "#/search?q=" + encodeURIComponent("mor ve otesi") + "&filter=albums";');
  await wait(3000);
  const opened = await click(".card, .searchrow, .trackrow");
  if (!opened) return record("album from search opens the album", false, "no result to click");
  await wait(3000);

  const where = await route();
  // The header's own label is the evidence: the screenshot that reported this
  // showed an album's route would have been fine, it was the word "ARTIST"
  // above the title that was wrong.
  const header = await js(`
    const h = document.querySelector(".entityheader");
    return { label: (h?.querySelector(".entityheader__kind")?.textContent || "").trim(),
             title: (h?.querySelector(".entityheader__title")?.textContent || "").trim() };
  `);
  const isAlbum = /#\/album\//.test(where || "") && /album/i.test(header?.label || "");
  record("album from search opens the album", isAlbum,
    `${where} showing ${header?.label || "no header"} ${header?.title || ""}`.trim());
}

/**
 * Volume normalisation is replay gain, not levelling.
 *
 * This was recorded in the audit as impossible — "YouTube publishes no
 * per-track loudness" — and the app measured as it played to compensate. The
 * figure is in every player response. The check is in two halves because both
 * can fail separately: the core has to report it, and the graph has to apply
 * it before the track starts.
 */
async function sweepNormalization() {
  if (throttled) {
    return record("replay gain reaches the audio graph", false,
      "SKIPPED — YouTube is rate-limiting this address");
  }
  const reported = await js(`
    const s = await fetch("http://127.0.0.1:${PORT}/v1/search?q=" +
      encodeURIComponent("daft punk") + "&filter=songs");
    if (!s.ok) return { __error: "search HTTP " + s.status };
    const res = await s.json();
    let id = null;
    for (const sh of (res.shelves || []))
      for (const it of (sh.items || [])) if (it.kind === "track") { id = it.track.id; break; }
    if (!id) return { __error: "no track to resolve" };
    const r = await fetch("http://127.0.0.1:${PORT}/v1/resolve/" + encodeURIComponent(id));
    if (!r.ok) return { __error: "resolve HTTP " + r.status };
    const body = await r.json();
    return { id, lkfs: body.loudnessLkfs };
  `);

  // Music sits well below full scale and well above the noise floor; a figure
  // outside this is a parse error wearing a number's clothes.
  const lkfs = reported?.lkfs;
  record("the core reports per-track loudness",
    typeof lkfs === "number" && lkfs < 0 && lkfs > -40,
    typeof lkfs === "number" ? lkfs.toFixed(2) + " LKFS" : (reported?.__error || "absent"));

  // Turn normalisation on, play something, and look at the deck's own gain.
  await js('location.hash = "#/settings";');
  await wait(1500);
  const toggled = await js(
    `const sw = [...document.querySelectorAll('button[role="switch"]')]` +
    '  .find((b) => /volume normalization/i.test(b.getAttribute("aria-label") || ""));' +
    'if (!sw) return false;' +
    'if (sw.getAttribute("aria-checked") !== "true") sw.click();' +
    'return true;'
  );
  if (!toggled || toggled.__error) {
    return record("replay gain reaches the audio graph", false, "no normalization switch");
  }
  await wait(900);

  // Spotify's three levels: the control only exists once normalisation is on.
  const levels = await js(
    `const sel = document.querySelector('select[aria-label="Volume level"]');` +
    'if (!sel) return null;' +
    'return [...sel.options].map((o) => o.value);'
  );
  record("normalisation offers the three levels",
    Array.isArray(levels) && ["quiet", "normal", "loud"].every((l) => levels.includes(l)),
    Array.isArray(levels) ? levels.join("/") : "no level control");

  await goHome();
  /*
   * `button.card` is the song card, which plays.
   *
   * A bare `.card` also matches the album and playlist cards, which are links
   * — clicking one navigated instead of playing, and the check then reported
   * a broken audio graph when nothing had been asked to make a sound.
   */
  if (!(await click("button.card"))) {
    return record("replay gain reaches the audio graph", false, "no song card to play");
  }
  await wait(7000);

  /*
   * A deck has to be holding a track before its gain means anything.
   *
   * Without this the check read "1.000 / 1.000" and called normalisation
   * broken, when the truth was that the click had not started anything and
   * an unrouted deck reports no correction by definition. The two failures
   * need different fixes, so they need different messages.
   */
  const applied = await js(
    'const a = window.__audio ? window.__audio() : null;' +
    // The decks never enter the document — they are detached media elements —
    // so the engine is the only thing that can say what they hold.
    'const loaded = (a?.tracks || []).filter(Boolean).length;' +
    'const r = await fetch("http://127.0.0.1:8674/v1/session");' +
    'const st = (await r.json()).state;' +
    'return a ? { gains: a.replayGain, loaded, playing: st?.state } : { loaded, playing: st?.state };'
  );

  const gains = applied?.gains ?? [];
  if (!applied?.gains) {
    record("replay gain reaches the audio graph", false, "no audio graph");
  } else if ((applied.loaded ?? 0) === 0) {
    record("replay gain reaches the audio graph", false,
      "nothing loaded to normalise (session says " + (applied.playing ?? "?") + ")");
  } else {
    // At least one deck carries a correction, and none is absurd. A track
    // already at the target correctly gets a gain of 1, so this only demands
    // that some deck was corrected.
    const corrected = gains.filter((g) => typeof g === "number" && Math.abs(g - 1) > 0.02);
    record("replay gain reaches the audio graph",
      corrected.length > 0 && gains.every((g) => g > 0.2 && g < 4.2),
      gains.map((g) => (typeof g === "number" ? g.toFixed(3) : "?")).join(" / ") +
        " across " + applied.loaded + " loaded deck(s)");
  }
}

/**
 * The Follow button knows whether the account already follows.
 *
 * Also recorded as impossible, and also not: the subscribe button in the
 * artist header carries `subscribed`. The button used to start at "Follow"
 * for every artist, including ones the account had followed for years.
 */
async function sweepFollowState() {
  const artist = await js(`
    const r = await fetch("http://127.0.0.1:${PORT}/v1/search?q=" +
      encodeURIComponent("radiohead") + "&filter=artists");
    if (!r.ok) return null;
    const res = await r.json();
    for (const sh of (res.shelves || []))
      for (const it of (sh.items || [])) if (it.kind === "artist") return it.artist.id;
    return null;
  `);
  if (!artist || artist.__error) return record("follow state", false, "no artist to open");

  const fromApi = await js(`
    const r = await fetch("http://127.0.0.1:${PORT}/v1/artists/" +
      encodeURIComponent(${JSON.stringify(artist)}));
    if (!r.ok) return { __error: "HTTP " + r.status };
    const a = await r.json();
    return { following: a.following, name: a.name };
  `);
  record("the artist page carries follow state",
    typeof fromApi?.following === "boolean",
    fromApi?.name + ": following=" + String(fromApi?.following));

  await js('location.hash = "#/artist/" + encodeURIComponent(' + JSON.stringify(artist) + ');');
  await wait(3500);

  const shown = await js(
    'const b = [...document.querySelectorAll(".chip")]' +
    '  .find((x) => /^(Follow|Following)$/.test((x.textContent || "").trim()));' +
    'return b ? { label: (b.textContent || "").trim(),' +
    '             pressed: b.getAttribute("aria-pressed") } : null;'
  );
  /*
   * The button must agree with the response, not merely exist.
   *
   * Starting at "Follow" always looked right for an unfollowed artist, which
   * is why this went unnoticed — so the assertion is agreement, and it is
   * only meaningful because the API value is read independently above.
   */
  const agrees = shown &&
    // An absent value is not agreement: undefined is falsy, so without this
    // the check passed by reading "Follow" against nothing at all.
    typeof fromApi?.following === "boolean" &&
    (fromApi.following ? shown.label === "Following" : shown.label === "Follow") &&
    shown.pressed === String(fromApi.following);
  record("the Follow button agrees with the account",
    Boolean(agrees),
    shown ? shown.label + " (aria-pressed=" + shown.pressed + ")" : "no follow button");
}

/**
 * How long a song takes to start, and that asking costs one resolution.
 *
 * Resolving a track is about three seconds of upstream round trips — measured
 * at 2.8s through yt-dlp and 2.7s through the pure-Go extractor, so it is the
 * network, not the tool. What is controllable is how many times it happens:
 * playing a track asks for the stream and the track's loudness at the same
 * instant, and both used to miss the cache and start their own resolution.
 * Two subprocesses racing made starting a song slower than doing nothing.
 */
async function sweepStartLatency() {
  if (throttled) {
    return record("a song starts promptly", false,
      "SKIPPED — YouTube is rate-limiting this address");
  }

  const timed = await js(`
    const s = await fetch("http://127.0.0.1:${PORT}/v1/search?q=" +
      encodeURIComponent("boards of canada") + "&filter=songs");
    if (!s.ok) return { __error: "search HTTP " + s.status };
    const res = await s.json();
    let id = null;
    for (const sh of (res.shelves || []))
      for (const it of (sh.items || [])) if (it.kind === "track") { id = it.track.id; break; }
    if (!id) return { __error: "no track" };

    // The play pattern: the stream and the loudness lookup, together.
    const t0 = performance.now();
    const [stream, loud] = await Promise.all([
      fetch("http://127.0.0.1:${PORT}/v1/stream/" + encodeURIComponent(id),
            { headers: { Range: "bytes=0-65535" } }).then((r) => ({ ok: r.ok, at: performance.now() })),
      fetch("http://127.0.0.1:${PORT}/v1/tracks/" + encodeURIComponent(id) + "/loudness")
        .then((r) => ({ ok: r.ok, at: performance.now() })),
    ]);

    // Warm now, which is what a second play of the same track costs.
    const t1 = performance.now();
    const again = await fetch("http://127.0.0.1:${PORT}/v1/stream/" + encodeURIComponent(id),
                              { headers: { Range: "bytes=0-65535" } });
    return {
      cold: Math.round(stream.at - t0),
      loudness: Math.round(loud.at - t0),
      warm: Math.round(performance.now() - t1),
      ok: stream.ok && again.ok,
    };
  `);

  if (!timed || timed.__error || !timed.ok) {
    return record("a song starts promptly", false, timed?.__error || "stream failed");
  }

  /*
   * Bounded generously on purpose.
   *
   * This is a real network against a service that varies, so the number is a
   * regression guard rather than a target: doubling up on resolutions, or
   * putting yt-dlp back behind the loudness lookup, would blow well past it.
   */
  record("a song starts promptly", timed.cold < 9000, timed.cold + "ms cold");

  // Loudness must not wait behind a resolution — that was the regression.
  record("loudness does not wait for a resolution",
    timed.loudness < timed.cold * 0.8 || timed.loudness < 1500,
    timed.loudness + "ms while the stream took " + timed.cold + "ms");

  // A resolved track replays immediately, which is what makes warming work.
  record("an already-resolved track starts at once", timed.warm < 1200,
    timed.warm + "ms warm");
}

/**
 * Mute silences the audio, not just the icon.
 *
 * It used to be a store flag and nothing else: the store drives the engine
 * only while playback is local, and the core is authoritative whenever it is
 * reachable, so in the packaged app the button changed its own icon and the
 * slider's position while the music kept playing at full volume. Checking the
 * button's appearance would have gone on passing — so this reads the gain.
 */
async function sweepMute() {
  const gain = () => js(
    'const a = window.__audio ? window.__audio() : null;' +
    'const r = await fetch("http://127.0.0.1:8674/v1/session");' +
    'const st = (await r.json()).state;' +
    'const b = [...document.querySelectorAll(".bar .iconbtn")]' +
    '  .find((x) => /^(Mute|Unmute)$/.test(x.getAttribute("aria-label") || ""));' +
    'return { master: a ? a.master : null, session: st?.volume, label: b?.getAttribute("aria-label") };'
  );

  const before = await gain();
  if (!before || before.master === null) return record("mute", false, "no audio graph");

  if (!(await click('.bar .iconbtn[aria-label="Mute"]'))) {
    return record("mute", false, "no mute button");
  }
  await wait(1600);
  const muted = await gain();

  record("mute silences the audio",
    muted?.master === 0 || (muted?.master ?? 1) < 0.001,
    "master gain " + before.master?.toFixed(3) + " -> " + (muted?.master ?? "?"));
  record("mute reaches the core", muted?.session === 0,
    "session volume " + (muted?.session ?? "?"));
  record("mute flips the button", muted?.label === "Unmute", muted?.label || "(none)");

  // And unmuting brings the level back rather than leaving it at zero.
  await click('.bar .iconbtn[aria-label="Unmute"]');
  await wait(1600);
  const back = await gain();
  record("unmute restores the level",
    (back?.master ?? 0) > 0.01 && back?.label === "Mute",
    "master gain " + (back?.master ?? "?") + ", button " + (back?.label || "(none)"));
}

/**
 * What gets remembered for next launch.
 *
 * "Resume where you left off" was a switch in Settings with nothing behind
 * it — the setting existed, the toggle moved, and no code read it. The
 * restart itself is covered by a Go test that opens the same database file
 * twice; what this checks is the part that only exists once the app is
 * assembled: that playing something leaves a restorable session, and that the
 * switch reaches the core rather than sitting in the browser.
 */
async function sweepResume() {
  const state = await js(`
    const r = await fetch("http://127.0.0.1:${PORT}/v1/session");
    if (!r.ok) return { __error: "HTTP " + r.status };
    const st = (await r.json()).state;
    const items = st?.queue?.items || [];
    return {
      queued: items.length,
      index: st?.queue?.index ?? -1,
      title: items[st?.queue?.index ?? 0]?.title || "",
      positionMs: st?.positionMs ?? 0,
      volume: st?.volume,
    };
  `);

  // Everything a resume needs: which track, where in it, and how loud.
  record("the session is restorable",
    (state?.queued ?? 0) > 0 && (state?.index ?? -1) >= 0 && typeof state?.volume === "number",
    state?.__error ||
      `${state?.queued} queued, on "${state?.title}" at ${Math.round((state?.positionMs || 0) / 1000)}s, volume ${state?.volume}`);

  // The switch has to reach the core, which is what writes the queue down.
  for (const on of [false, true]) {
    const accepted = await js(`
      const r = await fetch("http://127.0.0.1:${PORT}/v1/session/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crossfadeMs: 0, gapless: true, resumeOnLaunch: ${on} }),
      });
      return { ok: r.ok, status: r.status };
    `);
    record(`resume setting reaches the core (${on ? "on" : "off"})`,
      accepted?.ok === true, "HTTP " + (accepted?.status ?? "?"));
  }
}

/**
 * Icon-only controls explain themselves on hover.
 *
 * The labels were always there for screen readers; nothing showed them to
 * anyone using a mouse, so a row of glyphs was a guessing game.
 */
async function sweepTooltips() {
  await goHome();

  const target = await js(
    'const b = [...document.querySelectorAll(".bar button[aria-label]")]' +
    '  .find((x) => (x.textContent || "").trim() === "");' +
    'if (!b) return null;' +
    'const r = b.getBoundingClientRect();' +
    'return { label: b.getAttribute("aria-label"),' +
    '         x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };'
  );
  if (!target) return record("icon tooltips", false, "no icon-only control found");

  win.focus();
  win.webContents.sendInputEvent({ type: "mouseMove", x: target.x, y: target.y });
  await wait(900);

  const tip = await js(
    'const t = document.querySelector(".tooltip");' +
    'if (!t) return null;' +
    'const r = t.getBoundingClientRect();' +
    'return { text: (t.textContent || "").trim(), w: Math.round(r.width),' +
    '         onScreen: r.top >= 0 && r.left >= 0 && r.right <= window.innerWidth };'
  );

  record("icon tooltips appear on hover", Boolean(tip) && tip.text === target.label,
    tip ? `"${tip.text}" for ${target.label}` : "no tooltip");
  record("a tooltip stays on screen", !tip || tip.onScreen === true,
    tip ? `${tip.w}px wide` : "n/a");

  // Moving away takes it with you, or it would sit over the interface.
  win.webContents.sendInputEvent({ type: "mouseMove", x: 10, y: 10 });
  await wait(700);
  const gone = await count(".tooltip");
  record("a tooltip leaves with the pointer", gone === 0, `${gone} left on screen`);
}

/**
 * A long title stays inside its own card.
 *
 * Grid items do not shrink below their content unless told to, so a long
 * title pushed straight out of the card and across its neighbour. The
 * ellipsis rule was there all along; nothing ever overflowed as far as the
 * box was concerned, so it never applied.
 */
async function sweepCardOverflow() {
  await goHome();
  await wait(1200);

  const spill = await js(
    'const cards = [...document.querySelectorAll(".shelf__row .card")];' +
    'let worst = null;' +
    'for (const c of cards) {' +
    '  const box = c.getBoundingClientRect();' +
    '  for (const t of c.querySelectorAll(".card__title, .card__link, .card__sub")) {' +
    '    const over = Math.round(t.scrollWidth - t.clientWidth);' +
    '    const past = Math.round(t.getBoundingClientRect().right - box.right);' +
    '    if (past > 1 && (!worst || past > worst.past)) {' +
    '      worst = { text: (t.textContent || "").trim().slice(0, 40), past, over };' +
    '    }' +
    '  }' +
    '}' +
    'return { cards: cards.length, worst };'
  );

  record("card titles stay inside their card",
    (spill?.cards ?? 0) > 0 && !spill?.worst,
    spill?.worst
      ? `"${spill.worst.text}" runs ${spill.worst.past}px past its card`
      : `${spill?.cards ?? 0} cards, none spilling`);
}

/**
 * Sharing puts the public link on the clipboard, and says so.
 *
 * Read from the real system clipboard, through the main process: the button
 * only matters if what lands there is a link someone else can open.
 */
async function sweepShare() {
  const id = await js(`
    const r = await fetch("http://127.0.0.1:${PORT}/v1/session");
    const st = (await r.json()).state;
    const items = st?.queue?.items || [];
    return items[st?.queue?.index ?? -1]?.id || null;
  `);
  if (!id) return record("share", false, "nothing playing to share");

  clipboard.writeText("");
  if (!(await click('.bar [aria-label="Share"]'))) return record("share", false, "no share button in the bar");
  await wait(700);

  const copied = clipboard.readText();
  record("share copies the song's YouTube Music link",
    copied === "https://music.youtube.com/watch?v=" + encodeURIComponent(id),
    copied || "(clipboard empty)");
  const toastText = await js('return (document.querySelector(".toast")?.textContent || "").trim();');
  record("share confirms with a toast", /copied/i.test(toastText || ""), toastText || "(no toast)");
}

/**
 * The playing track shows its length.
 *
 * Videos often arrive without one, and it used to be filled in only when a
 * track first loaded on the deck that was playing — so a track preloaded for
 * gapless or crossfade kept "--:--" all the way through.
 */
async function sweepDurationShown() {
  await wait(1500);
  const times = await js(
    'return [...document.querySelectorAll(".bar__progress .bar__time")].map((t) => (t.textContent || "").trim());'
  );
  const total = Array.isArray(times) ? times[times.length - 1] : "";
  record("the playing track shows its length",
    /^\d+:\d{2}$/.test(total || "") && total !== "0:00",
    total || "(none)");
}

/* ---------- playback start, quality switch, crossfade, queue, links ---------- */

/** Songs from a search, for sweeps that need tracks nothing has resolved yet. */
async function freshSongs(q, n) {
  const res = await js(`
    const r = await fetch("http://127.0.0.1:${PORT}/v1/search?q=" + encodeURIComponent(${JSON.stringify(q)}) + "&filter=songs");
    if (!r.ok) return { __error: "search HTTP " + r.status };
    const out = [];
    for (const sh of ((await r.json()).shelves || []))
      for (const it of (sh.items || [])) if (it.kind === "track" && it.track.playable !== false) out.push(it.track);
    return out.slice(0, ${n});
  `);
  return Array.isArray(res) ? res : [];
}

function command(cmd) {
  return js(`
    const r = await fetch("http://127.0.0.1:${PORT}/v1/session/command", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "sweep", command: ${JSON.stringify(cmd)} }) });
    return { ok: r.ok, status: r.status };
  `);
}

const audio = () => js("return window.__audio ? window.__audio() : null;");

/** Polls the engine until check(state) is true, or gives up. */
async function until(check, timeoutMs, stepMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const a = await audio();
    if (a && !a.__error && check(a)) return a;
    await wait(stepMs);
  }
  return null;
}

const activeDeck = (a) => a.decks?.[a.active];

/** A selector as a string literal inside page code. */
const sel = (s) => JSON.stringify(s);

/**
 * A crossfade is heard as one: both tracks audible at once.
 *
 * It used to cut. The core's next target arrived the moment the fade began
 * and named a new track to preload onto the idle deck — which at that point
 * was the outgoing song, so it was replaced mid-fade.
 */
async function sweepCrossfadeHeard() {
  const songs = await freshSongs("duman", 3);
  if (songs.length < 2) return record("crossfade overlaps both songs", false, "not enough tracks");

  await js(`await fetch("http://127.0.0.1:${PORT}/v1/session/settings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ crossfadeMs: 6000, gapless: true }) }); return true;`);
  await command({ Kind: "play", Tracks: songs, StartIndex: 0, Origin: "sweep" });

  // Wait for the next track to be warm on the other deck, which is what a
  // crossfade fades into.
  const warm = await until((a) => {
    const d = activeDeck(a);
    const other = a.decks?.[1 - a.active];
    return d && d.id === songs[0].id && !d.paused && Number.isFinite(d.dur) && d.dur > 20 &&
      other && other.id === songs[1].id && a.edgesKnown;
  }, 40000, 300);
  if (!warm) return record("crossfade overlaps both songs", false, "next song never preloaded");

  const dur = activeDeck(warm).dur;
  await command({ Kind: "seek", PositionMs: Math.round((dur - 14) * 1000) });

  // Where the music, not the file, ends and begins.
  const edges = await js(`const a = await window.__edges(${JSON.stringify(songs[0].id)}); const b = await window.__edges(${JSON.stringify(songs[1].id)}); return a && b ? { end: a.endS, lead: b.startS } : null;`);
  let fadeStart = null;
  let overlap = 0;
  let outgoingCut = false;
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    const a = await audio();
    if (a?.decks && a.fades) {
      const i0 = a.decks.findIndex((d) => d.id === songs[0].id);
      const i1 = a.decks.findIndex((d) => d.id === songs[1].id);
      if (i0 >= 0 && i1 >= 0 && !a.decks[i0].paused && !a.decks[i1].paused) {
        overlap = Math.max(overlap, Math.min(a.fades[i0], a.fades[i1]));
        if (!fadeStart) fadeStart = { out: a.decks[i0].at, in: a.decks[i1].at };
      }
      // The outgoing song replaced by something else while still fading.
      if (i1 >= 0 && i0 < 0 && !a.decks[1 - i1].paused && a.fades[1 - i1] > 0.05) {
        outgoingCut = true;
      }
    }
    await wait(120);
  }
  if (edges && fadeStart) {
    // Six seconds before the sound ends, give or take a tick; and the next
    // song from its first sound, not the silence before it.
    const early = edges.end - 6 - fadeStart.out;
    record("the crossfade is timed on the music, not the silence",
      Math.abs(early) < 1 && fadeStart.in >= edges.lead - 0.3,
      `faded at ${fadeStart.out.toFixed(1)}s, music ends ${edges.end.toFixed(1)}s; next from ${fadeStart.in.toFixed(1)}s (sound at ${edges.lead.toFixed(1)}s)`);
  }
  record("crossfade overlaps both songs", overlap > 0.3 && !outgoingCut,
    `peak overlap gain ${overlap.toFixed(2)}${outgoingCut ? ", outgoing song was replaced mid-fade" : ""}`);

  const now = await audio();
  record("after the crossfade the next song plays",
    activeDeck(now)?.id === songs[1].id && !activeDeck(now)?.paused,
    activeDeck(now)?.id ?? "nothing");
  // And the player shows it: the session moved on with the sound.
  const cur = await js(`const st = (await (await fetch("http://127.0.0.1:${PORT}/v1/session")).json()).state; return (st.queue.items[st.queue.index] || {}).id;`);
  record("after the crossfade the player shows the next song", cur === songs[1].id, cur || "nothing");
}

async function sessionQueue() {
  return js(`
    const st = (await (await fetch("http://127.0.0.1:${PORT}/v1/session")).json()).state;
    return { ids: (st.queue.items || []).map((t) => t.id), index: st.queue.index };
  `);
}

/**
 * The queue can be edited, and what it shows is what plays.
 *
 * With shuffle on, the panel listed the original order while playback
 * followed a hidden shuffled one, so moving or removing a track changed a
 * list nothing was reading.
 */
async function sweepQueueEditing() {
  const songs = await freshSongs("sezen aksu", 5);
  if (songs.length < 4) return record("queue: remove a track", false, "not enough tracks");
  await command({ Kind: "set_shuffle", Shuffle: true });
  await command({ Kind: "play", Tracks: songs, StartIndex: 0, Origin: "sweep" });
  await wait(800);

  if (!(await count(".nowplaying"))) await click('.bar [aria-label="Queue"]');
  await wait(700);

  const shown = await js(
    'return [...document.querySelectorAll(".nowplaying .queueitem .queuerow:not(.queuerow--played) .queuerow__title")].map((e) => e.textContent);'
  );
  const q = await sessionQueue();
  const titleOf = (id) => songs.find((s) => s.id === id)?.title;
  record("queue shows the order that plays (shuffled)",
    Array.isArray(shown) && shown[0] === titleOf(q.ids[q.index + 1]),
    `panel next "${shown?.[0]}", playing next "${titleOf(q.ids[q.index + 1])}"`);

  const victim = q.ids[q.index + 1];
  await click(".nowplaying .queueitem .queuerow:not(.queuerow--played) .queuerow__remove", 0);
  await wait(700);
  const after = await sessionQueue();
  record("queue: remove a track", !after.ids.includes(victim) && after.ids.length === q.ids.length - 1,
    `${q.ids.length} -> ${after.ids.length}`);

  const next = after.ids[after.index + 1];
  await command({ Kind: "next" });
  await wait(500);
  const now = await sessionQueue();
  record("next plays what the queue listed", now.ids[now.index] === next, titleOf(now.ids[now.index]) || "?");
  await command({ Kind: "set_shuffle", Shuffle: false });
}

/** Artist and album names in the bar go somewhere. */
async function sweepNameLinks() {
  const [track] = await freshSongs("duman her şeyi yak", 1);
  if (!track) return record("artist name opens the artist", false, "no track");
  await command({ Kind: "play", Tracks: [track], StartIndex: 0, Origin: "sweep" });
  await wait(1200);

  const links = await js(
    'return [...document.querySelectorAll(".bar__artist a")].map((a) => a.getAttribute("href"));'
  );
  record("bar shows the album beside the artist",
    Array.isArray(links) && links.some((h) => /#\/album\//.test(h || "")), (links || []).join(" "));

  if (await click('.bar__artist a[href*="/artist/"]')) {
    await wait(2500);
    const r = await route();
    record("artist name opens the artist", /#\/artist\//.test(r) && !(await notFound()), r);
  } else {
    record("artist name opens the artist", false, "no artist link in the bar");
  }
  if (await click('.bar__artist a[href*="/album/"]')) {
    await wait(2500);
    const r = await route();
    record("album name opens the album", /#\/album\//.test(r) && !(await notFound()), r);
  }
  // Later checks start from Home.
  await goHome();
}

/** Volume past 100% when boost is on. */
async function sweepVolumeBoost() {
  const maxOf = () => js(`return document.querySelector(${sel('.bar [aria-label="Volume"]')})?.max;`);
  const setBoost = (on) => js(`
    const raw = localStorage.getItem("spotifier.settings");
    const saved = raw ? JSON.parse(raw) : { state: {}, version: 2 };
    saved.state.volumeBoost = ${on};
    localStorage.setItem("spotifier.settings", JSON.stringify(saved));
    return true;
  `);

  const max0 = await maxOf();
  await setBoost(true);
  await win.webContents.reload();
  await wait(4000);
  const max1 = await maxOf();
  record("volume boost lets the slider reach 200%", String(max0) === "100" && String(max1) === "200",
    `${max0} -> ${max1}`);

  await command({ Kind: "set_volume", Volume: 1.6 });
  await wait(600);
  const v = await js(`return (await (await fetch("http://127.0.0.1:${PORT}/v1/session")).json()).state.volume;`);
  record("the core keeps a boosted volume", Math.abs(v - 1.6) < 0.01, String(v));
  await command({ Kind: "set_volume", Volume: 0.5 });

  await setBoost(false);
  await win.webContents.reload();
  await wait(4000);
  await goHome();
}

/** The full-screen player and the lyrics view both have a volume slider. */
async function sweepOverlayVolume() {
  if (await click('.bar [aria-label="Open now playing"]')) {
    await wait(900);
    const n = await count('.fsp [aria-label="Volume"]');
    const width = await js(`const r = document.querySelector(".fsp .slider--volume")?.getBoundingClientRect(); return r ? r.width : 0;`);
    record("full-screen player has a volume slider", n === 1 && width > 40, `${n} slider, ${width}px wide`);
    await click('.fsp [aria-label="Exit full screen"]');
    await wait(600);
  } else {
    record("full-screen player has a volume slider", false, "could not open it");
  }
  // The bar opens the side panel; the full view is its expand button.
  if (!(await count(".lyricspanel, .nowplaying [aria-label='Expand lyrics']"))) {
    await click('.bar [aria-label="Lyrics"]');
    await wait(900);
  }
  if ((await count(".lyricsview")) > 0 || (await click('[aria-label="Expand lyrics"]'))) {
    await wait(900);
    const n = await count('.lyricsview [aria-label="Volume"]');
    record("lyrics view has a volume slider", n === 1, `${n} slider`);
    await click('.lyricsview [aria-label="Close lyrics"]');
    await wait(600);
  }
}

/** What the core's song cache holds for one track. */
function cached(id) {
  return js(`
    const r = await fetch("http://127.0.0.1:${PORT}/v1/cache?id=" + encodeURIComponent(${JSON.stringify(id)}));
    return r.ok ? r.json() : { have: 0, size: 0, complete: false };
  `);
}

async function untilCached(id, whole, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = await cached(id);
    if (c && (whole ? c.complete : c.have > 0)) return c;
    await wait(300);
  }
  return null;
}

/** Time from a play command to the engine producing sound. */
async function timeToSound(track, queue) {
  const t0 = Date.now();
  await command({ Kind: "play", Tracks: queue ?? [track], StartIndex: 0, Origin: "sweep" });
  const started = await until((a) => {
    const d = activeDeck(a);
    return d && d.id === track.id && !d.paused && d.at > 0.1;
  }, 15000, 50);
  return started ? Date.now() - t0 : null;
}

/**
 * Songs start from the cache, the way Spotify's do.
 *
 * Starting a song cold means yt-dlp resolving it, four to five seconds. A
 * song the pointer rested on, the top of a page, or the next few in the
 * queue are readied ahead of time, and a song played before is on disk.
 */
async function sweepSongCache() {
  const songs = await freshSongs("mfö ele güne karşı", 4);
  if (songs.length < 4) return record("a prefetched song starts at once", false, "not enough tracks");
  const [hovered, ...queue] = songs;

  // What a hover does.
  await js(`await fetch("http://127.0.0.1:${PORT}/v1/prefetch/" + ${JSON.stringify(hovered.id)}, { method: "POST" }); return true;`);
  const opening = await untilCached(hovered.id, false, 20000);
  if (!opening) return record("a prefetched song starts at once", false, "its opening was never cached");

  const ms = await timeToSound(hovered);
  record("a prefetched song starts at once", ms !== null && ms < 1500, ms === null ? "never started" : `${ms}ms`);

  // Played once, kept whole: the next time needs nothing from upstream.
  const whole = await untilCached(hovered.id, true, 30000);
  record("a played song is kept whole", Boolean(whole), whole ? `${Math.round(whole.size / 1024)} KB` : "not cached");

  // The core readies what is coming up without being asked.
  await command({ Kind: "play", Tracks: queue, StartIndex: 0, Origin: "sweep" });
  const next = await untilCached(queue[1].id, true, 40000);
  record("the next song in the queue is ready before it plays", Boolean(next),
    next ? "cached whole" : "not cached");

  const skip0 = Date.now();
  await command({ Kind: "next" });
  const skipped = await until((a) => {
    const d = activeDeck(a);
    return d && d.id === queue[1].id && !d.paused && d.at > 0.1;
  }, 15000, 50);
  const skipMs = Date.now() - skip0;
  record("skipping to it is instant", Boolean(skipped) && skipMs < 1500, skipped ? `${skipMs}ms` : "never started");

  // Replaying the first song again comes from disk.
  const again = await timeToSound(hovered);
  record("a cached song replays at once", again !== null && again < 1000, again === null ? "never started" : `${again}ms`);
}

/**
 * A skip cuts; only a track ending on its own crossfades.
 *
 * With crossfade on, skipping used to fade the old track out over the full
 * six seconds, so the next song crept in under the one being skipped.
 */
async function sweepSkipCuts() {
  const songs = await freshSongs("athena", 3);
  if (songs.length < 2) return record("a skip cuts, even with crossfade on", false, "not enough tracks");
  await js(`await fetch("http://127.0.0.1:${PORT}/v1/session/settings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ crossfadeMs: 6000, gapless: true }) }); return true;`);
  await command({ Kind: "play", Tracks: songs, StartIndex: 0, Origin: "sweep" });
  const warm = await until((a) => {
    const d = activeDeck(a);
    const other = a.decks?.[1 - a.active];
    return d && d.id === songs[0].id && !d.paused && d.at > 1 && other && other.id === songs[1].id;
  }, 40000, 300);
  if (!warm) return record("a skip cuts, even with crossfade on", false, "next song never preloaded");

  await command({ Kind: "next" });
  await wait(600);
  const a = await audio();
  const i0 = a?.decks?.findIndex((d) => d.id === songs[0].id) ?? -1;
  const oldAudible = i0 >= 0 && !a.decks[i0].paused && (a.fades?.[i0] ?? 0) > 0.05;
  record("a skip cuts, even with crossfade on",
    activeDeck(a)?.id === songs[1].id && !oldAudible,
    oldAudible ? `old song still at gain ${a.fades[i0].toFixed(2)} after 0.6 s` : "cut");
}

/** Types into the search box and waits for results. */
async function searchFor(q) {
  // What is listed now, so the wait below can tell new results from old.
  const firstRow = () => js(`return document.querySelector(".trackrow .trackrow__title, .shelf__row .card")?.textContent || "";`);
  const previous = await firstRow();
  await js(`location.hash = "#/search?q=" + encodeURIComponent(${JSON.stringify(q)}); return true;`);
  const changed = Date.now() + 10000;
  while (previous && Date.now() < changed && (await firstRow()) === previous) await wait(250);
  // Until this query's results are on screen, not the previous page's.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await wait(500);
    const ready = await js(`
      const input = document.querySelector('.searchfield input');
      return location.hash.includes("search") && (!input || input.value === ${JSON.stringify(q)}) &&
        document.querySelectorAll(".trackrow, .shelf__row .card").length > 0 &&
        !document.querySelector(".skeleton, [aria-busy='true']");
    `);
    if (ready === true) break;
  }
  await wait(800);
}

/**
 * The top result is what it says it is.
 *
 * A song top result opened its artist, and its play button played the
 * artist's top song; an album top result opened the artist too. The card
 * read its target from a random link inside it — usually the artist's.
 */
async function sweepTopResult() {
  await searchFor("lvbel c5 10 numara");
  const card = await js(`
    const c = document.querySelector(".shelf__row .card");
    return c ? { tag: c.tagName, label: c.getAttribute("aria-label") || "", href: c.getAttribute("href") || c.querySelector("a")?.getAttribute("href") || "" } : null;
  `);
  record("a song top result is a play control, not a link to its artist",
    Boolean(card) && card.tag === "BUTTON" && /^Play /.test(card.label),
    card ? `${card.tag} ${card.label || card.href}` : "no top result");

  if (card?.tag === "BUTTON") {
    await click(".shelf__row .card");
    await wait(2500);
    const s = await js(`
      const st = (await (await fetch("http://127.0.0.1:${PORT}/v1/session")).json()).state;
      return { title: st.queue.items[st.queue.index]?.title, route: location.hash };
    `);
    record("clicking a song top result plays that song", /numara/i.test(s?.title || "") && /search/.test(s?.route || ""),
      `${s?.title} on ${s?.route}`);
  }

  await searchFor("duman dünya yalan söylüyor album");
  const album = await js(`
    const c = document.querySelector(".shelf__row .card");
    const a = c?.tagName === "A" ? c : c?.querySelector("a");
    return a ? a.getAttribute("href") : (c ? c.tagName : null);
  `);
  record("an album top result opens the album", /\/album\//.test(album || ""), album || "no top result");
}

/**
 * Buttons in a track row are their own controls.
 *
 * In search results the heart and the menu button did nothing of their own,
 * and a click on them reached the row, which played the song.
 */
async function sweepRowButtons() {
  await searchFor("sezen aksu");
  const before = await js(`return (await (await fetch("http://127.0.0.1:${PORT}/v1/session")).json()).state.queue.items.length;`);
  const ok = await click('.trackrow [aria-label^="More options for"]');
  await wait(600);
  const menuOpen = await count('[role="menu"]');
  record("a row's menu button opens its menu", ok && menuOpen > 0, `${menuOpen} menu`);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  await wait(300);
  const after = await js(`return (await (await fetch("http://127.0.0.1:${PORT}/v1/session")).json()).state.queue.items.length;`);
  const hearts = await count('.trackrow [aria-pressed][aria-label*="Save"], .trackrow [aria-pressed][aria-label*="Remove"]');
  record("a row's heart is a real toggle", hearts > 0, `${hearts} hearts`);
  record("the row buttons do not play the song", before === after, `queue ${before} -> ${after}`);
}

/** Clicking the song that is already playing does not restart it. */
async function sweepNoRestart() {
  const songs = await freshSongs("sezen aksu", 3);
  if (!songs.length) return record("clicking the playing song does not restart it", false, "no songs");
  await command({ Kind: "play", Tracks: songs, StartIndex: 0, Origin: "sweep" });
  const started = await until((a) => {
    const d = activeDeck(a);
    return d && d.id === songs[0].id && d.at > 4;
  }, 30000, 250);
  if (!started) return record("clicking the playing song does not restart it", false, "never got going");
  const at = activeDeck(started).at;
  // Double-click the playing song's own row, the way a person would.
  await searchFor("sezen aksu");
  const box = await js(`
    const rows = [...document.querySelectorAll(".trackrow")];
    const row = rows.find((r) => r.querySelector(".trackrow__title")?.textContent === ${JSON.stringify(songs[0].title)});
    if (!row) return null;
    const b = row.querySelector(".trackrow__title").getBoundingClientRect();
    return { x: Math.round(b.x + 10), y: Math.round(b.y + b.height / 2) };
  `);
  if (!box) return record("clicking the playing song does not restart it", false, "its row is not in the results");
  win.focus();
  for (const clickCount of [1, 2]) {
    const at2 = { x: box.x, y: box.y, button: "left", clickCount };
    win.webContents.sendInputEvent({ type: "mouseDown", ...at2 });
    win.webContents.sendInputEvent({ type: "mouseUp", ...at2 });
  }
  await wait(1500);
  const now = await audio();
  const after = activeDeck(now)?.at ?? 0;
  record("clicking the playing song does not restart it", activeDeck(now)?.id === songs[0].id && after >= at,
    `${at.toFixed(1)}s -> ${after.toFixed(1)}s`);
}

/**
 * A song picked from search plays its radio, as in YouTube Music.
 *
 * It used to queue the other search results around it; YouTube Music plays
 * the song's own "Up next" radio instead, which keeps extending.
 */
async function sweepRadio() {
  await searchFor("duman her şeyi yak");
  const box = await js(`
    const row = document.querySelector(".trackrow");
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    await new Promise((r) => setTimeout(r, 400));
    const b = row.querySelector(".trackrow__title").getBoundingClientRect();
    return { x: Math.round(b.x + 10), y: Math.round(b.y + b.height / 2), title: row.querySelector(".trackrow__title").textContent };
  `);
  if (!box) return record("a searched song starts its radio", false, "no search results");
  win.focus();
  for (const clickCount of [1, 2]) {
    const at = { x: box.x, y: box.y, button: "left", clickCount };
    win.webContents.sendInputEvent({ type: "mouseDown", ...at });
    win.webContents.sendInputEvent({ type: "mouseUp", ...at });
  }

  const state = () => js(`
    const st = (await (await fetch("http://127.0.0.1:${PORT}/v1/session")).json()).state;
    return { n: st.queue.items.length, index: st.queue.index, origin: st.queue.origin,
             first: st.queue.items[0]?.title, ids: st.queue.items.map((t) => t.id) };
  `);
  let s = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    s = await state();
    if (s?.n > 10) break;
    await wait(300);
  }
  record("a searched song starts its radio",
    s?.first === box.title && s?.n > 10 && /radio/i.test(s?.origin || ""),
    `${s?.first} + ${Math.max(0, (s?.n ?? 1) - 1)} from its radio (${s?.origin})`);
  if (!s || s.n <= 10) return;

  // Near the end, the radio carries on.
  const before = s.n;
  await command({ Kind: "jump", At: s.n - 2 });
  let grown = null;
  const until2 = Date.now() + 20000;
  while (Date.now() < until2) {
    grown = await state();
    if (grown?.n > before) break;
    await wait(400);
  }
  const unique = new Set(grown?.ids ?? []).size;
  record("the radio keeps going as the queue runs low",
    grown?.n > before && unique === grown.n, `${before} -> ${grown?.n} songs, ${unique} unique`);

  // What has played stays in the queue, and can be gone back to.
  if (!(await count(".nowplaying"))) await click('.bar [aria-label="Queue"]');
  await wait(800);
  const played = await count(".nowplaying .queuerow--played");
  record("the queue shows songs already played", played > 0, `${played} played`);
  if (played > 0) {
    await click(".nowplaying .queuerow--played", 0);
    await wait(1200);
    const back = await state();
    record("a played song can be gone back to", back?.index === 0 && back?.n === grown?.n,
      `now at ${back?.index} of ${back?.n}`);
  }
  await click('.bar [aria-label="Queue"]');
}

/**
 * Search's All tab shows columns for what its rows carry.
 *
 * YouTube lists songs there as "Song • artist" and a play count, with no
 * album or length: the table had an empty Album column, play counts under
 * "Time", and the card's own items repeated as a second "Top result".
 */
async function sweepAllTab() {
  await searchFor("bir derdim var");
  const r = await js(`
    const heads = [...document.querySelectorAll(".tracktable__head")].map((h) => h.textContent);
    const titles = [...document.querySelectorAll(".shelf__title")].map((e) => e.textContent);
    return { heads, titles, beside: document.querySelectorAll(".topresult__items .trackrow").length };
  `);
  const songsHead = r?.heads?.[r.heads.length - 1] || "";
  record("the All tab shows no empty Album column", !/Album/.test(songsHead), songsHead);
  record("play counts sit under a Plays heading, not Time", /Plays/.test(songsHead) && !/Time/.test(songsHead), songsHead);
  record("the top result appears once", (r?.titles || []).filter((t) => t === "Top result").length === 1,
    (r?.titles || []).join(" | "));
}

/** Clicking an album or a playlist opens it; only its play button plays. */
async function sweepCardsOpen() {
  for (const [q, f, route] of [["daft punk", "albums", "album"], ["chill", "playlists", "playlist"]]) {
    await js(`location.hash = "#/search?q=${encodeURIComponent(q)}&filter=${f}"; return true;`);
    await wait(4500);
    const before = await js(`return (await (await fetch("http://127.0.0.1:${PORT}/v1/session")).json()).state.queue.items.map((t) => t.id).join(",");`);
    const box = await js(`const c = document.querySelector("div.card .card__artwrap"); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 3), y: Math.round(r.y + r.height / 3) };`);
    if (!box) { record(`clicking a ${route} opens it`, false, "no card"); continue; }
    win.focus();
    const at = { x: box.x, y: box.y, button: "left", clickCount: 1 };
    win.webContents.sendInputEvent({ type: "mouseDown", ...at });
    win.webContents.sendInputEvent({ type: "mouseUp", ...at });
    await wait(2500);
    const after = await js(`return { hash: location.hash, q: (await (await fetch("http://127.0.0.1:${PORT}/v1/session")).json()).state.queue.items.map((t) => t.id).join(",") };`);
    record(`clicking a ${route} opens it without playing`,
      after.hash.includes(`/${route}/`) && after.q === before, after.hash);
  }
  await goHome();
}

/**
 * Opening the app brings the last song back paused, and the controls work.
 *
 * It used to start playing on its own — the engine reporting the song loaded
 * switched the session to playing — and outside the path that sets up the
 * audio graph, so the volume slider did nothing until the next song.
 */
async function sweepLaunchPaused() {
  const [song] = await freshSongs("mor ve ötesi cambaz", 1);
  if (!song) return record("the last song comes back paused", false, "no song");
  await command({ Kind: "play", Tracks: [song], StartIndex: 0, Origin: "sweep" });
  await until((a) => activeDeck(a)?.id === song.id && activeDeck(a)?.at > 2, 30000, 250);
  // The session is written down every few seconds while playing.
  await wait(7000);

  // Quit and reopen: a new core on the same data, a fresh page. Killed
  // outright and waited for, or the "new" core finds the old one still on
  // the port and nothing is restored at all.
  await stopCore();
  await startCore(true);
  await win.webContents.reload();
  await wait(8000);

  const st = await js(`return (await (await fetch("http://127.0.0.1:${PORT}/v1/session")).json()).state;`);
  const a = await audio();
  const sounding = (a?.decks || []).some((d) => d.id === song.id && !d.paused);
  record("the last song comes back paused",
    st?.queue?.items?.[st.queue.index]?.id === song.id && st?.state === "paused" && !sounding,
    `${st?.state}, deck ${sounding ? "playing" : "silent"}`);

  // Resume it the way a person does, then check the volume reaches it.
  await click('.bar [aria-label="Play"]');
  const playing = await until((x) => {
    const d = activeDeck(x);
    return d && d.id === song.id && !d.paused;
  }, 15000, 250);
  record("pressing play resumes it", Boolean(playing), playing ? "playing" : "did not start");
  if (!playing) return;

  const routed = playing.routed?.[playing.active];
  await command({ Kind: "set_volume", Volume: 0.3 });
  await wait(800);
  const after = await audio();
  record("the volume reaches a song restored at launch",
    routed === true && Math.abs((after?.master ?? 0) - Math.pow(0.3, 1 / 0.6)) < 0.03,
    `routed ${routed}, master gain ${after?.master?.toFixed(3)}`);
  await command({ Kind: "set_volume", Volume: 0.5 });
}

/**
 * Repeat one keeps the song and shows it.
 *
 * The engine was told of a next track under repeat one, and faded into it or
 * started it when the song ended, while the session replayed the song: the
 * sound moved on and the player did not.
 */
async function sweepRepeatOne() {
  const songs = await freshSongs("athena", 3);
  if (songs.length < 2) return record("repeat one stays on the song", false, "not enough tracks");
  await js(`await fetch("http://127.0.0.1:${PORT}/v1/session/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ crossfadeMs: 6000, gapless: true }) }); return true;`);
  await command({ Kind: "play", Tracks: songs, StartIndex: 0, Origin: "sweep" });
  await command({ Kind: "set_repeat", Repeat: "one" });
  const going = await until((a) => { const d = activeDeck(a); return d && d.id === songs[0].id && !d.paused && d.dur > 20; }, 40000, 300);
  if (!going) { await command({ Kind: "set_repeat", Repeat: "off" }); return record("repeat one stays on the song", false, "never started"); }
  await command({ Kind: "seek", PositionMs: Math.round((activeDeck(going).dur - 4) * 1000) });
  await wait(9000);
  const st = await js(`const st = (await (await fetch("http://127.0.0.1:${PORT}/v1/session")).json()).state; return (st.queue.items[st.queue.index] || {}).id;`);
  const a = await audio();
  const shown = await js(`return document.querySelector(".bar__title")?.textContent;`);
  record("repeat one stays on the song, in sound and on screen",
    st === songs[0].id && activeDeck(a)?.id === songs[0].id && shown === songs[0].title,
    `session ${st === songs[0].id ? "same" : "moved"}, sound ${activeDeck(a)?.id === songs[0].id ? "same" : "moved"}, bar "${shown}"`);
  const badge = await count('.bar .repeatone');
  record("repeat one is visible on the button", badge === 1, `${badge} badge`);
  await command({ Kind: "set_repeat", Repeat: "off" });
}

async function sweepLibrary() {
  const items = await count(".libitem");
  record("library lists items", items > 0, `${items} items`);

  for (const filter of ["Playlists", "Artists", "Albums"]) {
    const before = await count(".libitem");
    const ok = await click(`.sidebar__chips .chip`, ["Playlists", "Artists", "Albums"].indexOf(filter));
    if (!ok) { record(`library filter: ${filter}`, false, "chip missing"); continue; }
    await wait(1200);
    const after = await count(".libitem");
    record(`library filter: ${filter}`, after >= 0, `${before} -> ${after} items`);
    await click(`.sidebar__chips .chip`, ["Playlists", "Artists", "Albums"].indexOf(filter));
    await wait(600);
  }

  for (const sort of ["recents", "added", "alphabetical", "creator"]) {
    const res = await js(`
      const r = await fetch("http://127.0.0.1:${PORT}/v1/me/library?sort=${sort}");
      if (!r.ok) return { ok: false, status: r.status };
      const items = await r.json();
      return { ok: true, n: items.length, first: items[0]?.title ?? "" };
    `);
    record(`library sort: ${sort}`, res.ok, res.ok ? `${res.n} items, first "${res.first}"` : `HTTP ${res.status}`);
  }
}

async function sweepStats() {
  await click('.sidebar a[href="#/stats"]');
  await wait(1800);
  const body = await text();
  const broken = /Statistics unavailable/i.test(body);
  record("your listening page", !broken && !/does not exist/i.test(body),
    broken ? "reported unavailable" : "rendered");

  for (const days of [7, 30, 365, 3650]) {
    const res = await js(`
      const r = await fetch("http://127.0.0.1:${PORT}/v1/me/stats/tracks?days=${days}&limit=5");
      return { ok: r.ok, status: r.status, n: r.ok ? (await r.json()).length : 0 };
    `);
    record(`stats period: ${days}d`, res.ok, res.ok ? `${res.n} rows` : `HTTP ${res.status}`);
  }
}

/**
 * Lyrics.
 *
 * The button for this existed for a long time with no click handler at all,
 * and the sweep passed the whole time because it only checked that controls
 * were present. Presence is not behaviour; this opens the panel and reads it.
 */
async function sweepLyrics() {
  const opened = await click('.bar [aria-label="Lyrics"]');
  if (!opened) return record("lyrics panel", false, "no lyrics control");
  await wait(3500);

  const panel = await js(
    'const el = document.querySelector(\'[aria-label="Lyrics"].nowplaying\');' +
    'if (!el) return null;' +
    'const t = el.innerText || "";' +
    'return { text: t.slice(0, 400),' +
    '         lines: el.querySelectorAll(".lyrics__line").length,' +
    '         hasPlain: !!el.querySelector(".lyrics--plain"),' +
    '         source: (el.querySelector(".lyrics__source")?.textContent || "") };'
  );
  if (!panel) return record("lyrics panel", false, "panel did not open");

  record("lyrics panel opens", true);

  const gotWords = panel.lines > 0 || panel.hasPlain;
  const saidNone = /No lyrics|Nothing playing/i.test(panel.text);
  // Either words or an explicit "none" is correct. A blank panel is not.
  record("lyrics resolve or say why not", gotWords || saidNone,
    gotWords ? (panel.lines > 0 ? panel.lines + " timed lines" : "plain text") : "reported none");
  if (gotWords) {
    record("lyrics carry attribution", panel.source.trim().length > 0,
      panel.source.trim() || "(none)");
  }

  await click('.bar [aria-label="Lyrics"]');
  await wait(600);
}

/**
 * The now-playing view.
 *
 * Opened from the cover in the transport bar, which is where people reach for
 * it, and closed with Escape, which is the only way out someone will try
 * before deciding the app is stuck.
 */
async function sweepFullScreen() {
  const opened = await click('.bar__artbtn');
  if (!opened) return record("now-playing view", false, "no cover control in the bar");
  await wait(900);

  const view = await js(
    'const el = document.querySelector(".fsp");' +
    'if (!el) return null;' +
    /* Wait for the cover to decode: it is a large image fetched when the view
       opens, so sampling once reports a working view as broken. */
    'for (let i = 0; i < 40; i += 1) {' +
    '  if ([...el.querySelectorAll("img")].some((x) => x.naturalWidth > 0)) break;' +
    '  await new Promise((r) => setTimeout(r, 150));' +
    '}' +
    /* Assert what the view is for, not which class names it uses: this check
       failed a restyle that improved the very thing it guards. */
    'const imgs = [...el.querySelectorAll("img")];' +
    'const box = el.getBoundingClientRect();' +
    'const bleeding = imgs.some((i) => {' +
    '  const r = i.getBoundingClientRect();' +
    '  return i.naturalWidth > 0 && r.width >= window.innerWidth - 2' +
    '         && r.height >= window.innerHeight - 2;' +
    '});' +
    'return {' +
    '  srcs: imgs.map((i) => (i.getAttribute("src") || "(none)").slice(-28) + "|nw=" + i.naturalWidth),' +
    '  covers: box.width >= window.innerWidth - 2 && box.height >= window.innerHeight - 2,' +
    '  artLoaded: imgs.some((i) => i.naturalWidth > 0),' +
    '  bleeding,' +
    '  controls: el.querySelectorAll("button").length,' +
    '  title: el.querySelector(".fsp__title")?.textContent || "" };'
  );
  if (!view) return record("now-playing view", false, "did not open");

  record("now-playing view opens", true, view.title);
  record("cover fills the app", view.covers);
  record("cover artwork loaded", view.artLoaded, (view.srcs || []).join(" ~ ") || "no img elements");
  record("artwork bleeds to the edges", view.bleeding);
  record("now-playing has transport controls", view.controls >= 5, view.controls + " controls");

  // Escape must close it: a view that covers everything has to be dismissible
  // without hunting for the control that does it.
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await wait(800);
  record("Escape closes the now-playing view", (await count(".fsp")) === 0);
}

/**
 * No control in the transport bar is inert.
 *
 * Written after a Lyrics button sat there doing nothing through several green
 * sweeps. A button with no handler is indistinguishable from a working one
 * until someone presses it.
 */
async function sweepNoDeadControls() {
  const rows = await js(
    'const bar = document.querySelector(".bar");' +
    'if (!bar) return { rows: [] };' +
    'const out = [];' +
    'for (const b of bar.querySelectorAll("button")) {' +
    '  const keys = Object.keys(b);' +
    '  const pk = keys.find((k) => k.startsWith("__reactProps$"));' +
    '  const fk = keys.find((k) => k.startsWith("__reactFiber$"));' +
    '  const props = pk ? b[pk] : null;' +
    '  const fiber = fk ? b[fk] : null;' +
    '  const handler = props?.onClick ?? fiber?.memoizedProps?.onClick;' +
    '  out.push({ label: b.getAttribute("aria-label") || b.textContent || "(unlabelled)",' +
    '             disabled: !!b.disabled, wired: typeof handler === "function",' +
    '             introspectable: !!(props || fiber) });' +
    '}' +
    'return { rows: out };'
  );

  if (!rows || rows.__error || !rows.rows) {
    return record("no dead controls in the transport bar", false, "could not inspect the bar");
  }

  /*
   * React internals are the only way to see a handler from outside, and the
   * key names are not part of any contract. If they cannot be read at all the
   * check has to say so rather than report every button as dead — a check
   * that fails loudly for the wrong reason is worse than no check.
   */
  const introspectable = rows.rows.filter((r) => r.introspectable);
  if (introspectable.length === 0) {
    return record("no dead controls in the transport bar", false,
      "React internals unreadable; check needs updating for this React version");
  }

  const dead = introspectable.filter((r) => !r.wired && !r.disabled).map((r) => r.label);
  record("no dead controls in the transport bar", dead.length === 0,
    dead.length ? dead.join(", ")
      : introspectable.length + " controls, all wired");
}

/**
 * Right-click menus.
 *
 * Opened on a real track row with a real context-menu event, because the
 * menu is mounted on demand: a check that only looked for the markup would
 * find nothing and conclude, wrongly, that nothing is there.
 */
async function sweepContextMenu() {
  // Needs a surface with track rows; the previous check leaves the app on
  // whatever it was testing, which may have none.
  await click('.sidebar a[href="#/"]');
  await wait(600);
  const onLiked = await js(
    'const el = [...document.querySelectorAll(".libitem")]' +
    '  .find((a) => /Liked/i.test(a.textContent || ""));' +
    'if (!el) return false; el.click(); return true;'
  );
  if (!onLiked) await click(".libitem");
  await wait(2600);

  const opened = await js(
    'const row = document.querySelector(".trackrow");' +
    'if (!row) return { ok: false, why: "no track row on screen" };' +
    'const r = row.getBoundingClientRect();' +
    'row.dispatchEvent(new MouseEvent("contextmenu", {' +
    '  bubbles: true, cancelable: true,' +
    '  clientX: Math.round(r.x + 40), clientY: Math.round(r.y + r.height / 2) }));' +
    'await new Promise((res) => setTimeout(res, 400));' +
    'const menu = document.querySelector(".ctxmenu");' +
    'if (!menu) return { ok: false, why: "no menu appeared" };' +
    'const items = [...menu.querySelectorAll(".ctxmenu__item")].map((b) => b.textContent);' +
    'const box = menu.getBoundingClientRect();' +
    'return { ok: true, items,' +
    '         onScreen: box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1 };'
  );

  if (!opened || opened.__error || !opened.ok) {
    return record("right-click menu", false, opened?.why ?? opened?.__error ?? "failed");
  }
  record("right-click menu opens", true, opened.items.length + " items");
  record("menu stays on screen", opened.onScreen);

  // The actions people actually look for in a player.
  const want = ["Add to queue", "Play next", "Go to song radio"];
  const missing = want.filter((w) => !opened.items.some((i) => (i || "").includes(w)));
  record("menu offers the core actions", missing.length === 0,
    missing.length ? "missing: " + missing.join(", ") : opened.items.slice(0, 4).join(" / "));

  // Escape must dismiss it, or a stray right-click traps the pointer.
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await wait(500);
  record("Escape closes the menu", (await count(".ctxmenu")) === 0);
}

/**
 * Crossfade.
 *
 * The setting existed and wrote to a value nothing read, so this asserts the
 * whole path: the screen writes it, the core stores it, and the core's target
 * asks for the transition it implies.
 */
async function sweepCrossfade() {
  const applied = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/session/settings", {' +
    '  method: "POST", headers: { "Content-Type": "application/json" },' +
    '  body: JSON.stringify({ crossfadeMs: 6000, gapless: true }) });' +
    'if (!r.ok) return { ok: false, status: r.status };' +
    'const p = await r.json();' +
    'return { ok: true, kind: p.target?.Transition?.Kind, ms: p.target?.Transition?.Ms };'
  );
  if (!applied || applied.__error || !applied.ok) {
    return record("crossfade setting reaches the core", false,
      applied?.__error ?? ("HTTP " + applied?.status));
  }
  record("crossfade setting reaches the core", applied.kind === "crossfade" && applied.ms === 6000,
    applied.kind + " " + applied.ms + "ms");

  // And back off again, so the sweep leaves nothing behind.
  const off = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/session/settings", {' +
    '  method: "POST", headers: { "Content-Type": "application/json" },' +
    '  body: JSON.stringify({ crossfadeMs: 0, gapless: true }) });' +
    'const p = await r.json();' +
    'return { kind: p.target?.Transition?.Kind };'
  );
  record("gapless when crossfade is off", off?.kind === "gapless", off?.kind ?? "unknown");
}

/** Two decks exist, which is what a crossfade needs. */
async function sweepDecks() {
  const decks = await js('return document.querySelectorAll("audio").length;');
  // The engine's elements are created with new Audio() and never attached, so
  // this counts only what the page itself mounts. Reported, not asserted.
  void decks;
  const radio = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/home");' +
    'const page = await r.json();' +
    'for (const sh of (page.shelves || [])) {' +
    '  for (const it of (sh.items || [])) {' +
    '    if (it.kind === "track" && it.track?.id) {' +
    '      const q = await fetch("http://127.0.0.1:8674/v1/radio/" + it.track.id);' +
    '      return { status: q.status, n: q.ok ? (await q.json()).length : 0 };' +
    '    }' +
    '  }' +
    '}' +
    'return { status: 0, n: 0 };'
  );
  record("song radio endpoint", radio?.status === 200, (radio?.n ?? 0) + " tracks");
}

/**
 * Podcasts.
 *
 * YouTube Music carries these as a first-class kind and the parser used to
 * discard them, so a search for a show returned nothing at all. Checked
 * end to end: the filter returns shows, a show page has episodes, and an
 * episode streams — episodes are videos upstream, so they play like tracks.
 */
async function sweepPodcasts() {
  const found = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/search?q=harman&filter=podcasts");' +
    'if (!r.ok) return { ok: false, status: r.status };' +
    'const res = await r.json();' +
    'const shows = [];' +
    'for (const sh of (res.shelves || []))' +
    '  for (const it of (sh.items || []))' +
    '    if (it.kind === "podcast" && it.podcast?.id) shows.push(it.podcast);' +
    'return { ok: true, n: shows.length, first: shows[0] || null };'
  );
  if (!found || found.__error || !found.ok) {
    return record("podcast search", false, found?.__error ?? ("HTTP " + found?.status));
  }
  record("podcast search returns shows", found.n > 0, found.n + " shows");
  if (!found.first) return;

  const show = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/podcasts/" + encodeURIComponent(' +
    JSON.stringify(found.first.id) + '));' +
    'if (!r.ok) return { ok: false, status: r.status };' +
    'const p = await r.json();' +
    'const eps = p.episodes || [];' +
    'return { ok: true, title: p.title, n: eps.length, first: eps[0] || null };'
  );
  if (!show || show.__error || !show.ok) {
    return record("podcast page", false, show?.__error ?? ("HTTP " + show?.status));
  }
  record("podcast page has episodes", show.n > 0, show.title + ": " + show.n + " episodes");

  if (show.first) {
    // A view count must never be shown where a publication date belongs.
    const pub = show.first.publishedText || "";
    record("episode dates are dates", !/views|plays/i.test(pub), pub || "(none)");

    const played = await js(
      'const r = await fetch("http://127.0.0.1:8674/v1/stream/" + encodeURIComponent(' +
      JSON.stringify(show.first.id) + '), { headers: { Range: "bytes=0-2047" } });' +
      'return { status: r.status };'
    );
    record("episode streams", played?.status === 206 || played?.status === 200,
      "HTTP " + played?.status);
  }

  // Episodes have their own filter too.
  const eps = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/search?q=harman&filter=episodes");' +
    'if (!r.ok) return { ok: false, status: r.status };' +
    'const res = await r.json();' +
    'let n = 0;' +
    'for (const sh of (res.shelves || []))' +
    '  for (const it of (sh.items || [])) if (it.kind === "episode") n += 1;' +
    'return { ok: true, n };'
  );
  record("episode search returns episodes", eps?.ok && eps.n > 0, (eps?.n ?? 0) + " episodes");
}

/** YouTube publishes a monthly audience figure; it was assumed not to exist. */
async function sweepMonthlyListeners() {
  const got = await js(
    'for (const q of ["radiohead", "daft punk"]) {' +
    '  const r = await fetch("http://127.0.0.1:8674/v1/search?q=" + encodeURIComponent(q) + "&filter=artists");' +
    '  if (!r.ok) continue;' +
    '  const res = await r.json();' +
    '  for (const sh of (res.shelves || []))' +
    '    for (const it of (sh.items || []))' +
    '      if (it.kind === "artist" && it.artist?.id) {' +
    '        const a = await fetch("http://127.0.0.1:8674/v1/artists/" + encodeURIComponent(it.artist.id));' +
    '        if (!a.ok) continue;' +
    '        const art = await a.json();' +
    '        return { monthly: art.monthlyListeners || "", subs: art.subscribers || "" };' +
    '      }' +
    '}' +
    'return null;'
  );
  record("artist monthly listeners", Boolean(got && !got.__error && got.monthly),
    got?.monthly || "(none)");
}


/**
 * Do the lyrics follow the song?
 *
 * The check above accepts "this track has no lyrics", which is a real and
 * common answer — and which hid the complaint that mattered: lyrics that
 * exist but never advance. This plays a track known to have timings, seeks
 * past the intro, and watches the highlighted line change.
 */
async function sweepLyricsFollow() {
  if (throttled) return;

  const started = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/search?q=radiohead%20creep&filter=songs");' +
    'if (!r.ok) return { ok: false };' +
    'const res = await r.json();' +
    'let t = null;' +
    'for (const sh of (res.shelves || []))' +
    '  for (const it of (sh.items || [])) if (it.kind === "track" && !t) t = it.track;' +
    'if (!t) return { ok: false };' +
    'const c = await fetch("http://127.0.0.1:8674/v1/session/command", {' +
    '  method: "POST", headers: { "Content-Type": "application/json" },' +
    '  body: JSON.stringify({ deviceId: localStorage.getItem("spotifier.deviceId"),' +
    '    command: { Kind: "play", Tracks: [t], StartIndex: 0, Origin: "sweep" } }) });' +
    'return { ok: c.ok, id: t.id, title: t.title };'
  );
  if (!started || started.__error || !started.ok) {
    return record("lyrics follow the song", false, "could not start a known-timed track");
  }
  await wait(6000);

  // Seek past the intro: before the first line, "no active line" is correct.
  await js(
    'await fetch("http://127.0.0.1:8674/v1/session/command", {' +
    '  method: "POST", headers: { "Content-Type": "application/json" },' +
    '  body: JSON.stringify({ deviceId: localStorage.getItem("spotifier.deviceId"),' +
    '    command: { Kind: "seek", PositionMs: 45000 } }) });'
  );
  await wait(4000);

  await click('.bar [aria-label="Lyrics"]');
  await wait(4000);

  const read = () => js(
    'const a = document.querySelector("li[data-state=\\"active\\"] .lyrics__line");' +
    'return { active: a ? a.textContent.slice(0, 40) : null,' +
    '         lines: document.querySelectorAll(".lyrics__line").length };'
  );

  const first = await read();
  if (!first || first.__error || first.lines === 0) {
    return record("lyrics follow the song", false, "no timed lines rendered");
  }
  record("timed lyrics render", first.lines > 0, first.lines + " lines");
  record("a line is highlighted", Boolean(first.active), first.active || "(none)");

  await wait(9000);
  const later = await read();
  record("the highlight advances with the song",
    Boolean(later?.active) && later.active !== first.active,
    JSON.stringify(first.active) + " -> " + JSON.stringify(later?.active));

  await click('.bar [aria-label="Lyrics"]');
  await wait(600);
}


/**
 * Does the volume slider change the sound?
 *
 * The session recorded every change correctly while the audio played straight
 * past the mixer, so a check on state alone passed throughout. This reads the
 * graph's gain and its measured level instead.
 */
async function sweepVolume() {
  if (throttled) return;

  /*
   * Normalisation off first, so this measures one thing.
   *
   * The master gain carries the volume taper and the loudness leveller
   * multiplied together. With normalisation on, a track that publishes no
   * loudness leaves the leveller running and the reading drifts — which made
   * this check fail with a number that was not wrong, just not the taper.
   * sweepNormalization turns it back on for its own checks.
   */
  await js('location.hash = "#/settings";');
  await wait(1400);
  await js(
    `const sw = [...document.querySelectorAll('button[role="switch"]')]` +
    '  .find((b) => /volume normalization/i.test(b.getAttribute("aria-label") || ""));' +
    'if (sw && sw.getAttribute("aria-checked") === "true") sw.click();'
  );
  await wait(900);
  await goHome();

  const read = () => js(
    'const r = await fetch("http://127.0.0.1:8674/v1/session");' +
    'const s = await r.json();' +
    'return { session: s.state?.volume, audio: window.__audio ? window.__audio() : null };'
  );

  const before = await read();
  if (!before || before.__error) return record("volume", false, "could not read the session");

  const moved = await js(
    'const inputs = [...document.querySelectorAll(".bar input[type=range]")];' +
    'const vol = inputs.find((i) => (i.getAttribute("aria-label") || "").toLowerCase().includes("volume"));' +
    'if (!vol) return false;' +
    'const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;' +
    'set.call(vol, "30");' +
    'vol.dispatchEvent(new Event("input", { bubbles: true }));' +
    'vol.dispatchEvent(new Event("change", { bubbles: true }));' +
    'return true;'
  );
  if (!moved || moved.__error) return record("volume", false, "no volume slider");

  await wait(2500);
  const after = await read();
  record("volume reaches the session", Math.abs((after?.session ?? 1) - 0.3) < 0.05,
    before?.session + " -> " + after?.session);

  /*
   * The graph gets a gain, not the slider position.
   *
   * These used to be asserted equal, which is exactly the bug: wired straight
   * through, the slider's whole top half barely changes anything and every
   * useful quiet level is crammed into the bottom fifth. At 30% the gain is
   * now 0.3^(1/0.6), about -17 dB.
   */
  const gain = after?.audio?.master;
  const want30 = Math.pow(0.3, 1 / 0.6);
  record("volume is tapered before it reaches the audio graph",
    typeof gain === "number" && Math.abs(gain - want30) < 0.02,
    "master gain " + (gain ?? "(no graph)") + ", want ~" + want30.toFixed(3));

  /*
   * And the taper is the perceptual one.
   *
   * Sampled rather than asserted at a single point, because a curve that is
   * merely "not linear" can still be the wrong shape. Halfway along has to be
   * about half as loud, which is ten decibels down, and the whole range has
   * to keep rising.
   */
  const curve = await js(
    'const inputs = [...document.querySelectorAll(".bar input[type=range]")];' +
    'const vol = inputs.find((i) => (i.getAttribute("aria-label") || "").toLowerCase().includes("volume"));' +
    'if (!vol) return null;' +
    'const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;' +
    'const out = [];' +
    'for (const pos of [10, 25, 50, 75, 100]) {' +
    '  set.call(vol, String(pos));' +
    '  vol.dispatchEvent(new Event("input", { bubbles: true }));' +
    '  await new Promise((r) => setTimeout(r, 450));' +
    '  out.push({ pos, gain: window.__audio ? window.__audio().master : null });' +
    '}' +
    'return out;'
  );

  if (!Array.isArray(curve) || curve.some((c) => typeof c.gain !== "number")) {
    record("the volume curve is perceptual", false, "could not sample the graph");
  } else {
    const at = (pos) => curve.find((c) => c.pos === pos).gain;
    const rising = curve.every((c, i) => i === 0 || c.gain > curve[i - 1].gain);
    // Ten decibels below full scale is the classic "half as loud".
    const halfDb = 20 * Math.log10(at(50) / at(100));
    record("the volume curve is perceptual",
      rising && Math.abs(halfDb + 10) < 1.5,
      curve.map((c) => c.pos + "%:" + c.gain.toFixed(3)).join(" ") +
        " — halfway is " + halfDb.toFixed(1) + " dB");
  }

  // Put it back, so the sweep leaves the player as it found it.
  await js(
    'const inputs = [...document.querySelectorAll(".bar input[type=range]")];' +
    'const vol = inputs.find((i) => (i.getAttribute("aria-label") || "").toLowerCase().includes("volume"));' +
    'if (!vol) return;' +
    'const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;' +
    'set.call(vol, "100");' +
    'vol.dispatchEvent(new Event("input", { bubbles: true }));'
  );
  await wait(800);
}


/**
 * Playlist editing, end to end against the real account.
 *
 * These four operations were implemented in the core and unreachable for
 * months — no route, no control — which no test could have caught, because
 * everything that existed worked. The sweep now creates a playlist, adds a
 * track, removes it and deletes the playlist, so the whole path is exercised
 * and nothing is left behind on the account.
 */
async function sweepPlaylistEditing() {
  const name = "Spotifier sweep " + Date.now();

  /*
   * Values are handed to the page as one JSON object rather than spliced into
   * the script a piece at a time.
   *
   * Building these strings by concatenation put an uninterpolated
   * `" + JSON.stringify(id) + "` inside a quoted string, so the request went
   * to a nonsense URL and a working feature was reported broken twice.
   */
  const run = (ctx, code) =>
    js("const c = " + JSON.stringify(ctx) + ";\n" + code);

  const created = await run({ name }, [
    'const r = await fetch("http://127.0.0.1:8674/v1/me/playlists", {',
    '  method: "POST", headers: { "Content-Type": "application/json" },',
    '  body: JSON.stringify({ title: c.name, description: "temporary", public: false }) });',
    'if (!r.ok) return { ok: false, status: r.status };',
    'return { ok: true, id: (await r.json()).id };',
  ].join("\n"));

  if (!created || created.__error || !created.ok) {
    return record("create a playlist", false, created?.__error ?? ("HTTP " + created?.status));
  }
  record("create a playlist", Boolean(created.id), created.id);

  const trackId = await js([
    'const r = await fetch("http://127.0.0.1:8674/v1/search?q=radiohead%20creep&filter=songs");',
    'const res = await r.json();',
    'for (const sh of (res.shelves || []))',
    '  for (const it of (sh.items || [])) if (it.kind === "track") return it.track.id;',
    'return null;',
  ].join("\n"));

  let item = null;
  if (trackId && !trackId.__error) {
    const added = await run({ id: created.id, trackId }, [
      'const base = "http://127.0.0.1:8674/v1/me/playlists/" + encodeURIComponent(c.id);',
      'const r = await fetch(base + "/tracks", {',
      '  method: "POST", headers: { "Content-Type": "application/json" },',
      '  body: JSON.stringify({ trackIds: [c.trackId] }) });',
      'if (!r.ok) return { ok: false, status: r.status };',
      // Upstream takes a few seconds to reflect an addition to a playlist it
      // has only just created, so this polls rather than sleeping once.
      'let pl = { tracks: [] };',
      'for (let i = 0; i < 12; i += 1) {',
      '  await new Promise((s) => setTimeout(s, 1200));',
      '  const p = await fetch("http://127.0.0.1:8674/v1/playlists/" + encodeURIComponent(c.id));',
      '  if (p.ok) { pl = await p.json(); if ((pl.tracks || []).length > 0) break; }',
      '}',
      'return { ok: true, n: (pl.tracks || []).length, item: (pl.tracks || [])[0] || null };',
    ].join("\n"));

    record("add a track to a playlist", Boolean(added?.ok) && (added?.n ?? 0) > 0,
      added?.ok ? (added.n + " tracks after adding") : ("HTTP " + added?.status));
    item = added?.item ?? null;
  }

  if (item?.playlistItemId) {
    const removed = await run(
      { id: created.id, trackId, itemId: item.playlistItemId },
      [
        'const base = "http://127.0.0.1:8674/v1/me/playlists/" + encodeURIComponent(c.id);',
        'const r = await fetch(base + "/tracks", {',
        '  method: "DELETE", headers: { "Content-Type": "application/json" },',
        '  body: JSON.stringify({ items: [{ trackId: c.trackId, itemId: c.itemId }] }) });',
        'return { ok: r.ok, status: r.status };',
      ].join("\n"));
    record("remove a track from a playlist", Boolean(removed?.ok), "HTTP " + removed?.status);
  } else {
    record("remove a track from a playlist", false, "no membership handle on the added track");
  }

  const deleted = await run({ id: created.id }, [
    'const r = await fetch("http://127.0.0.1:8674/v1/me/playlists/" + encodeURIComponent(c.id),',
    '  { method: "DELETE" });',
    'return { ok: r.ok, status: r.status };',
  ].join("\n"));
  record("delete a playlist", Boolean(deleted?.ok), "HTTP " + deleted?.status);
}

/** Pinning and folders, which had storage and sorting long before any write. */
async function sweepOrganise() {
  const folder = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/me/folders", {' +
    '  method: "POST", headers: { "Content-Type": "application/json" },' +
    '  body: JSON.stringify({ name: "Sweep folder" }) });' +
    'if (!r.ok) return { ok: false, status: r.status };' +
    'return { ok: true, id: (await r.json()).id };'
  );
  record("create a folder", Boolean(folder?.ok), folder?.id ?? ("HTTP " + folder?.status));
  if (!folder?.ok) return;

  const pinned = await js(
    'const lib = await fetch("http://127.0.0.1:8674/v1/me/library");' +
    'const items = lib.ok ? await lib.json() : [];' +
    'if (items.length === 0) return { ok: false, why: "empty library" };' +
    'const it = items[0];' +
    'const r = await fetch("http://127.0.0.1:8674/v1/me/library/organise", {' +
    '  method: "POST", headers: { "Content-Type": "application/json" },' +
    '  body: JSON.stringify({ kind: it.kind, itemId: it.id, pinned: true }) });' +
    'if (!r.ok) return { ok: false, status: r.status };' +
    'const after = await fetch("http://127.0.0.1:8674/v1/me/library");' +
    'const rows = after.ok ? await after.json() : [];' +
    'const me = rows.find((x) => x.id === it.id);' +
    'return { ok: true, pinned: !!me?.pinned, first: rows[0]?.id === it.id, title: it.title };'
  );
  record("pin a library item", Boolean(pinned?.ok) && pinned.pinned === true,
    pinned?.title ?? pinned?.why ?? ("HTTP " + pinned?.status));
  // A pin that does not change the order is not a pin.
  record("a pinned item sorts to the top", pinned?.first === true);

  // Put it back, so the sweep leaves the library as it found it.
  await js(
    'const lib = await fetch("http://127.0.0.1:8674/v1/me/library");' +
    'const items = lib.ok ? await lib.json() : [];' +
    'if (items.length === 0) return;' +
    'const it = items[0];' +
    'await fetch("http://127.0.0.1:8674/v1/me/library/organise", {' +
    '  method: "POST", headers: { "Content-Type": "application/json" },' +
    '  body: JSON.stringify({ kind: it.kind, itemId: it.id, pinned: false }) });'
  );
  await js(
    'await fetch("http://127.0.0.1:8674/v1/me/folders/" + encodeURIComponent(' +
    JSON.stringify(folder.id) + '), { method: "DELETE" });'
  );
}


/**
 * The equaliser.
 *
 * Advertised in the engine's capabilities for a long time with nothing behind
 * it, so the check is that a band actually reaches the audio graph — the
 * sliders moving proves only that sliders move.
 */
async function sweepEqualiser() {
  await js('location.hash = "#/settings";');
  await wait(2000);

  const bands = await count(".eq__band input[type=range]");
  record("equaliser has bands", bands > 0, bands + " bands");
  if (bands === 0) return;

  const applied = await js([
    'const inputs = [...document.querySelectorAll(".eq__band input[type=range]")];',
    'const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;',
    'set.call(inputs[0], "8");',
    'inputs[0].dispatchEvent(new Event("input", { bubbles: true }));',
    'await new Promise((r) => setTimeout(r, 1200));',
    'return { shows: inputs[0].value, audio: window.__audio ? window.__audio() : null };',
  ].join("\n"));
  record("an equaliser band changes the graph",
    Boolean(applied?.audio) && applied.shows === "8",
    "band 0 at " + applied?.shows + " dB, graph " + (applied?.audio ? "present" : "absent"));

  // Flat again, so the sweep leaves the sound as it found it.
  await js([
    'const preset = [...document.querySelectorAll(".eq__presets .chip")]',
    '  .find((b) => (b.textContent || "").trim() === "Flat");',
    'preset?.click();',
  ].join("\n"));
  await wait(600);
}

/** Recent searches, which nothing stored before. */
async function sweepRecentSearches() {
  await click('.sidebar a[href="#/search"]');
  await wait(1000);
  await typeText(".searchfield input", "portishead");
  await wait(2600);

  // Clear the field: recent searches only show with nothing typed.
  await js([
    'const i = document.querySelector(".searchfield input");',
    'const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;',
    'set.call(i, "");',
    'i.dispatchEvent(new Event("input", { bubbles: true }));',
  ].join("\n"));
  await wait(1600);

  const items = await js([
    'const list = [...document.querySelectorAll(".recents__item")].map((b) => b.textContent.trim());',
    'return { list };',
  ].join("\n"));
  record("recent searches are remembered",
    (items?.list ?? []).some((t) => /portishead/i.test(t)),
    (items?.list ?? []).join(", ") || "(none)");

  // Reopening one must restore the query, not just show the word.
  const restored = await js([
    'const b = [...document.querySelectorAll(".recents__item")]',
    '  .find((x) => /portishead/i.test(x.textContent || ""));',
    'if (!b) return null;',
    'b.click();',
    'await new Promise((r) => setTimeout(r, 1800));',
    'return { hash: location.hash, value: document.querySelector(".searchfield input")?.value };',
  ].join("\n"));
  record("a recent search reopens", /portishead/i.test(restored?.value ?? ""),
    restored?.value ?? "(nothing)");
}

/** Cards offer what rows do. */
async function sweepCardMenu() {
  await goHome();
  const opened = await js([
    'const card = document.querySelector(".card");',
    'if (!card) return { ok: false, why: "no card on the home page" };',
    'const r = card.getBoundingClientRect();',
    'card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,',
    '  clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 20) }));',
    'await new Promise((s) => setTimeout(s, 500));',
    'const m = document.querySelector(".ctxmenu");',
    'if (!m) return { ok: false, why: "no menu appeared" };',
    'return { ok: true, items: [...m.querySelectorAll(".ctxmenu__item")].map((b) => b.textContent) };',
  ].join("\n"));

  record("right-click a card", Boolean(opened?.ok),
    opened?.ok ? (opened.items.length + " items: " + opened.items.slice(0, 3).join(" / "))
               : (opened?.why ?? "failed"));

  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await wait(500);
}

/**
 * Following an artist.
 *
 * Followed and then unfollowed in the same check, so the account is left as it
 * was — a sweep that quietly follows an artist on every run is worse than no
 * check.
 */
async function sweepFollow() {
  const result = await js([
    'const r = await fetch("http://127.0.0.1:8674/v1/search?q=portishead&filter=artists");',
    'if (!r.ok) return { ok: false, status: r.status };',
    'const res = await r.json();',
    'let artist = null;',
    'for (const sh of (res.shelves || []))',
    '  for (const it of (sh.items || [])) if (it.kind === "artist" && !artist) artist = it.artist;',
    'if (!artist) return { ok: false, why: "no artist found" };',
    'const url = "http://127.0.0.1:8674/v1/me/artists/" + encodeURIComponent(artist.id) + "/follow";',
    'const on = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },',
    '  body: JSON.stringify({ follow: true }) });',
    'const off = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },',
    '  body: JSON.stringify({ follow: false }) });',
    'return { ok: true, name: artist.name, follow: on.status, unfollow: off.status };',
  ].join("\n"));

  record("follow and unfollow an artist",
    Boolean(result?.ok) && result.follow === 204 && result.unfollow === 204,
    result?.ok ? (result.name + ": " + result.follow + "/" + result.unfollow)
               : (result?.why ?? ("HTTP " + result?.status)));
}


/**
 * Keyboard shortcuts.
 *
 * Driven with real key events, because a synthetic one is not trusted input
 * and several of these end in playback. Checked by their effect rather than
 * by the table in settings: a documented shortcut that does nothing is the
 * failure worth catching.
 */
async function sweepShortcuts() {
  const press = async (key, mods = {}) => {
    // Synthetic key events go to the focused window, so a window that lost
    // focus swallowed them and these checks failed at random.
    win.focus();
    const ev = { type: "keyDown", keyCode: key, modifiers: [], ...mods };
    win.webContents.sendInputEvent(ev);
    win.webContents.sendInputEvent({ ...ev, type: "keyUp" });
    await wait(700);
  };

  await goHome();

  // Navigation: a plain letter must not fire while typing, and Alt+Shift+H
  // must reach home from anywhere.
  await js('location.hash = "#/settings";');
  await wait(1200);
  await press("H", { modifiers: ["alt", "shift"] });
  const home = await route();
  record("shortcut: home", home === "#/" || home === "", home || "(root)");

  await press("L", { modifiers: ["alt", "shift"] });
  record("shortcut: your listening", (await route()).includes("stats"), await route());

  // Ctrl+K focuses the search field, which is what makes it worth binding.
  await press("k", { modifiers: ["control"] });
  await wait(600);
  const focused = await js(
    'const el = document.activeElement;' +
    'return { tag: el?.tagName, inSearch: !!el?.closest?.(".searchfield") };'
  );
  record("shortcut: focus search", Boolean(focused?.inSearch),
    focused?.tag ?? "(nothing focused)");

  // A letter typed into that field must insert text, not run a shortcut.
  await js(
    'const i = document.querySelector(".searchfield input");' +
    'const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;' +
    'set.call(i, ""); i.dispatchEvent(new Event("input", { bubbles: true })); i.focus();'
  );
  const before = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/session");' +
    'return { shuffle: (await r.json()).state?.shuffle };'
  );
  win.webContents.sendInputEvent({ type: "char", keyCode: "s" });
  await wait(900);
  const after = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/session");' +
    'const i = document.querySelector(".searchfield input");' +
    'return { shuffle: (await r.json()).state?.shuffle, typed: i?.value };'
  );
  record("typing is never intercepted",
    after?.shuffle === before?.shuffle && (after?.typed ?? "").includes("s"),
    "field now " + JSON.stringify(after?.typed ?? ""));

  // Clear the field so later checks start clean.
  await js(
    'const i = document.querySelector(".searchfield input");' +
    'const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;' +
    'set.call(i, ""); i.dispatchEvent(new Event("input", { bubbles: true })); i.blur();'
  );
  await wait(500);

  await goHome();
  await press("f");
  record("shortcut: full screen", (await count(".fsp")) > 0);
  await press("Escape");
  await wait(500);

  await press("l");
  const lyricsOpen = (await count(".lyricspanel")) > 0;
  record("shortcut: lyrics", lyricsOpen);
  if (lyricsOpen) {
    await press("l");
    await wait(400);
  }
}

/** The "…" menu on an entity page, which its card had and the page did not. */
async function sweepEntityMenu() {
  const found = await js(
    'for (const q of ["radiohead", "daft punk", "in rainbows"]) {' +
    '  const r = await fetch("http://127.0.0.1:8674/v1/search?q=" + encodeURIComponent(q) + "&filter=albums");' +
    '  if (!r.ok) continue;' +
    '  const res = await r.json();' +
    '  for (const sh of (res.shelves || []))' +
    '    for (const it of (sh.items || [])) if (it.kind === "album") return it.album.id;' +
    '}' +
    'return null;'
  );
  if (!found || found.__error) return record("entity menu", false, "no album to open");

  await js('location.hash = "#/album/" + encodeURIComponent(' + JSON.stringify(found) + ');');
  await wait(3200);

  const opened = await click('.entityactions__more');
  if (!opened) return record("entity menu", false, "no more-options button on the page");
  await wait(600);

  const items = await js(
    'const m = document.querySelector(".ctxmenu");' +
    'if (!m) return null;' +
    'return [...m.querySelectorAll(".ctxmenu__item")].map((b) => b.textContent);'
  );
  record("entity menu opens", Array.isArray(items) && items.length > 0,
    Array.isArray(items) ? items.slice(0, 3).join(" / ") : "no menu");
  record("entity menu can queue the whole thing",
    Array.isArray(items) && items.some((t) => /Add to queue/i.test(t || "")));

  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await wait(400);
}

/** The artist biography, its source link, and the related-artist artwork. */
async function sweepArtistAbout() {
  const found = await js(
    'const r = await fetch("http://127.0.0.1:8674/v1/search?q=radiohead&filter=artists");' +
    'if (!r.ok) return null;' +
    'const res = await r.json();' +
    'for (const sh of (res.shelves || []))' +
    '  for (const it of (sh.items || [])) if (it.kind === "artist") return it.artist.id;' +
    'return null;'
  );
  if (!found || found.__error) return record("artist about", false, "no artist to open");

  await js('location.hash = "#/artist/" + encodeURIComponent(' + JSON.stringify(found) + ');');
  await wait(3500);

  const about = await js(
    'const el = document.querySelector(".about__text");' +
    'const src = document.querySelector(".about__source a");' +
    // Related-artist cards drew five empty circles while the artwork sat in
    // the response, discarded by narrowing them to a name and an identifier.
    'await new Promise((r) => setTimeout(r, 1500));' +
    'const related = [...document.querySelectorAll(".shelf")]' +
    '  .find((s) => /fans also like/i.test(s.textContent || ""));' +
    'const imgs = related ? [...related.querySelectorAll("img")] : [];' +
    'return { chars: (el?.textContent || "").length,' +
    '         clamped: el?.hasAttribute("data-clamped") ?? false,' +
    '         source: src?.textContent || "",' +
    '         relatedImages: imgs.length,' +
    '         loaded: imgs.filter((i) => i.naturalWidth > 0).length };'
  );

  record("artist biography", (about?.chars ?? 0) > 0, (about?.chars ?? 0) + " chars");
  record("a long biography is clamped", about?.clamped === true);
  record("biography names its source", (about?.source ?? "").length > 0,
    about?.source || "(none)");
  record("fans-also-like artwork loads",
    (about?.relatedImages ?? 0) > 0 && about.loaded === about.relatedImages,
    (about?.loaded ?? 0) + "/" + (about?.relatedImages ?? 0) + " images");
}


async function sweepSettings() {
  await click('.topbar [aria-label="Settings"]');
  await wait(1200);
  const body = await text();
  record("settings page", /Settings/.test(body) && !/does not exist/i.test(body));
}

async function sweepQueue() {
  const ok = await click('.bar [aria-label*="queue" i]');
  if (!ok) return record("queue panel", false, "no queue control");
  await wait(900);
  const panel = await count(".nowplaying");
  record("queue panel", panel > 0);
}

async function sweepMixes() {
  const res = await js(`
    const r = await fetch("http://127.0.0.1:${PORT}/v1/me/mixes");
    return { ok: r.ok, status: r.status, n: r.ok ? (await r.json()).length : 0 };
  `);
  record("generated mixes", res.ok, res.ok ? `${res.n} mixes` : `HTTP ${res.status}`);
}

async function sweepBrowse() {
  await goHome();
  if (!(await click(".shelf__showall"))) {
    return record("browse (show all)", false, "no show-all link on the home page");
  }
  // These pages carry many more cards than a shelf does, so they take longer
  // to paint than the previous timing allowed.
  await wait(3500);

  const content = await js(
    'return { shelves: document.querySelectorAll(".shelf").length,' +
    '         cards: document.querySelectorAll(".card").length,' +
    '         rows: document.querySelectorAll(".trackrow").length };'
  );
  const items = (content?.cards ?? 0) + (content?.rows ?? 0);

  /*
   * "Not a not-found page" is not the same as "has anything on it".
   *
   * A show-all surface rendered its title and nothing else, because those
   * pages carry a bare grid with no shelf renderer and the parser only looked
   * for shelves. The old check passed on it throughout.
   */
  record("browse (show all)", !(await notFound()) && items > 0,
    (await route()) + " — " + (content?.shelves ?? 0) + " shelves, " + items + " items");

  /*
   * One heading, not two.
   *
   * A show-all surface is a single shelf named after the page it is on, so
   * the page printed the title and the shelf printed it again underneath.
   */
  const headings = await js(
    'const seen = [...document.querySelectorAll(".shelf__title")]' +
    '  .map((h) => (h.textContent || "").trim()).filter(Boolean);' +
    'const dupes = seen.filter((t, i) => seen.indexOf(t) !== i);' +
    'return { seen, dupes };'
  );
  record("show all names itself once",
    Array.isArray(headings?.dupes) && headings.dupes.length === 0,
    (headings?.seen || []).join(" / ") || "no heading");

  /*
   * And it shows everything.
   *
   * The page behind "Show all" laid its cards out as a single row, which
   * clipped it to the same handful the shelf already showed — so the link led
   * to a page with nothing new on it.
   *
   * Navigated to by name rather than by clicking whichever "Show all" home
   * happens to offer: that link sometimes leads to an artist's channel, which
   * has several shelves and is a landing page, so rows are right there and
   * the check failed on a page it was never about.
   */
  await js('location.hash = "#/browse/FEmusic_listen_again";');
  await wait(3500);

  const laidOut = await js(
    'const grid = document.querySelector(".shelf__grid");' +
    'if (!grid) return null;' +
    'const cards = [...grid.querySelectorAll(".card")];' +
    'const tops = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top / 20)));' +
    'return { cards: cards.length, rows: tops.size };'
  );
  record("show all wraps rather than clipping",
    (laidOut?.cards ?? 0) > 0 && (laidOut?.rows ?? 0) > 1,
    laidOut ? laidOut.cards + " cards over " + laidOut.rows + " rows"
            : "no grid on the page");
}

app.whenReady().then(async () => {
  ipcMain.handle("window:is-maximized", () => false);
  ipcMain.handle("core-port", () => PORT);
  ipcMain.on("window:minimize", () => {});
  ipcMain.on("window:close", () => {});
  ipcMain.on("window:toggle-maximize", () => {});

  try {
    await startCore();
  } catch (err) {
    console.log(`FAIL  core startup — ${err.message}`);
    app.exit(1);
    return;
  }

  win = new BrowserWindow({
    show: true,
    width: 1440,
    height: 900,
    frame: false,
    backgroundColor: "#0f0f0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });
  win.webContents.session.webRequest.onErrorOccurred((d) => {
    if (!d.url.startsWith("devtools:")) failedRequests.push(`${d.error} ${d.url}`);
  });
  // The renderer sees statuses the command line does not: a stream that curls
  // clean can still be refused in the page.
  win.webContents.session.webRequest.onCompleted((d) => {
    if (d.url.includes("/v1/stream/") && d.statusCode >= 400) {
      failedRequests.push(`HTTP ${d.statusCode} ${d.url}`);
    }
  });

  await win.loadFile(PAGE);
  // Console text says what broke but never where. Stacks do, and a crash that
  // takes out a whole subtree is otherwise diagnosed by guessing.
  await win.webContents.executeJavaScript(`
    window.__errors = [];
    window.addEventListener("error", (e) => {
      window.__errors.push(String(e.error?.stack || e.message));
    });
    window.addEventListener("unhandledrejection", (e) => {
      window.__errors.push(String(e.reason?.stack || e.reason));
    });
  `);
  await wait(4000);

  console.log("\n--- shell ---");
  await sweepShell();
  console.log("\n--- account ---");
  const signedIn = await sweepAccount();
  console.log("\n--- home ---");
  await sweepHome();
  console.log("\n--- playback ---");
  await sweepPlayback();
  console.log("");
  console.log("--- seek ---");
  await sweepSeek();
  console.log("");
  console.log("--- search ---");
  await sweepSearch();
  await sweepSearchFilters();
  await sweepStartLatency();
  await sweepResume();
  await sweepTooltips();
  await sweepCardOverflow();
  console.log("\n--- entity pages ---");
  await sweepArtistViaSearch();
  await sweepPlaylistDirect();
  await sweepAlbumViaSearch();
  console.log("\n--- browse ---");
  await sweepBrowse();
  if (signedIn) {
    console.log("\n--- library ---");
    await sweepLibrary();
  }
  console.log("\n--- statistics ---");
  await sweepStats();
  await sweepMixes();
  console.log("\n--- panels ---");
  await sweepQueue();
  await sweepLyrics();
  await sweepFullScreen();
  await sweepNoDeadControls();
  await sweepContextMenu();
  await sweepCrossfade();
  await sweepPodcasts();
  await sweepMonthlyListeners();
  await sweepLyricsFollow();
  await sweepVolume();
  await sweepMute();
  await sweepShare();
  await sweepDurationShown();
  await sweepSongCache();
  await sweepCrossfadeHeard();
  await sweepSkipCuts();
  await sweepRepeatOne();
  await sweepTopResult();
  await sweepRowButtons();
  await sweepNoRestart();
  await sweepRadio();
  await sweepAllTab();
  await sweepCardsOpen();
  await sweepLaunchPaused();
  await goHome();
  await sweepQueueEditing();
  await sweepNameLinks();
  await sweepOverlayVolume();
  await sweepVolumeBoost();
  await sweepNormalization();
  await sweepFollowState();
  await sweepPlaylistEditing();
  await sweepOrganise();
  await sweepFollow();
  await sweepCardMenu();
  await sweepRecentSearches();
  await sweepEqualiser();
  await sweepShortcuts();
  await sweepEntityMenu();
  await sweepArtistAbout();
  await sweepDecks();
  await sweepSettings();

  try {
    fs.writeFileSync(
      path.join(__dirname, "..", "sweep-final.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
  } catch { /* the report matters more than the picture */ }

  const stacks = await js(`return (window.__errors || []).slice(0, 4);`);
  if (stacks.length) {
    console.log("");
    console.log("STACKS:");
    for (const st of [...new Set(stacks)]) {
      console.log(st.split("\n").slice(0, 6).join("\n"));
      console.log("");
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (throttled) {
    console.log("");
    console.log("NOTE: upstream is rate-limiting this address, so playback was not");
    console.log("      exercised. Everything else above was.");
  }
  const benign = /Electron Security Warning|Autofill\.|devtools|ERR_ABORTED/i;
  const realErrors = [...new Set(consoleErrors)].filter((e) => !benign.test(e));

  console.log(`\n================ ${results.length - failed.length}/${results.length} passed ================`);
  if (failed.length) {
    console.log("FAILURES:");
    for (const f of failed) console.log(`  - ${f.feature}${f.detail ? ` (${f.detail})` : ""}`);
  }
  const streamReqs = [...new Set(failedRequests)];
  if (streamReqs.length) {
    console.log("FAILED REQUESTS:");
    for (const f of streamReqs.slice(0, 10)) console.log("   ", f);
  }
  if (realErrors.length) {
    console.log("CONSOLE ERRORS:");
    for (const e of realErrors.slice(0, 8)) console.log("   ", e.slice(0, 200));
  }

  win.destroy();
  // Killed outright: a plain kill left cores running on Windows, and the
  // next run then talked to the old one.
  await stopCore();
  app.exit(failed.length === 0 && realErrors.length === 0 ? 0 : 1);
});
