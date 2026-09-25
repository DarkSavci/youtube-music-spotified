// Discord's local IPC protocol. No user token, login or network API is used.
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

function frame(op, data) {
  const body = Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
function endpoints(platform = process.platform, env = process.env) {
  const roots = [
    ...new Set(
      [
        env.XDG_RUNTIME_DIR,
        env.TMPDIR,
        env.TMP,
        env.TEMP,
        os.tmpdir(),
        "/tmp",
      ].filter(Boolean),
    ),
  ];
  return Array.from({ length: 10 }, (_, i) =>
    platform === "win32"
      ? [`\\\\?\\pipe\\discord-ipc-${i}`]
      : roots.map((root) => path.posix.join(root, `discord-ipc-${i}`)),
  ).flat();
}
const text = (value) =>
  typeof value === "string"
    ? value
        .replace(/[\x00-\x1f]/g, " ")
        .trim()
        .slice(0, 128)
    : "";
function activity(input, now = Date.now()) {
  if (!input || input.playing !== true || !/^[\w-]{11}$/.test(input.id || ""))
    return null;
  const result = {
    type: 2,
    details: text(input.title) || "Listening to music",
    state: text(input.artist) || "YouTube Music",
    buttons: [
      {
        label: "Listen on YouTube Music",
        url: `https://music.youtube.com/watch?v=${input.id}`,
      },
    ],
  };
  try {
    const art = new URL(input.artwork);
    if (
      art.href.length <= 2048 &&
      art.protocol === "https:" &&
      !art.username &&
      !art.password &&
      [
        "i.ytimg.com",
        "lh3.googleusercontent.com",
        "yt3.googleusercontent.com",
        "yt3.ggpht.com",
      ].includes(art.hostname)
    ) {
      result.assets = {
        large_image: art.href,
        large_text: text(input.album) || result.details,
      };
    }
  } catch {}
  const duration = Number(input.durationMs),
    position = Number(input.positionMs),
    speed = Number(input.speed) || 1;
  if (
    Number.isFinite(duration) &&
    Number.isFinite(position) &&
    duration > 0 &&
    position >= 0 &&
    position < duration &&
    speed >= 0.5 &&
    speed <= 3
  ) {
    result.timestamps = {
      start: Math.floor((now - position / speed) / 1000),
      end: Math.floor((now + (duration - position) / speed) / 1000),
    };
  }
  if (input.shareRoom === true && text(input.roomName))
    result.state = text(`${result.state} · ${text(input.roomName)}`);
  return result;
}
class DiscordPresence {
  constructor({
    connect = (p) => net.createConnection(p),
    paths = endpoints(),
    onStatus = () => {},
  } = {}) {
    this.onStatus = onStatus;
    this.connect = connect;
    this.paths = paths;
    this._status = "disabled";
    this.clientId = "";
    this.desired = null;
    this.ready = false;
    this.generation = 0;
  }
  // Connecting finishes after update() has answered, so changes are also
  // pushed; otherwise Settings would show a stale state until the next send.
  get status() {
    return this._status;
  }
  set status(value) {
    if (value === this._status) return;
    this._status = value;
    this.onStatus(value);
  }
  update(value = {}) {
    const id = typeof value.clientId === "string" ? value.clientId.trim() : "";
    if (value.enabled !== true || !/^\d{17,20}$/.test(id)) {
      this.stop(value.enabled === true ? "needs-application-id" : "disabled");
      return;
    }
    if (this.clientId !== id) {
      this.stop();
      this.clientId = id;
    }
    this.desired = activity(value);
    if (!this.socket && !this.retry && this.rejected !== id) this.open();
    if (this.ready) this.flush();
  }
  open(index = 0) {
    if (!this.clientId) return;
    if (index >= this.paths.length) {
      this.status = "waiting-for-discord";
      this.retry = setTimeout(() => {
        this.retry = null;
        this.open();
      }, 15000);
      this.retry.unref?.();
      return;
    }
    this.status = "connecting";
    const generation = this.generation;
    const socket = this.connect(this.paths[index]);
    this.socket = socket;
    let buffer = Buffer.alloc(0),
      connected = false;
    const timeout = setTimeout(() => socket.destroy(), 2000);
    timeout.unref?.();
    socket.on("connect", () => {
      connected = true;
      socket.write(frame(0, { v: 1, client_id: this.clientId }));
    });
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (this.socket !== socket) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const op = buffer.readUInt32LE(0),
          length = buffer.readUInt32LE(4);
        if (length > 65536) {
          socket.destroy();
          return;
        }
        if (buffer.length < 8 + length) return;
        let payload;
        try {
          payload = JSON.parse(buffer.subarray(8, 8 + length).toString());
        } catch {
          socket.destroy();
          return;
        }
        buffer = buffer.subarray(8 + length);
        if (op === 3) socket.write(frame(4, payload));
        // Discord refuses the handshake itself, e.g. "Invalid Client ID".
        // Retrying the same ID cannot succeed, so say so instead of waiting.
        if (op === 2) {
          this.rejected = this.clientId;
          this.status = "error";
          socket.destroy();
          return;
        }
        if (op === 1 && payload.evt === "READY") {
          clearTimeout(timeout);
          this.ready = true;
          this.status = "connected";
          this.flush();
        } else if (op === 1 && payload.evt === "ERROR") this.status = "error";
        else if (op === 1 && payload.cmd === "SET_ACTIVITY")
          this.status = "connected";
      }
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      if (generation !== this.generation || this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      this.lastSent = "";
      this.sentAt = 0;
      if (this.rejected === this.clientId) return;
      if (!connected) this.open(index + 1);
      else {
        this.status = "waiting-for-discord";
        this.retry = setTimeout(() => {
          this.retry = null;
          this.open();
        }, 15000);
        this.retry.unref?.();
      }
    });
  }
  flush() {
    const value = JSON.stringify(this.desired);
    if (!this.ready || value === this.lastSent) return;
    if (this.desired && Date.now() - (this.sentAt || 0) < 5000) {
      if (!this.pending) {
        this.pending = setTimeout(
          () => {
            this.pending = null;
            this.flush();
          },
          5000 - (Date.now() - this.sentAt),
        );
        this.pending.unref?.();
      }
      return;
    }
    clearTimeout(this.pending);
    this.pending = null;
    this.sentAt = Date.now();
    this.lastSent = value;
    this.socket.write(
      frame(1, {
        cmd: "SET_ACTIVITY",
        args: { pid: process.pid, activity: this.desired },
        nonce: crypto.randomUUID(),
      }),
    );
  }
  stop(status = "disabled") {
    this.rejected = "";
    clearTimeout(this.pending);
    this.pending = null;
    this.sentAt = 0;
    this.generation++;
    clearTimeout(this.retry);
    this.retry = null;
    if (this.ready) {
      this.desired = null;
      this.flush();
    }
    this.socket?.destroy();
    this.socket = null;
    this.ready = false;
    this.clientId = "";
    this.lastSent = "";
    this.status = status;
  }
}
module.exports = { DiscordPresence, activity, endpoints, frame };
