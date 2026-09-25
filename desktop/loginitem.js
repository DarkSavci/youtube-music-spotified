/**
 * Launch at login.
 *
 * The operating system is the source of truth, not a saved preference: the
 * person can switch the entry off in Task Manager or System Settings without
 * the app knowing, so the toggle asks the OS every time it is drawn.
 *
 * Only a packaged build registers itself. In development the executable is
 * Electron's own, and registering it would start a bare Electron at login.
 *
 * A launch the OS made at login starts hidden in the tray. The resume point
 * comes back paused, so nothing plays until the person asks.
 *
 * Windows keeps the entry in the registry's Run key; macOS registers the app
 * itself with SMAppService (Electron's default "mainAppService"), which can
 * hold a registration pending until the person allows it under System
 * Settings, General, Login Items. That is reported rather than read as off, so
 * the toggle can say where to go.
 */

// What Windows shows in Task Manager's Startup tab, and the Run value the
// uninstaller removes. Fixed rather than derived, so the two cannot drift.
const NAME = "Youtube Music Spotified";
// Marks a launch the OS made at login.
const LOGIN_ARG = "--launched-at-login";

const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
const APPROVED_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`;

/**
 * Reads this app's Run entry by name, whatever it launches.
 *
 * Electron cannot do this: getLoginItemSettings lists only entries that
 * launch the path it is asked about, so an entry left pointing at an old
 * install is invisible to it. Returns the command and whether Task Manager
 * has it switched on, or null when there is no entry.
 */
function readRunEntry(name) {
  const { execFileSync } = require("node:child_process");
  const query = (key) => {
    try {
      // A missing value is an ordinary answer here; keep reg's error text off the log.
      return execFileSync("reg", ["query", key, "/v", name], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  const run = query(RUN_KEY).match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
  if (!run) return null;
  // StartupApproved's first byte is 3 when switched off in Task Manager.
  const approved = query(APPROVED_KEY).match(/REG_BINARY\s+([0-9A-F]{2})/i);
  return { command: run[1], enabled: !approved || approved[1] !== "03" };
}

class LoginItem {
  constructor(app, platform = process.platform, execPath = process.execPath, readRun = readRunEntry) {
    this.app = app;
    this.platform = platform;
    this.execPath = execPath;
    this.readRun = readRun;
  }

  supported() {
    return this.app.isPackaged && (this.platform === "win32" || this.platform === "darwin");
  }

  /** The Windows registration this build owns: this executable, marked. */
  windowsItem() {
    return { name: NAME, path: this.execPath, args: [LOGIN_ARG] };
  }

  /** What the OS has: whether the app will open at login, and whether macOS is waiting for approval. */
  state() {
    if (!this.supported()) return { supported: false, enabled: false, needsApproval: false };
    if (this.platform === "win32") {
      // executableWillLaunchAtLogin, not openAtLogin: it is also false when
      // the entry exists but was switched off in Task Manager.
      const s = this.app.getLoginItemSettings(this.windowsItem());
      return { supported: true, enabled: Boolean(s.executableWillLaunchAtLogin), needsApproval: false };
    }
    const s = this.app.getLoginItemSettings();
    // status is macOS 13's SMAppService answer; older systems give only openAtLogin.
    const needsApproval = s.status === "requires-approval";
    const enabled = s.status ? s.status === "enabled" : Boolean(s.openAtLogin);
    return { supported: true, enabled, needsApproval };
  }

  enabled() {
    return this.state().enabled;
  }

  /** Registers or removes the entry, then reports what the OS now says. */
  set(on) {
    if (!this.supported()) return this.state();
    if (this.platform === "win32") {
      // enabled: turning it on also undoes a Task Manager switch-off, which is
      // what someone flipping the toggle back on means.
      this.app.setLoginItemSettings({ ...this.windowsItem(), openAtLogin: Boolean(on), enabled: Boolean(on) });
    } else {
      this.app.setLoginItemSettings({ openAtLogin: Boolean(on) });
    }
    return this.state();
  }

  /**
   * Points an existing Windows entry at this executable.
   *
   * An entry written by a build that has since moved would start nothing, or
   * the old copy. Run once at startup; a no-op unless an entry of ours names
   * another path. Whether it was switched off is carried over.
   */
  refresh() {
    if (!this.supported() || this.platform !== "win32") return;
    const entry = this.readRun(NAME);
    if (!entry) return;
    // The command is the executable, quoted or not, then the arguments.
    const launches = entry.command.replace(/"/g, "").toLowerCase();
    if (launches.startsWith(this.execPath.toLowerCase())) return;
    this.app.setLoginItemSettings({ ...this.windowsItem(), openAtLogin: true, enabled: entry.enabled });
  }

  /** Whether this process was started by the OS at login. */
  launchedAtLogin(argv = process.argv) {
    if (argv.includes(LOGIN_ARG)) return true;
    return this.platform === "darwin" && Boolean(this.app.getLoginItemSettings().wasOpenedAtLogin);
  }
}

module.exports = { LoginItem, NAME, LOGIN_ARG };
