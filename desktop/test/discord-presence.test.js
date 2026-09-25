const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  DiscordPresence,
  activity,
  endpoints,
  frame,
} = require("../discord-presence");
const sample = {
  enabled: true,
  clientId: "123456789012345678",
  playing: true,
  id: "abcdefghijk",
  title: "Song",
  artist: "Artist",
  durationMs: 180000,
  positionMs: 30000,
  speed: 1,
  artwork: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
};
class Socket extends EventEmitter {
  writes = [];
  write(value) {
    this.writes.push(JSON.parse(value.subarray(8)));
  }
  destroy() {
    this.emit("close");
  }
}
test("only public track metadata is published, room name requires opt-in", () => {
  const input = {
    ...sample,
    roomName: "Friday",
    pin: "12345678",
    token: "secret",
    server: "wss://private.example",
    streamURL: "secret",
  };
  const result = activity(input, 100000);
  assert.deepEqual(result.timestamps, { start: 70, end: 250 });
  assert.equal(result.state, "Artist");
  assert.equal(
    activity({ ...input, shareRoom: true }).state,
    "Artist · Friday",
  );
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.equal(activity({ ...sample, playing: false }), null);
  assert.equal(activity({ ...sample, id: "../private" }), null);
  assert.equal(
    activity({ ...sample, artwork: "https://localhost/secret" }).assets,
    undefined,
  );
});
test("disabled and invalid application IDs never open a socket", () => {
  const client = new DiscordPresence({
    connect: () => {
      throw Error("unexpected connection");
    },
  });
  client.update({ ...sample, enabled: false });
  assert.equal(client.status, "disabled");
  client.update({ ...sample, clientId: "bad" });
  assert.equal(client.status, "needs-application-id");
});
test("IPC handshake handles fragmented frames, ping, pause and shutdown", () => {
  const socket = new Socket();
  const client = new DiscordPresence({
    connect: () => socket,
    paths: ["test"],
  });
  client.update(sample);
  socket.emit("connect");
  assert.equal(socket.writes[0].client_id, sample.clientId);
  const ready = frame(1, { evt: "READY" });
  socket.emit("data", ready.subarray(0, 5));
  assert.equal(client.ready, false);
  socket.emit("data", ready.subarray(5));
  assert.equal(client.status, "connected");
  assert.equal(socket.writes[1].cmd, "SET_ACTIVITY");
  socket.emit("data", frame(3, { hello: true }));
  assert.deepEqual(socket.writes.at(-1), { hello: true });
  client.update({ ...sample, playing: false });
  assert.equal(socket.writes.at(-1).args.activity, null);
  client.stop();
  assert.equal(client.socket, null);
});
test("oversized IPC frames are rejected and reconnect is cancellable", () => {
  const socket = new Socket();
  const client = new DiscordPresence({
    connect: () => socket,
    paths: ["test"],
  });
  client.update(sample);
  socket.emit("connect");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(1000000, 4);
  socket.emit("data", header);
  assert.equal(client.status, "waiting-for-discord");
  client.stop();
  assert.equal(client.retry, null);
});
test("Windows IPC uses named pipes and macOS tries runtime directories", () => {
  assert.equal(endpoints("win32", {})[0], "\\\\?\\pipe\\discord-ipc-0");
  assert.ok(
    endpoints("darwin", { TMPDIR: "/test-runtime" }).includes(
      "/test-runtime/discord-ipc-0",
    ),
  );
});
test("status changes after connecting are pushed, not only returned", () => {
  const statuses = [];
  const socket = new Socket();
  const presence = new DiscordPresence({
    connect: () => socket,
    paths: ["pipe"],
    onStatus: (s) => statuses.push(s),
  });
  assert.deepEqual(statuses, []);
  presence.update(sample);
  socket.emit("connect");
  const ready = { cmd: "DISPATCH", evt: "READY" };
  socket.emit("data", frame(1, ready));
  assert.deepEqual(statuses, ["connecting", "connected"]);
  presence.update({ enabled: true, clientId: "" });
  assert.equal(statuses.at(-1), "needs-application-id");
  assert.ok(!statuses.slice(2).includes("disabled"));
});
test("a refused application ID reports an error and stops retrying until it changes", () => {
  const sockets = [];
  const presence = new DiscordPresence({
    connect: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    paths: ["pipe"],
  });
  presence.update(sample);
  sockets[0].emit("connect");
  sockets[0].emit(
    "data",
    frame(2, { code: 4000, message: "Invalid Client ID" }),
  );
  assert.equal(presence.status, "error");
  assert.equal(presence.retry, null);
  presence.update(sample);
  assert.equal(sockets.length, 1);
  assert.equal(presence.status, "error");
  presence.update({ ...sample, clientId: "223456789012345678" });
  assert.equal(sockets.length, 2);
  assert.equal(presence.status, "connecting");
  presence.stop();
});
test("a rate-limit close retries instead of blaming the application ID", () => {
  const socket = new Socket();
  const presence = new DiscordPresence({ connect: () => socket, paths: ["pipe"] });
  presence.update(sample);
  socket.emit("connect");
  socket.emit("data", frame(2, { code: 4002, message: "Rate limited" }));
  assert.equal(presence.status, "waiting-for-discord");
  assert.ok(presence.retry);
  presence.stop();
});
