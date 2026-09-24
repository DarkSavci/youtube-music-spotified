/**
 * Sign-in.
 *
 * The user signs in to Google in their installed browser, on a throwaway
 * profile, and the resulting cookies are moved into a session the app owns.
 * Only when no such browser exists does it fall back to a window of its own,
 * which Google will usually refuse for a new session (see signInWithBrowser).
 *
 * The session ends up owned by the app because copying cookies out of an
 * ordinary browser does not work for long. YouTube rotates a live session's
 * cookies, and a copied snapshot goes stale as soon as it does — observed
 * twice during development, the second time inside an hour. Owning the session removes the problem
 * rather than papering over it: when YouTube rotates, it rotates *ours*, and
 * the next read picks up the current values.
 *
 * The credentials never leave the Device. They are written to the per-user
 * data directory and read only by the local sidecar.
 */

const { app, BrowserWindow, session, ipcMain, net, dialog } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { findMacBrowser } = require("./mac-browser");
const { stopChild } = require("./child-process");

const YTM_URL = "https://music.youtube.com/";

/*
 * Where the sign-in window opens.
 *
 * Loading YouTube Music itself lands on the signed-out home page, which is a
 * wall of recommendations with a small "Sign in" button somewhere in it — so
 * asking the app to sign in produced a browser and left the actual asking to
 * the user. This goes straight to the account form and returns to YouTube
 * Music once Google is done, which is the whole of what was wanted.
 *
 * service=youtube rather than a bare continue: it is what makes Google issue
 * the YouTube cookies on the way back, instead of only the account ones.
 */
const SIGNIN_URL =
  "https://accounts.google.com/ServiceLogin?service=youtube&hl=en&continue=" +
  encodeURIComponent(YTM_URL);

const PARTITION = "persist:ytmusic";

/**
 * The sign-in window's user agent, with the Electron token removed.
 *
 * Google refuses to complete a sign-in from a browser that identifies itself
 * as an embedded framework — the account page answers with "this browser or
 * app may not be secure" and there is no way through it. The rest of the
 * string is left exactly as Chromium sent it, because this is a real Chromium
 * of that version; the only untrue part was the token claiming otherwise.
 */
function browserUserAgent() {
  return (
    app.userAgentFallback
      .replace(/ Electron\/[\d.]+/, "")
      // The app's own name/version token, which Electron puts just before
      // "Chrome/". Matched by position rather than by name: it used to match
      // the old package name, and quietly stopped working when the app was
      // renamed.
      .replace(/ [^ ()]+(?: [^ ()]+)*\/[\d.]+(?= Chrome\/)/, "")
  );
}

/**
 * The owned session, configured once.
 *
 * A dedicated partition so a sign-out here cannot disturb anything else, and
 * so the session persists across restarts.
 */
function ytSession() {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(browserUserAgent());
  return ses;
}

/**
 * Tells the core to re-read the credentials file.
 *
 * Used when the same account's cookies are refreshed. Signing in or out
 * restarts the core instead (restartCore in main.js), because a changed
 * account has to reach parts of the core that only read it at startup.
 */
function notifyCore(port) {
  return new Promise((resolve) => {
    const req = net.request({
      method: "POST",
      url: `http://127.0.0.1:${port}/v1/auth/reload`,
    });
    let body = "";
    req.on("response", (res) => {
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ signedIn: false });
        }
      });
    });
    // The core being unreachable is not a sign-in failure: the credentials are
    // on disk and the next start will read them.
    req.on("error", () => resolve(null));
    req.end();
  });
}

/** Cookies the sidecar needs. Anything else is noise we do not persist. */
const WANTED = new Set([
  "SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID",
  "SID", "__Secure-1PSID", "__Secure-3PSID",
  "HSID", "SSID", "APISID", "LOGIN_INFO",
  "__Secure-1PSIDTS", "__Secure-3PSIDTS",
  "SIDCC", "__Secure-1PSIDCC", "__Secure-3PSIDCC",
  "VISITOR_INFO1_LIVE", "VISITOR_PRIVACY_METADATA", "PREF", "YSC",
  "__Secure-YNID", "__Secure-ROLLOUT_TOKEN", "__Secure-BUCKET", "wide",
]);

/**
 * A signed-in session is identifiable by these two together: LOGIN_INFO marks
 * an account, and a SAPISID variant is what request signatures are computed
 * over. Either alone is not enough to authenticate.
 */
function looksSignedIn(cookies) {
  const names = new Set(cookies.map((c) => c.name));
  const hasSapisid =
    names.has("SAPISID") || names.has("__Secure-1PAPISID") || names.has("__Secure-3PAPISID");
  return names.has("LOGIN_INFO") && hasSapisid;
}

async function readYouTubeCookies(ses) {
  // Google spreads these across several domains; collect and de-duplicate.
  const domains = [".youtube.com", ".google.com", "music.youtube.com"];
  const seen = new Map();
  for (const domain of domains) {
    const found = await ses.cookies.get({ domain });
    for (const c of found) {
      if (WANTED.has(c.name) && !seen.has(c.name)) seen.set(c.name, c);
    }
  }
  return [...seen.values()];
}

function toHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function credentialsPath(dataDir) {
  return path.join(dataDir, "credentials.json");
}

/**
 * Writes credentials atomically.
 *
 * A partial file would look structurally valid and fail only at request time,
 * which is the hardest kind of auth failure to diagnose — so the file is
 * written whole and then moved into place.
 */
function writeCredentials(dataDir, cookieHeader) {
  const target = credentialsPath(dataDir);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ cookie: cookieHeader }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmp, target);
}

/**
 * Signs in, and resolves once credentials are captured.
 *
 * In the real browser when there is one, and in a window of our own only when
 * there is not. See signInWithBrowser for why the order is that way round.
 */
let pendingSignIn = null;
let cancelMacSignIn = null;

function signIn(dataDir, parent) {
  if (pendingSignIn) return pendingSignIn;
  const exe = systemBrowser();
  // Start synchronously so a Quit immediately after Sign in can cancel it.
  const attempt = process.platform === "darwin"
    ? exe ? signInWithMacBrowser(dataDir, exe, parent) : { ok: false, reason: "browser-not-found" }
    : exe ? signInWithBrowser(dataDir, exe) : signInEmbedded(dataDir, parent);
  pendingSignIn = Promise.resolve(attempt).finally(() => { pendingSignIn = null; });
  return pendingSignIn;
}

async function cancelSignIn() {
  if (!cancelMacSignIn) return;
  cancelMacSignIn();
  await pendingSignIn;
}

/** Chrome remains running after its last Mac window closes. Let the user
 * explicitly finish, then stop only our temporary-profile process and wait
 * for its cookie store to flush before reopening it headless. */
async function signInWithMacBrowser(dataDir, exe, parent) {
  const profile = fs.mkdtempSync(path.join(dataDir, "signin-browser-"));
  fs.chmodSync(profile, 0o700);
  const controller = new AbortController();
  const stopping = new AbortController();
  let canceled = false;
  cancelMacSignIn = () => { canceled = true; controller.abort(); stopping.abort(); };
  const browser = spawn(exe, [
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-sync", "--disable-background-mode", "--new-window", SIGNIN_URL,
  ], { stdio: "ignore" });
  let launchError = null;
  browser.once("error", (err) => { launchError = err; controller.abort(); });
  browser.once("exit", () => controller.abort());
  try {
    const options = {
      type: "info", title: "Sign in to YouTube Music",
      message: "Finish signing in in the browser, then return here.",
      detail: "A separate browser window was opened for this app. Once YouTube Music shows your account, choose Finish sign-in. Your usual browser profile is not used.",
      buttons: ["Finish sign-in", "Cancel"], defaultId: 0, cancelId: 1,
      signal: controller.signal,
    };
    const result = await (parent && !parent.isDestroyed()
      ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
    const exited = browser.exitCode !== null || browser.signalCode !== null;
    if (launchError) throw launchError;
    if (canceled || (result.response !== 0 && !exited)) return { ok: false, reason: "closed" };
    await stopChild(browser);
    if (canceled) return { ok: false, reason: "closed" };
    const cookies = pickYouTubeCookies(await readSavedCookies(exe, profile, stopping.signal));
    if (canceled) return { ok: false, reason: "closed" };
    if (!looksSignedIn(cookies)) return { ok: false, reason: "not-signed-in" };
    await importIntoOwnSession(cookies);
    // Once import begins, finish the commit. A concurrent sign-out waits for
    // this attempt before clearing the session and credential files.
    await ytSession().cookies.flushStore();
    writeCredentials(dataDir, toHeader(cookies));
    return { ok: true, count: cookies.length };
  } catch (err) {
    console.warn("[auth] browser sign-in failed:", err.message);
    return { ok: false, reason: "browser-sign-in-failed" };
  } finally {
    await stopChild(browser);
    cancelMacSignIn = null;
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/*
 * The installed Chromium-based browsers, most likely to be the user's own first.
 * Edge ships with Windows, so on Windows there is essentially always one.
 */
function systemBrowser() {
  if (process.platform === "darwin") return findMacBrowser();
  if (process.platform !== "win32") return null;
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  const candidates = [
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    local && path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Signs in through the real browser, then takes the session into our own.
 *
 * Google refuses to sign in to anything that looks automated — "this browser
 * or app may not be secure". Two attempts taught what it looks at:
 *
 *  - the app's own window is refused however it describes itself: with
 *    Chrome's exact user agent and matching client hints, a fresh session was
 *    still turned away;
 *  - the installed Chrome is refused too when it is started with a debugging
 *    connection, even one that never touches the page.
 *
 * So nothing is attached while Google is on screen. The browser is started
 * exactly as a person would start it, on a throwaway profile so none of the
 * user's own browsing is involved, and the only thing watched is its window
 * title — the same thing the taskbar shows. When it reads "YouTube Music" the
 * sign-in has landed; the window is closed the way clicking its X closes it,
 * which makes the browser write its cookies to disk.
 *
 * Only then is the profile reopened, headless and over a private pipe, to read
 * those cookies back. That second browser never loads a Google page, so there
 * is nothing on it for anyone to detect. The cookies are copied into the
 * app's own session, and the throwaway profile is deleted.
 *
 * Closing the window by hand works too: the cookies are read either way, and
 * a window closed before signing in simply finds none.
 */
function signInWithBrowser(dataDir, exe) {
  return new Promise((resolve) => {
    const profile = path.join(dataDir, "signin-browser");
    fs.rmSync(profile, { recursive: true, force: true });

    let settled = false;
    const cleanup = () =>
      setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      app.removeListener("before-quit", onQuit);
      if (watcher.exitCode === null) watcher.kill();
      resolve(result);
    };

    // Phase one: an ordinary browser window, with nothing attached to it.
    const browser = spawn(
      exe,
      [
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--new-window",
        SIGNIN_URL,
      ],
      { stdio: "ignore" },
    );

    // Quitting the app mid-sign-in must not leave a browser holding a session.
    const onQuit = () => {
      if (browser.exitCode === null) browser.kill();
      cleanup();
    };
    app.on("before-quit", onQuit);

    /*
     * The window-title watch, done by PowerShell because Node cannot read
     * another process's window. It asks Windows for the title once a second
     * and, when YouTube Music has loaded, closes the window gently so the
     * browser saves its cookies on the way out.
     */
    const watch = [
      `$p = Get-Process -Id ${browser.pid} -ErrorAction SilentlyContinue`,
      "while ($p -and -not $p.HasExited) {",
      "  $p.Refresh()",
      "  if ($p.MainWindowTitle -match 'YouTube Music') { Start-Sleep -Seconds 2; [void]$p.CloseMainWindow(); break }",
      "  Start-Sleep -Milliseconds 1000",
      "}",
    ].join("\n");
    const watcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", watch], {
      stdio: "ignore",
      windowsHide: true,
    });

    browser.on("error", (err) => {
      cleanup();
      finish({ ok: false, reason: err.message });
    });

    // Phase two: however the window closed, read what it saved.
    browser.on("exit", async () => {
      if (settled) return;
      try {
        const cookies = pickYouTubeCookies(await readSavedCookies(exe, profile));
        if (!looksSignedIn(cookies)) {
          finish({ ok: false, reason: "not-signed-in" });
        } else {
          await importIntoOwnSession(cookies);
          writeCredentials(dataDir, toHeader(cookies));
          finish({ ok: true, count: cookies.length });
        }
      } catch (err) {
        console.error("[auth] could not read the saved session:", err);
        finish({ ok: false, reason: String(err.message || err) });
      } finally {
        cleanup();
      }
    });
  });
}

/*
 * Reopens a closed profile headless and returns every cookie it holds.
 *
 * The browser decrypts its own cookie store, which is the only reliable way
 * to read it: current Chrome ties that encryption to its own executable, so
 * nothing else can open the file. Driven over --remote-debugging-pipe, which
 * is private to this process, and never pointed at any web page.
 */
function readSavedCookies(exe, profile, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      exe,
      [
        `--user-data-dir=${profile}`,
        "--headless=new",
        "--remote-debugging-pipe",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    );
    const toBrowser = child.stdio[3];
    const fromBrowser = child.stdio[4];
    let buffer = Buffer.alloc(0);
    let nextId = 0;
    const waiting = new Map();
    let done = false;
    const onAbort = () => end(new Error("sign-in canceled"));

    const end = async (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Do not remove the temporary profile while Chrome is still using it.
      await stopChild(child);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => end(new Error("timed out reading cookies")), 20000);

    fromBrowser.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let at;
      while ((at = buffer.indexOf(0)) >= 0) {
        let message = null;
        try {
          message = JSON.parse(buffer.subarray(0, at).toString("utf8"));
        } catch {
          /* skip a malformed message */
        }
        buffer = buffer.subarray(at + 1);
        if (message && message.id && waiting.has(message.id)) {
          waiting.get(message.id)(message);
          waiting.delete(message.id);
        }
      }
    });
    fromBrowser.on("error", () => {});
    toBrowser.on("error", () => {});
    child.on("error", (err) => end(err));
    child.on("exit", () => end(new Error("browser exited before its cookies were read")));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    function send(method, params = {}) {
      return new Promise((res) => {
        const id = ++nextId;
        waiting.set(id, res);
        try {
          toBrowser.write(JSON.stringify({ id, method, params }) + "\0");
        } catch {
          waiting.delete(id);
          res({});
        }
      });
    }

    send("Storage.getCookies").then((reply) => {
      const cookies = reply?.result?.cookies;
      if (Array.isArray(cookies)) end(null, cookies);
      else end(new Error("no cookies in the reply"));
    });
  });
}

/*
 * The account cookies, one per name, in the same precedence the old window
 * read them with: YouTube's own domain first, then Google's.
 */
function pickYouTubeCookies(all) {
  const rank = (domain) =>
    domain === ".youtube.com" ? 0 : domain === ".google.com" ? 1 : domain === "music.youtube.com" ? 2 : 9;
  const byName = new Map();
  for (const c of all) {
    if (!WANTED.has(c.name) || rank(c.domain) === 9) continue;
    const seen = byName.get(c.name);
    if (!seen || rank(c.domain) < rank(seen.domain)) byName.set(c.name, c);
  }
  return [...byName.values()];
}

/*
 * Copies the captured session into the app's own partition, so everything
 * that reads it — refreshing credentials at startup, signing out — works as
 * it did when sign-in happened in that partition directly.
 */
async function importIntoOwnSession(cookies) {
  const ses = ytSession();
  const sameSite = { Strict: "strict", Lax: "lax", None: "no_restriction" };
  for (const c of cookies) {
    await ses.cookies.set({
      url: `https://${c.domain.replace(/^\./, "")}${c.path || "/"}`,
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      sameSite: sameSite[c.sameSite] || "unspecified",
      ...(c.expires > 0 ? { expirationDate: c.expires } : {}),
    });
  }
}

/**
 * Signs in inside a window of our own. The fallback, for a machine with no
 * Chromium-based browser installed.
 *
 * Capture is polled rather than driven by a single navigation event: the sign
 * in flow crosses several domains and can finish in ways that do not produce a
 * predictable final navigation.
 */
function signInEmbedded(dataDir, parent) {
  return new Promise((resolve) => {
    const ses = ytSession();

    const win = new BrowserWindow({
      width: 980,
      height: 760,
      parent,
      modal: false,
      autoHideMenuBar: true,
      backgroundColor: "#0f0f0f",
      title: "Sign in to YouTube Music",
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false },
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (!win.isDestroyed()) win.close();
      resolve(result);
    };

    const poll = setInterval(async () => {
      if (win.isDestroyed()) return finish({ ok: false, reason: "closed" });
      try {
        const cookies = await readYouTubeCookies(ses);
        if (looksSignedIn(cookies)) {
          writeCredentials(dataDir, toHeader(cookies));
          finish({ ok: true, count: cookies.length });
        }
      } catch (err) {
        console.error("[auth] cookie read failed:", err);
      }
    }, 1500);

    win.on("closed", () => finish({ ok: false, reason: "closed" }));
    /*
     * Already signed in at the browser level is possible — a previous
     * session that only went stale for the sidecar — in which case Google
     * bounces straight back and the poll finishes without anything being
     * typed. That is the good case, so it is not special-cased.
     */
    win.loadURL(SIGNIN_URL, { userAgent: browserUserAgent() });
  });
}

/**
 * Refreshes stored credentials from the owned session, without any UI.
 *
 * This is what makes rotation a non-issue: the session is ours, so when
 * YouTube rotates it the next read returns the current values. Called on
 * startup and whenever the sidecar reports a logged-out session.
 */
async function refreshCredentials(dataDir) {
  const ses = ytSession();
  const cookies = await readYouTubeCookies(ses);
  if (!looksSignedIn(cookies)) return { ok: false, reason: "not-signed-in" };
  writeCredentials(dataDir, toHeader(cookies));
  return { ok: true, count: cookies.length };
}

async function signOut(dataDir) {
  await cancelSignIn();
  const ses = ytSession();
  await ses.clearStorageData();
  // The core exports the session for yt-dlp beside the credentials; signing
  // out has to take that copy too, or the session outlives the sign-out.
  for (const file of [credentialsPath(dataDir), path.join(dataDir, "yt-dlp-cookies.txt")]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* nothing stored */
    }
  }
  fs.rmSync(path.join(dataDir, "signin-browser"), { recursive: true, force: true });
  return { ok: true };
}

function register(dataDirFn, getMainWindow, corePort, restartCore) {
  // A sign-in the app was killed during leaves its throwaway browser profile
  // behind, holding a session. It is never reused, so it goes at startup.
  fs.rmSync(path.join(dataDirFn(), "signin-browser"), { recursive: true, force: true });

  // Every credential change tells the core, so the running process picks it
  // up. A sign-in that only writes a file is a sign-in that does nothing.
  // Signing in or out changes the account everything in the core was wired
  // with, so it restarts rather than being told to re-read the file — see
  // restartCore in main.js for what re-reading alone left behind.
  ipcMain.handle("auth:sign-in", async () => {
    const result = await signIn(dataDirFn(), getMainWindow());
    if (result.ok) {
      if (restartCore) {
        await restartCore();
        result.signedIn = true;
      } else {
        const core = await notifyCore(corePort);
        result.signedIn = core?.signedIn ?? false;
      }
    }
    return result;
  });
  ipcMain.handle("auth:refresh", async () => {
    const result = await refreshCredentials(dataDirFn());
    if (result.ok) await notifyCore(corePort);
    return result;
  });
  ipcMain.handle("auth:sign-out", async () => {
    const result = await signOut(dataDirFn());
    if (restartCore) await restartCore();
    else await notifyCore(corePort);
    return result;
  });
  ipcMain.handle("auth:status", () => {
    try {
      const raw = fs.readFileSync(credentialsPath(dataDirFn()), "utf8");
      return { hasCredentials: JSON.parse(raw).cookie?.length > 0 };
    } catch {
      return { hasCredentials: false };
    }
  });
}

module.exports = { register, refreshCredentials, signIn, signOut, cancelSignIn };
