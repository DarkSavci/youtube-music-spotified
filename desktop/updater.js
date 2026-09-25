/**
 * App updates, from the project's GitHub releases.
 *
 * The release workflow publishes the NSIS installer with its latest.yml and
 * blockmap; electron-updater reads latest.yml, downloads the new installer in
 * the background (only the changed blocks, when it can), checks its sha512
 * and runs it silently when the app quits. The installer is not code-signed,
 * so no publisher check is configured — the hash from latest.yml is the check.
 *
 * The installer is built with --prepackaged, which does not write the
 * app-update.yml electron-updater expects beside the app. Setting the feed in
 * code covers the check, but the download reads that file too (for its cache
 * folder), and without it every download failed: updates were found and never
 * arrived. So the file is written into the data directory at startup and the
 * updater is pointed at it.
 *
 * Nothing interrupts playback. A downloaded update waits for the next quit,
 * and until then the tray menu and a notification offer to restart now.
 */

const { app, Notification } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const FEED = { provider: "github", owner: "DarkSavci", repo: "youtube-music-spotified" };
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_AFTER_MS = 30_000;
/** The folder under %LOCALAPPDATA% the download is kept in until it installs. */
const CACHE_DIR_NAME = "youtube-music-spotified-updater";

/** Writes the config electron-updater reads before downloading, and returns its path. */
function writeUpdateConfig() {
  const file = path.join(app.getPath("userData"), "app-update.yml");
  const yml = [
    `provider: ${FEED.provider}`,
    `owner: ${FEED.owner}`,
    `repo: ${FEED.repo}`,
    `updaterCacheDirName: ${CACHE_DIR_NAME}`,
    "",
  ].join("\n");
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== yml) fs.writeFileSync(file, yml);
  } catch (err) {
    console.warn("[update] could not write app-update.yml:", err.message);
  }
  return file;
}

let updater = null;
let ready = null; // the version downloaded and waiting to install

/*
 * Where the updater is, for the Settings page.
 *
 * Kept as plain state rather than pushed, because the only reader is a page
 * that asks while it is open. "unavailable" is a development build, which has
 * no feed to check.
 */
let state = { status: app.isPackaged && process.platform === "win32" ? "idle" : "unavailable" };

function start() {
  if (!app.isPackaged || process.platform !== "win32") return;
  // Required lazily: in development it would complain about the missing
  // app-update.yml on load, and it is never used there.
  ({ autoUpdater: updater } = require("electron-updater"));
  updater.updateConfigPath = writeUpdateConfig();
  updater.setFeedURL(FEED);
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  // The release is a full NSIS installer, never the web stub.
  updater.disableWebInstaller = true;
  updater.logger = {
    info: (m) => console.log("[update]", m),
    warn: (m) => console.warn("[update]", m),
    error: (m) => console.error("[update]", m),
    debug: () => {},
  };

  updater.on("checking-for-update", () => {
    if (!ready) state = { status: "checking" };
  });
  updater.on("update-available", (info) => {
    state = { status: "downloading", version: info.version, percent: 0 };
  });
  updater.on("update-not-available", () => {
    if (!ready) state = { status: "none", checkedAt: Date.now() };
  });
  updater.on("download-progress", (p) => {
    if (state.status === "downloading") state = { ...state, percent: Math.round(p.percent ?? 0) };
  });
  updater.on("update-downloaded", (info) => {
    ready = info.version;
    state = { status: "ready", version: info.version };
    if (!Notification.isSupported()) return;
    const note = new Notification({
      title: `${app.getName()} ${info.version} is ready`,
      body: "It installs when you quit. Click to restart and update now.",
      icon: path.join(__dirname, "branding", "icon.png"),
    });
    note.on("click", install);
    note.show();
  });
  // Offline, GitHub rate limits, a release still uploading: all retried at
  // the next check, none worth telling anyone about.
  updater.on("error", (err) => {
    console.warn("[update] check failed:", err?.message ?? err);
    if (!ready) state = { status: "error", error: String(err?.message ?? err).split(/\r?\n/)[0] };
  });

  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, FIRST_CHECK_AFTER_MS).unref?.();
  setInterval(check, CHECK_EVERY_MS).unref?.();
}

/**
 * Checks now, for the button in Settings. The answer arrives through the
 * events above; the caller reads it back with status().
 */
function checkNow() {
  if (!updater || ready || state.status === "checking" || state.status === "downloading") return status();
  state = { status: "checking" };
  updater.checkForUpdates().catch(() => {});
  return status();
}

function status() {
  return state;
}

/** The downloaded version waiting to be installed, or null. */
function pending() {
  return ready;
}

/** Quits, installs silently and relaunches. */
function install() {
  if (!updater || !ready) return;
  // Silent, and start the app again once installed.
  updater.quitAndInstall(true, true);
}

module.exports = { start, pending, install, checkNow, status };
