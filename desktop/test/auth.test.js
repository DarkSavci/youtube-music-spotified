const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createRequire } = require("node:module");

function harness(t, { response = 0, cookies = [], browserFound = true, waitForCancel = false, launchFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spotifier-auth-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const children = [];
  const imported = [];
  let flushed = false;
  const ses = {
    setUserAgent() {}, clearStorageData: async () => {},
    cookies: { set: async (cookie) => imported.push(cookie), flushStore: async () => { flushed = true; } },
  };
  const app = new EventEmitter();
  app.userAgentFallback = "Chrome/130.0.0";
  const electron = {
    app, session: { fromPartition: () => ses },
    dialog: { showMessageBox: async (options) => {
      if (waitForCancel || launchFails) {
        await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
        return { response: 1 };
      }
      return { response };
    } },
  };
  const spawn = (_exe, args) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 1, exitCode: null, signalCode: null, args });
    child.kill = (signal) => {
      setImmediate(() => {
        child.signalCode = signal;
        child.emit("exit", null, signal);
      });
      return true;
    };
    if (args.includes("--headless=new")) {
      child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
      child.stdio[3].on("data", (data) => {
        const request = JSON.parse(data.toString().slice(0, -1));
        setImmediate(() => child.stdio[4].write(JSON.stringify({ id: request.id, result: { cookies } }) + "\0"));
      });
    } else if (launchFails) {
      child.pid = undefined;
      setImmediate(() => child.emit("error", new Error("ENOENT")));
    }
    children.push(child);
    return child;
  };
  const filename = path.resolve(__dirname, "../auth.js");
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, process: { platform: "darwin" }, Buffer, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console: { warn() {}, error() {} },
    require: (name) => name === "electron" ? electron
      : name === "node:child_process" ? { spawn }
      : name === "./mac-browser" ? { findMacBrowser: () => browserFound ? "/test/Chrome" : null }
      : nativeRequire(name),
  }, { filename });
  return { auth: module.exports, dir, children, imported, flushed: () => flushed };
}

const signedInCookies = [
  { domain: ".youtube.com", name: "LOGIN_INFO", value: "test-login", path: "/", secure: true },
  { domain: ".youtube.com", name: "SAPISID", value: "test-signature", path: "/", secure: true },
];

test("Mac sign-in closes both owned browsers before removing their isolated profile", async (t) => {
  const h = harness(t, { cookies: signedInCookies });
  const attempt = h.auth.signIn(h.dir);
  assert.equal(h.auth.signIn(h.dir), attempt, "duplicate clicks share one attempt");
  assert.equal((await attempt).ok, true);
  assert.equal(h.children.length, 2);
  assert.ok(h.children.every((child) => child.signalCode !== null));
  assert.ok(h.children[0].args.some((arg) => arg.startsWith(`--user-data-dir=${h.dir}`)));
  assert.ok(!h.children[0].args.includes("--remote-debugging-pipe"));
  assert.equal(h.imported.length, 2);
  assert.equal(h.flushed(), true);
  assert.deepEqual(fs.readdirSync(h.dir), ["credentials.json"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(h.dir, "credentials.json")).mode & 0o777, 0o600);
});

test("cancel closes the owned browser without reading or importing cookies", async (t) => {
  const h = harness(t, { response: 1 });
  assert.equal((await h.auth.signIn(h.dir)).reason, "closed");
  assert.equal(h.children.length, 1);
  assert.ok(h.children[0].signalCode);
  assert.deepEqual(fs.readdirSync(h.dir), []);
});

test("quitting aborts the sign-in dialog and waits for cleanup", async (t) => {
  const h = harness(t, { waitForCancel: true });
  const result = h.auth.signIn(h.dir);
  await h.auth.cancelSignIn();
  assert.equal((await result).reason, "closed");
  assert.deepEqual(fs.readdirSync(h.dir), []);
});

test("missing browser is actionable and does not use embedded Google sign-in", async (t) => {
  const h = harness(t, { browserFound: false });
  assert.equal((await h.auth.signIn(h.dir)).reason, "browser-not-found");
  assert.equal(h.children.length, 0);
});

test("browser launch failure cleans the temporary profile", async (t) => {
  const h = harness(t, { launchFails: true });
  assert.equal((await h.auth.signIn(h.dir)).reason, "browser-sign-in-failed");
  assert.deepEqual(fs.readdirSync(h.dir), []);
});

test("finishing before authentication does not write credentials", async (t) => {
  const h = harness(t);
  assert.equal((await h.auth.signIn(h.dir)).reason, "not-signed-in");
  assert.equal(h.imported.length, 0);
  assert.deepEqual(fs.readdirSync(h.dir), []);
});
