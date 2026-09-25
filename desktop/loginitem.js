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

class LoginItem {
  constructor(app, platform = process.platform, execPath = process.execPath) {
    this.app = app;
    this.platform = platform;
    this.execPath = execPath;
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
    const items = this.app.getLoginItemSettings(this.windowsItem()).launchItems ?? [];
    const here = this.execPath.toLowerCase();
    if (items.length === 0 || items.some((i) => String(i.path).toLowerCase() === here)) return;
    this.app.setLoginItemSettings({ ...this.windowsItem(), openAtLogin: true, enabled: items[0].enabled !== false });
  }

  /** Whether this process was started by the OS at login. */
  launchedAtLogin(argv = process.argv) {
    if (argv.includes(LOGIN_ARG)) return true;
    return this.platform === "darwin" && Boolean(this.app.getLoginItemSettings().wasOpenedAtLogin);
  }
}

module.exports = { LoginItem, NAME, LOGIN_ARG };
