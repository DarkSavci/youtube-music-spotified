const { test } = require("node:test");
const assert = require("node:assert/strict");
const { LoginItem, NAME, LOGIN_ARG } = require("../loginitem");

// A stand-in for Electron's app that keeps Windows' Run entries in a map.
function fakeApp({ packaged = true, items = [] } = {}) {
  const run = new Map(items.map((i) => [i.name, { ...i }]));
  return {
    isPackaged: packaged,
    run,
    getLoginItemSettings({ name, path } = {}) {
      const item = run.get(name);
      const mine = Boolean(item && item.path === path);
      return {
        openAtLogin: mine,
        executableWillLaunchAtLogin: mine && item.enabled !== false,
        launchItems: item ? [{ ...item }] : [],
      };
    },
    setLoginItemSettings({ name, path, args, openAtLogin, enabled }) {
      if (openAtLogin) run.set(name, { name, path, args, enabled });
      else run.delete(name);
    },
  };
}

const EXE = "C:\\Users\\me\\AppData\\Local\\Programs\\Youtube Music Spotified\\Youtube Music Spotified.exe";

test("turning it on registers this executable, marked as a login launch", () => {
  const app = fakeApp();
  const item = new LoginItem(app, "win32", EXE);
  assert.equal(item.set(true).enabled, true);
  assert.deepEqual(app.run.get(NAME), { name: NAME, path: EXE, args: [LOGIN_ARG], enabled: true });
  assert.equal(item.set(false).enabled, false);
  assert.equal(app.run.size, 0);
});

// Switched off in Task Manager, the entry is still there but will not run.
test("an entry switched off in Task Manager reads as off, and turning it on revives it", () => {
  const app = fakeApp({ items: [{ name: NAME, path: EXE, args: [LOGIN_ARG], enabled: false }] });
  const item = new LoginItem(app, "win32", EXE);
  assert.equal(item.enabled(), false);
  assert.equal(item.set(true).enabled, true);
});

test("a development build never registers a bare Electron", () => {
  const app = fakeApp({ packaged: false });
  const item = new LoginItem(app, "win32", EXE);
  assert.equal(item.supported(), false);
  assert.equal(item.set(true).enabled, false);
  assert.equal(app.run.size, 0);
});

test("an entry left by a build that moved is pointed at this one", () => {
  const app = fakeApp({ items: [{ name: NAME, path: "D:\\old\\app.exe", args: [LOGIN_ARG], enabled: false }] });
  new LoginItem(app, "win32", EXE).refresh();
  assert.equal(app.run.get(NAME).path, EXE);
  // Switched off stays switched off.
  assert.equal(app.run.get(NAME).enabled, false);
});

test("refreshing leaves things alone when there is no entry or it is current", () => {
  const empty = fakeApp();
  new LoginItem(empty, "win32", EXE).refresh();
  assert.equal(empty.run.size, 0);

  const current = fakeApp({ items: [{ name: NAME, path: EXE, args: [LOGIN_ARG], enabled: true }] });
  let writes = 0;
  const set = current.setLoginItemSettings;
  current.setLoginItemSettings = (o) => { writes++; set(o); };
  new LoginItem(current, "win32", EXE).refresh();
  assert.equal(writes, 0);
});

test("only the marked launch counts as a login launch on Windows", () => {
  const item = new LoginItem(fakeApp(), "win32", EXE);
  assert.equal(item.launchedAtLogin([EXE, LOGIN_ARG]), true);
  assert.equal(item.launchedAtLogin([EXE]), false);
});

// A stand-in for macOS 13's SMAppService, as Electron reports it.
function fakeMac(status) {
  let current = status;
  return {
    isPackaged: true,
    getLoginItemSettings: () => ({ openAtLogin: current === "enabled", status: current, wasOpenedAtLogin: false }),
    setLoginItemSettings: ({ openAtLogin }) => { current = openAtLogin ? "enabled" : "not-registered"; },
  };
}

test("macOS registers the app itself and reads SMAppService's answer", () => {
  const item = new LoginItem(fakeMac("not-registered"), "darwin", "/Applications/Youtube Music Spotified.app");
  assert.deepEqual(item.state(), { supported: true, enabled: false, needsApproval: false });
  assert.equal(item.set(true).enabled, true);
  assert.equal(item.set(false).enabled, false);
});

// Registered but not yet allowed: neither on nor simply off.
test("a macOS registration awaiting approval says so", () => {
  const item = new LoginItem(fakeMac("requires-approval"), "darwin", "/Applications/Youtube Music Spotified.app");
  assert.deepEqual(item.state(), { supported: true, enabled: false, needsApproval: true });
});

test("macOS knows a login launch from the OS, not from an argument", () => {
  const app = fakeMac("enabled");
  app.getLoginItemSettings = () => ({ status: "enabled", wasOpenedAtLogin: true });
  assert.equal(new LoginItem(app, "darwin", "/Applications/x.app").launchedAtLogin(["x"]), true);
});
