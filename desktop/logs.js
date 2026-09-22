/**
 * The app's log, and the diagnostics bundle users send when something breaks.
 *
 * Everything that has something to say ends up in one file, in the order it
 * happened: the core's output (which the main process already pipes), the
 * shell's own console, and the warnings and errors the page forwards. One
 * timeline is the point — "the track failed" in the page and "yt-dlp: HTTP
 * Error 403" in the core are only useful read side by side.
 *
 * The file lives in the data directory, rotates at a few megabytes, and is
 * scrubbed on the way in rather than on export: a log that holds cookies on
 * disk is a liability whether or not anyone ever sends it.
 */

const { app, shell } = require("electron");
const { spawn, execFile } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const MAX_BYTES = 2 * 1024 * 1024;
/** Rotated copies kept beside the live file: app.1.log is the newest. */
const KEEP = 3;
/** A single line longer than this is cut; a dumped response is not a log line. */
const MAX_LINE = 4000;

let dir = null;
let file = null;
let size = 0;

/* ---------- redaction ---------- */

/*
 * What must never reach the file.
 *
 * The session cookies are the account; a googlevideo URL is signed for this
 * machine's address and carries a token. Emails and the Windows user folder
 * are not secrets but they are not ours to collect either. Track titles and
 * video IDs stay: without them a log cannot say which song failed.
 */
const RULES = [
  [/\b(cookie|set-cookie|authorization|x-goog-authuser|x-goog-visitor-id|x-youtube-identity-token)(["']?\s*[:=]\s*)[^\r\n]+/gi, "$1$2<redacted>"],
  [/SAPISID(?:1P|3P)?HASH\s+\S+/g, "SAPISIDHASH <redacted>"],
  [
    /\b(__Secure-[\w-]+|__Host-[\w-]+|SID|HSID|SSID|APISID|SAPISID|SIDCC|LOGIN_INFO|NID|VISITOR_INFO1_LIVE|VISITOR_PRIVACY_METADATA|YSC|PREF)=[^;\s"',]+/g,
    "$1=<redacted>",
  ],
  // Netscape cookie-file lines (domain, flag, path, secure, expiry, name, value).
  [/(\.(?:youtube|google)\.com\t(?:[^\t\r\n]*\t){5})[^\t\r\n]+/gi, "$1<redacted>"],
  [/https?:\/\/[^\s"'<>]*googlevideo\.com[^\s"'<>]*/g, "https://…googlevideo.com/<redacted>"],
  [/([?&](?:sig|signature|lsig|pot|key|access_token|token|visitorData)=)[^&\s"']+/gi, "$1<redacted>"],
  [/("(?:visitorData|poToken|accessToken|refreshToken|sapisid)"\s*:\s*")[^"]*"/gi, '$1<redacted>"'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>"],
  [/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/g, "$1<user>"],
];

function redact(text) {
  let out = String(text);
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

/* ---------- the file ---------- */

function rotate() {
  try {
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = path.join(dir, `app.${i}.log`);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, `app.${i + 1}.log`));
    }
    if (fs.existsSync(file)) fs.renameSync(file, path.join(dir, "app.1.log"));
  } catch {
    /* a locked file only means this rotation waits for the next line */
  }
  size = 0;
}

/**
 * Appends lines from one source.
 *
 * Synchronous on purpose: the lines that matter most are the ones written just
 * before a crash, and a buffered stream loses exactly those.
 */
function write(source, level, text) {
  if (!file) return;
  const stamp = new Date().toISOString();
  const lines = redact(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}… (${l.length} chars)` : l))
    .map((l) => `${stamp} ${level.toUpperCase().padEnd(5)} [${source}] ${l}\n`)
    .join("");
  if (!lines) return;
  try {
    if (size + lines.length > MAX_BYTES) rotate();
    fs.appendFileSync(file, lines);
    size += Buffer.byteLength(lines);
  } catch {
    /* the disk refusing a log line must never take the app down */
  }
}

/**
 * Turns a pipe's chunks into whole lines.
 *
 * A pipe delivers chunks, not lines, so a message can arrive split across
 * two. Holding the tail until its newline keeps each entry on one line.
 */
function lines(onLine) {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString();
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    if (pending.length > MAX_LINE) {
      parts.push(pending);
      pending = "";
    }
    for (const line of parts) if (line.trim()) onLine(line);
  };
}

/** The core's slog output names its own level; the file should agree. */
function coreLevel(line) {
  const m = /\blevel=(DEBUG|INFO|WARN|ERROR)\b/.exec(line);
  return m ? m[1] : "info";
}

/** Wires a spawned core's output into the log, still echoing it to the terminal. */
function attachCore(child) {
  const toFile = (line) => write("core", coreLevel(line), line);
  const out = lines(toFile);
  const err = lines(toFile);
  child.stdout?.on("data", (b) => {
    process.stdout.write(`[core] ${b}`);
    out(b);
  });
  child.stderr?.on("data", (b) => {
    process.stderr.write(`[core] ${b}`);
    err(b);
  });
}

/*
 * The shell's own console goes to the file too.
 *
 * Every module here already reports through console.* with a [tag] prefix, so
 * wrapping the console collects all of it without touching any of them.
 */
function captureConsole() {
  const levels = { log: "info", info: "info", warn: "warn", error: "error" };
  for (const [method, level] of Object.entries(levels)) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      write("main", level, args.map(format).join(" "));
    };
  }
}

function format(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Opens the log. Called once, as early as possible, so startup is recorded.
 *
 * Each launch starts with a header naming the version and the machine, so a
 * log read on its own still says what it came from.
 */
function init(dataDir) {
  dir = path.join(dataDir, "logs");
  file = path.join(dir, "app.log");
  try {
    fs.mkdirSync(dir, { recursive: true });
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch {
    file = null;
    return;
  }
  if (size > MAX_BYTES / 2) rotate();
  captureConsole();
  write("main", "info", "-".repeat(60));
  write(
    "main",
    "info",
    `launch v${app.getVersion()} electron ${process.versions.electron} ` +
      `${os.type()} ${os.release()} ${os.arch()} locale=${app.getLocale()}`,
  );
}

/* ---------- from the page ---------- */

/*
 * Lines the page forwards.
 *
 * The renderer is the least trusted party here, so what it sends is bounded:
 * a fixed set of levels, a capped batch, capped lines, and a budget per
 * minute so a page stuck in an error loop cannot fill the disk.
 */
const PAGE_LEVELS = new Set(["debug", "info", "warn", "error"]);
const PAGE_BUDGET_PER_MIN = 600;
let pageBudget = PAGE_BUDGET_PER_MIN;
let pageDropped = 0;
setInterval(() => {
  if (pageDropped > 0) write("ui", "warn", `dropped ${pageDropped} lines over the rate limit`);
  pageBudget = PAGE_BUDGET_PER_MIN;
  pageDropped = 0;
}, 60_000).unref?.();

function fromPage(entries) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries.slice(0, 100)) {
    if (!entry || typeof entry.message !== "string") continue;
    if (pageBudget <= 0) {
      pageDropped++;
      continue;
    }
    pageBudget--;
    const level = PAGE_LEVELS.has(entry.level) ? entry.level : "info";
    write("ui", level, entry.message.slice(0, MAX_LINE));
  }
}

/* ---------- the bundle ---------- */

function run(file, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim()),
    );
  });
}

async function coreHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return `HTTP ${res.status}`;
    const body = await res.json();
    return `ok uptime=${body.uptime} signedIn=${Boolean(body.haveCredentials)}`;
  } catch (err) {
    return `unreachable (${err.message})`;
  }
}

function folderSize(p) {
  let total = 0;
  let count = 0;
  try {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      if (entry.isFile()) {
        total += fs.statSync(path.join(p, entry.name)).size;
        count++;
      }
    }
  } catch {
    return "none";
  }
  return `${count} files, ${Math.round(total / (1 << 20))} MB`;
}

/**
 * The summary that heads the bundle: what someone reading the log would ask
 * first. Nothing in it identifies the account.
 */
async function systemInfo({ dataDir, corePort, ytdlp, page }) {
  const version = ytdlp ? await run(ytdlp, ["--version"], 10000) : null;
  const info = [
    `Youtube Music Spotified diagnostics`,
    `created:     ${new Date().toISOString()} (local ${new Date().toString()})`,
    ``,
    `app:         ${app.getVersion()}${app.isPackaged ? "" : " (development)"}`,
    `electron:    ${process.versions.electron}  chrome ${process.versions.chrome}  node ${process.versions.node}`,
    `os:          ${os.type()} ${os.release()} ${os.arch()}`,
    `cpu:         ${os.cpus()[0]?.model ?? "unknown"} x${os.cpus().length}`,
    `memory:      ${Math.round(os.totalmem() / (1 << 30))} GB total, ${Math.round(os.freemem() / (1 << 20))} MB free`,
    `locale:      ${app.getLocale()}  timezone ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    ``,
    `core:        ${await coreHealth(corePort)}`,
    `yt-dlp:      ${ytdlp ? `${version ?? "did not answer --version"} at ${ytdlp}` : "not found"}`,
    `credentials: ${fs.existsSync(path.join(dataDir, "credentials.json")) ? "present" : "absent"}`,
    `yt cookies:  ${fs.existsSync(path.join(dataDir, "yt-dlp-cookies.txt")) ? "present" : "absent"}`,
    `song cache:  ${folderSize(path.join(dataDir, "audio-cache"))}`,
  ];
  if (page && typeof page === "object") {
    info.push(``, `page state:`, JSON.stringify(page, null, 2));
  }
  return redact(info.join("\n")) + "\n";
}

function stampForFile(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Builds the zip a user sends, in Downloads, and shows it in Explorer.
 *
 * Only the logs and a summary go in — never the database, the credentials or
 * the cookie file. The summary says whether those exist, which is all a
 * diagnosis needs from them.
 */
async function exportBundle(opts) {
  write("main", "info", "diagnostics export requested");
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ytms-diag-"));
  try {
    fs.writeFileSync(path.join(staging, "info.txt"), await systemInfo(opts));
    for (const name of ["app.log", ...Array.from({ length: KEEP }, (_, i) => `app.${i + 1}.log`)]) {
      const from = path.join(dir, name);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(staging, name));
    }

    const out = path.join(app.getPath("downloads"), `ytms-diagnostics-${stampForFile()}.zip`);
    // Windows ships bsdtar, which writes a zip when asked to (-a, by extension).
    const tar = path.join(process.env.SystemRoot || "C:/Windows", "System32", "tar.exe");
    await new Promise((resolve, reject) => {
      const child = spawn(tar, ["-a", "-c", "-f", out, "-C", staging, "."], { windowsHide: true });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
    });
    shell.showItemInFolder(out);
    write("main", "info", `diagnostics written to ${out}`);
    return { ok: true, path: out };
  } catch (err) {
    write("main", "error", `diagnostics export failed: ${err.message}`);
    return { ok: false, reason: err.message };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function openFolder() {
  if (dir) void shell.openPath(dir);
}

module.exports = { init, write, redact, attachCore, fromPage, exportBundle, openFolder };
