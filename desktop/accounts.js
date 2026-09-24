const { ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const auth = require("./auth");
const { AccountStore, writeJSON } = require("./account-store");
let store;
let busy = false;
let closing = false;

function initialize(root) { store = new AccountStore(root); }
function activeDirectory() {
  const dir = store.directory();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function activeDatabase() {
  const file = store.database();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return file;
}
async function refresh() {
  if (!store.get()) return { ok: false, reason: "not-signed-in" };
  return auth.refreshCredentials(activeDirectory(), store.partition());
}
function prepareCredentials() {
  const file = path.join(activeDirectory(), "credentials.json");
  if (!store.get()) return;
  const credentials = JSON.parse(fs.readFileSync(file, "utf8"));
  credentials.onBehalfOfUser = store.get().channel;
  writeJSON(file, credentials);
}
function register(getMainWindow, port, restartCore) {
  const exclusive = (fn) => async (_event, ...args) => {
    if (busy || closing) throw new Error("An account change is already in progress");
    busy = true;
    try { return await fn(...args); } finally { busy = false; }
  };
  const fromCore = async (route) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error("Could not load channels. Check your connection or sign in again.");
    return response.json();
  };
  const refreshChannels = async () => {
    // Profile names must survive even if channel discovery fails.
    const me = await fromCore("/v1/me");
    store.setName(me.account?.name, me.account?.avatarUrl);
    const channels = await fromCore("/v1/me/channels");
    store.setChannels(channels);
    return store.publicState();
  };
  ipcMain.on("auth:scope", (event) => { event.returnValue = scope(); });
  ipcMain.handle("auth:accounts", () => store.publicState());
  // Settings and the header can request the same channel list together.
  let channelsRequest;
  const loadChannels = exclusive(refreshChannels);
  ipcMain.handle("auth:channels", () => {
    if (!channelsRequest) channelsRequest = loadChannels().finally(() => { channelsRequest = null; });
    return channelsRequest;
  });
  ipcMain.handle("auth:sign-in", exclusive(async () => {
    const account = store.create();
    const dir = store.directory(account);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const result = await auth.signIn(dir, getMainWindow(), store.partition(account));
    if (!result.ok || closing) {
      await auth.signOut(dir, store.partition(account));
      fs.rmSync(dir, { recursive: true, force: true });
      return closing ? { ok: false, reason: "closed" } : result;
    }
    await restartCore(async () => { store.add(account); prepareCredentials(); });
    // Channel selection is offered after reload. Failure to enumerate offline
    // does not discard a successfully saved Google session.
    return result;
  }));
  ipcMain.handle("auth:switch-account", exclusive(async (id) => {
    const target = store.get(id);
    if (!target) throw new Error("Saved account not found");
    if (target.id === store.state.active) return { ok: true };
    await restartCore(async () => { store.activate(id); await refresh(); prepareCredentials(); }, { preserveRoute: true });
    return { ok: true };
  }));
  ipcMain.handle("auth:select-channel", exclusive(async (id) => {
    if (typeof id !== "string") throw new Error("Invalid channel");
    // Only identities obtained from this Google session may be selected.
    await refreshChannels();
    if (!store.get().channels.some(c => c.id === id)) throw new Error("Channel not found");
    await restartCore(async () => { store.selectChannel(id); prepareCredentials(); }, { preserveRoute: true });
    return { ok: true };
  }));
  const remove = async (id) => {
    const account = store.get(id);
    if (!account) return { ok: true };
    const clear = async () => {
      await auth.signOut(store.directory(account), store.partition(account));
      store.remove(id);
    };
    if (id === store.state.active) await restartCore(clear);
    else await clear();
    return { ok: true };
  };
  ipcMain.handle("auth:remove-account", exclusive(remove));
  ipcMain.handle("auth:sign-out", exclusive(() => remove(store.state.active)));
  ipcMain.handle("auth:refresh", exclusive(async () => {
    const result = await refresh();
    if (result.ok) await restartCore();
    return result;
  }));
  ipcMain.handle("auth:status", () => ({ hasCredentials: Boolean(store.get()) }));
}
function scope() {
 const account = store.get();
 return account ? `${account.legacy ? "legacy" : account.id}:${account.channel || "personal"}` : "guest";
}
function beginShutdown() { closing = true; }
module.exports = { initialize, activeDirectory, activeDatabase, refresh, register, beginShutdown, scope };
