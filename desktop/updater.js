/**
 * App updates, from the project's GitHub releases.
 *
 * The release workflow publishes the NSIS installer with its latest.yml and
 * blockmap; electron-updater reads latest.yml, downloads the new installer in
 * the background (only the changed blocks, when it can), checks its sha512
 * and runs it silently when the app quits. The installer is not code-signed,
 * so no publisher check is configured — the hash from latest.yml is the check.
 *
 * The feed is set here rather than read from app-update.yml: the installer is
 * built with --prepackaged, which does not write that file into the app.
 *
 * Nothing interrupts playback. A downloaded update waits for the next quit,
 * and until then the tray menu and a notification offer to restart now.
 */

const { app, Notification } = require("electron");
const path = require("node:path");

const FEED = { provider: "github", owner: "DarkSavci", repo: "youtube-music-spotified" };
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_AFTER_MS = 30_000;

let updater = null;
let ready = null; // the version downloaded and waiting to install

function start() {
  if (!app.isPackaged || process.platform !== "win32") return;
  // Windows shows a toast only for an app it can match to a Start menu
  // shortcut; the installer stamps its shortcut with the appId.
  app.setAppUserModelId("dev.darksavci.youtubemusicspotified");

  // Required lazily: in development it would complain about the missing
  // app-update.yml on load, and it is never used there.
  ({ autoUpdater: updater } = require("electron-updater"));
  updater.setFeedURL(FEED);
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = {
    info: (m) => console.log("[update]", m),
    warn: (m) => console.warn("[update]", m),
    error: (m) => console.error("[update]", m),
    debug: () => {},
  };

  updater.on("update-downloaded", (info) => {
    ready = info.version;
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
  updater.on("error", (err) => console.warn("[update] check failed:", err?.message ?? err));

  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, FIRST_CHECK_AFTER_MS).unref?.();
  setInterval(check, CHECK_EVERY_MS).unref?.();
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

module.exports = { start, pending, install };
