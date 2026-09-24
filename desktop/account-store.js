const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

/** Only opaque local IDs become paths. Remote names never become filenames. */
class AccountStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, "accounts.json");
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (this.state.version !== 1 || !Array.isArray(this.state.accounts)) throw new Error("Unsupported account store");
    } else {
      this.state = { version: 1, active: null, accounts: [] };
      if (fs.existsSync(path.join(root, "credentials.json"))) {
        const account = this.create("Saved account", true);
        this.state.accounts.push(account);
        this.state.active = account.id;
      }
      this.save();
    }
  }
  save() { writeJSON(this.file, this.state); }
  create(name = "New account", legacy = false) {
    return { id: randomUUID(), name, legacy, channel: "", channels: [] };
  }
  get(id = this.state.active) {
    const item = this.state.accounts.find(a => a.id === id);
    if (id && !item) throw new Error("Saved account not found");
    return item || null;
  }
  directory(account = this.get()) {
    if (!account) return path.join(this.root, "guest");
    if (account.legacy) return this.root;
    if (!/^[\da-f-]{36}$/.test(account.id)) throw new Error("Invalid account ID");
    return path.join(this.root, "accounts", account.id);
  }
  partition(account = this.get()) {
    return account?.legacy ? "persist:ytmusic" : account ? `persist:ytmusic-${account.id}` : "persist:ytmusic-guest";
  }
  database(account = this.get()) {
    if (!account || !account.channel) return path.join(this.directory(account), "spotifier.db");
    const channel = account.channels.find(c => c.id === account.channel);
    if (!channel || !/^[\da-f-]{36}$/.test(channel.localId)) throw new Error("Channel not found");
    return path.join(this.directory(account), "channels", channel.localId, "spotifier.db");
  }
  publicState() {
    return { activeId: this.state.active, accounts: this.state.accounts.map(a => ({
      id: a.id, name: a.name, avatarUrl: a.avatarUrl, channel: a.channel,
      channels: a.channels.map(({ id, name, handle, avatarUrl }) => ({ id, name, handle, avatarUrl })),
    })) };
  }
  add(account) { this.state.accounts.push(account); this.state.active = account.id; this.save(); }
  activate(id) { this.get(id); this.state.active = id; this.save(); }
  setName(name, avatarUrl) {
    const account = this.get();
    if (!account) return;
    if (name && ["Saved account", "New account"].includes(account.name)) account.name = name;
    if (!account.channel && avatarUrl) account.avatarUrl = avatarUrl;
    this.save();
  }
  setChannels(channels, name) {
    const account = this.get();
    if (!account) throw new Error("Sign in first");
    account.name = name || account.name;
    account.channels = channels.map(c => ({ ...c, localId: account.channels.find(old => old.id === c.id)?.localId || randomUUID() }));
    this.save();
  }
  selectChannel(id) {
    const account = this.get();
    if (!account?.channels.some(c => c.id === id)) throw new Error("Channel not found");
    account.channel = id;
    this.save();
  }
  remove(id) {
    this.get(id);
    this.state.accounts = this.state.accounts.filter(a => a.id !== id);
    if (this.state.active === id) this.state.active = null;
    this.save();
  }
}
module.exports = { AccountStore, writeJSON };
