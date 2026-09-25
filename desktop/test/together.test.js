const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("../../ui/node_modules/typescript");
const crypto = require("node:crypto");
function create(initial) {
  if (!initial) return (initial) => create(initial);
  let state;
  const listeners = new Set();
  const store = () => state;
  store.getState = () => state;
  store.setState = (patch) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn(state);
  };
  store.subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  state = initial(store.setState, store.getState);
  return store;
}
async function setup(t) {
  const protocol = await import("../../listen-together/protocol.mjs");
  const player = create(() => ({
    track: null,
    queue: [],
    index: 0,
    state: "paused",
    followingRoom: false,
    notice: null,
    anchor: { positionMs: 0, atMs: performance.now(), rate: 0 },
  }));
  const video = create(() => ({ enabled: false, revision: 0 }));
  const clients = [],
    calls = [],
    toasts = [];
  let route, hold;
  class Client {
    constructor(options) {
      Object.assign(this, options);
      clients.push(this);
      this.commands = [];
      this.sent = [];
    }
    connect() {
      this.onStatus("connecting");
      this.onJoined("self");
      this.onStatus("connected");
    }
    serverNow() {
      return Date.now();
    }
    command(c) {
      this.commands.push(c);
      return Promise.resolve(true);
    }
    send(c) {
      this.sent.push(c);
    }
    leave() {}
    stop() {}
  }
  const module = { exports: {} };
  const code = ts.transpileModule(
    fs.readFileSync(require.resolve("../../ui/src/lib/together.ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    Date,
    Math,
    Promise,
    Error,
    crypto,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    require: (n) => {
      if (n === "zustand") return { create };
      if (n === "zustand/middleware") return { persist: (i) => i };
      if (n.endsWith("client-v2.mjs")) return { RoomClientV2: Client };
      if (n.endsWith("protocol.mjs")) return protocol;
      if (n === "./player")
        return {
          usePlayer: player,
          currentPosition: (s) => s.anchor.positionMs,
        };
      if (n === "./video") return { useVideo: video };
      if (n === "./toast") return { toast: (m) => toasts.push(m) };
      if (n === "./playback")
        return {
          isServerAuthoritative: () => true,
          setRoomTransport: (r) => (route = r),
          // Like the core: leaving only pauses when a room was followed.
          leaveRoomPlayback: async () => {
            if (player.getState().followingRoom)
              player.setState({ followingRoom: false, state: "paused" });
          },
          syncRoomPlayback: async (
            track,
            positionMs,
            playing,
            queue,
            index,
          ) => {
            calls.push({ track, positionMs, playing, queue, index });
            if (hold) await hold;
            player.setState({
              track,
              queue,
              index,
              followingRoom: true,
              state: playing ? "playing" : "paused",
              anchor: {
                positionMs,
                atMs: performance.now(),
                rate: playing ? 1 : 0,
              },
            });
          },
        };
      throw Error(n);
    },
  });
  const api = module.exports;
  t.after(() => api.leaveTogether());
  return {
    api,
    player,
    video,
    clients,
    calls,
    toasts,
    route: (...args) => route(...args),
    hold: (p) => (hold = p),
    flush: () => new Promise((r) => setImmediate(r)),
  };
}
function room(revision = 1, patch = {}) {
  return {
    id: "room",
    pin: "01234567",
    owner: "other",
    members: [{ id: "self", name: "Self", role: "listener", connected: true }],
    mode: "collaborative",
    revision,
    current: "entry1",
    queue: [
      {
        id: "entry1",
        track: {
          id: "abcdefghij0",
          title: "Track",
          durationMs: 180000,
          artists: [],
          artwork: [
            {
              url: "https://i.ytimg.com/vi/abcdefghij0/hqdefault.jpg",
              width: 480,
              height: 360,
            },
          ],
          playable: true,
          isVideo: false,
        },
        addedBy: { id: "other", name: "Friend" },
      },
      {
        id: "entry2",
        track: {
          id: "abcdefghij1",
          title: "Next",
          durationMs: 180000,
          artists: [],
          artwork: [],
          playable: true,
          isVideo: false,
        },
        addedBy: { id: "self", name: "Self" },
      },
    ],
    positionMs: 10000,
    at: Date.now(),
    playing: true,
    activity: [],
    video: null,
    ...patch,
  };
}
const options = {
  server: "ws://localhost:8766",
  pin: "01234567",
  profile: { name: "Self" },
};
test("every participant follows canonical queue with artwork, and transport sends room commands", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether(options);
  const c = h.clients[0];
  c.onState(room());
  await h.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.player.getState().queue.length, 2);
  assert.equal(h.player.getState().track.artwork.length, 1);
  h.route("toggle");
  h.route("enqueue", { tracks: [h.player.getState().track] });
  h.route("remove", { at: 1 });
  assert.equal(c.commands[0].kind, "pause");
  assert.equal(c.commands[1].kind, "enqueue");
  assert.equal(c.commands[2].entry, "entry2");
  c.onState(room(2, { positionMs: 50000 }));
  await h.flush();
  assert.ok(h.calls.at(-1).positionMs >= 50000);
});
test("video display opt-in never changes the selected canonical media", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether(options);
  const c = h.clients[0];
  const r = room();
  r.queue[0].track.isVideo = true;
  r.video = { shown: true, by: "other", revision: 1 };
  c.onState(r);
  await h.flush();
  assert.equal(h.video.getState().enabled, false);
  assert.equal(h.player.getState().track.isVideo, true);
  h.api.useRoomPreferences.getState().update({ followVideo: true });
  c.onState({
    ...r,
    revision: 2,
    video: { shown: true, by: "other", revision: 2 },
  });
  await h.flush();
  assert.equal(h.video.getState().enabled, true);
  assert.equal(c.commands.length, 0);
});
test("disconnected playback pauses before a reconnect snapshot, and old sessions cannot write to new rooms", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether(options);
  const old = h.clients[0];
  old.onState(room());
  await h.flush();
  old.onStatus("reconnecting");
  await h.flush();
  assert.equal(h.player.getState().state, "paused");
  old.onStatus("connected");
  old.onState(room(2, { positionMs: 65000 }));
  await h.flush();
  assert.ok(h.calls.at(-1).positionMs >= 65000);
  await h.api.leaveTogether();
  await h.api.connectTogether(options);
  const next = h.clients[1];
  next.onState(room(1, { current: "entry2" }));
  await h.flush();
  old.onState(room(99));
  old.onEnded("Old error");
  await h.flush();
  assert.equal(h.player.getState().track.id, "abcdefghij1");
  assert.equal(h.api.useTogether.getState().error, null);
});
test("leave waits for an in-flight local correction before unlocking playback", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether(options);
  let finish;
  h.hold(new Promise((r) => (finish = r)));
  h.clients[0].onState(room());
  const leaving = h.api.leaveTogether();
  finish();
  await leaving;
  assert.equal(h.player.getState().followingRoom, false);
  assert.equal(h.player.getState().state, "paused");
});
test("listeners without permission are answered locally instead of sending doomed commands", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether(options);
  const c = h.clients[0];
  c.onState(room(1, { mode: "listen" }));
  await h.flush();
  for (const kind of ["toggle", "next", "seek", "jump", "repeat"])
    assert.equal(h.route(kind, { at: 0, positionMs: 0 }), true);
  h.route("enqueue", { tracks: [h.player.getState().track] });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(c.commands.length, 0);
  assert.equal(h.toasts.length, 6);
  c.onState(room(2, { mode: "contributions" }));
  await h.flush();
  h.route("enqueue", { tracks: [h.player.getState().track] });
  h.route("remove", { at: 1 });
  h.route("remove", { at: 0 });
  h.route("enqueueNext", { tracks: [h.player.getState().track] });
  assert.deepEqual(
    c.commands.map((x) => [x.kind, x.entry]),
    [
      ["enqueue", undefined],
      ["remove", "entry2"],
    ],
  );
});
test("a seek-bar drag sends only where it settles", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether(options);
  const c = h.clients[0];
  c.onState(room());
  await h.flush();
  for (let ms = 0; ms <= 60000; ms += 1000) h.route("seek", { positionMs: ms });
  assert.equal(c.commands.length, 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(
    c.commands.map((x) => [x.kind, x.positionMs]),
    [["seek", 60000]],
  );
});
test("play next with nothing queued after the current song is an append guests may make", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether(options);
  const c = h.clients[0];
  const r = room(1, { mode: "contributions" });
  r.queue = r.queue.slice(0, 1);
  c.onState(r);
  await h.flush();
  h.route("enqueueNext", { tracks: [h.player.getState().track] });
  assert.equal(c.commands.length, 1);
  assert.equal(c.commands[0].kind, "enqueue");
  assert.equal(c.commands[0].before, undefined);
});
test("a settled seek stays pinned to the song it was dragged on", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether(options);
  const c = h.clients[0];
  c.onState(room());
  await h.flush();
  h.route("seek", { positionMs: 60000 });
  c.onState(room(2, { current: "entry2" }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(c.commands.length, 1);
  assert.equal(c.commands[0].current, "entry1");
});
test("tiny drift is left alone, an unavailable song is not retried in a loop, and Retry resyncs once", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether(options);
  const c = h.clients[0];
  c.onState(room(1, { playing: false, positionMs: 12000 }));
  await h.flush();
  const count = h.calls.length;
  c.onState(room(2, { playing: false, positionMs: 12100 }));
  await h.flush();
  assert.equal(h.calls.length, count, "tiny drift should not seek");
  h.player.setState({
    track: { ...h.player.getState().track, playable: false },
    notice: "Unavailable",
  });
  c.onState(room(3, { playing: true, positionMs: 12100 }));
  await h.flush();
  assert.equal(h.calls.length, count, "failed song must not loop retries");
  h.api.retryTogetherPlayback();
  await h.flush();
  assert.equal(h.calls.length, count + 1);
});
test("after reconnecting nothing is replayed until the relay sends a fresh state", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether(options);
  const c = h.clients[0];
  c.onState(room(1));
  await h.flush();
  c.onStatus("reconnecting");
  await h.flush();
  assert.equal(h.player.getState().state, "paused");
  const count = h.calls.length;
  h.api.retryTogetherPlayback();
  await h.flush();
  assert.equal(h.calls.length, count, "old state must not resume while reconnecting");
  c.onStatus("connected");
  h.api.retryTogetherPlayback();
  await h.flush();
  assert.equal(h.calls.length, count, "wait for a fresh state after reconnecting");
  c.onState(room(1, { positionMs: 30000 }));
  await h.flush();
  assert.equal(h.player.getState().state, "playing");
  assert.ok(h.player.getState().anchor.positionMs >= 30000);
});
test("an empty room is followed once, not re-synced every second", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether({ ...options, pin: "01234567" });
  const c = h.clients[0];
  c.onState(room(1, { queue: [], current: null, playing: false }));
  await h.flush();
  const count = h.calls.length;
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(h.calls.length, count);
});
test("a seek that arrives during another sync is applied as soon as that sync ends", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether(options);
  const c = h.clients[0];
  c.onState(room(1, { playing: false, positionMs: 10000 }));
  await h.flush();
  let release;
  h.hold(new Promise((r) => (release = r)));
  c.onState(room(2, { playing: true, positionMs: 10000 }));
  await h.flush();
  c.onState(room(3, { playing: true, positionMs: 120000 }));
  await h.flush();
  h.hold(null);
  release();
  await h.flush();
  await h.flush();
  assert.ok(h.calls.at(-1).positionMs >= 120000);
});
test("queue edits wait while the app's copy of the room queue is behind", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether(options);
  const c = h.clients[0];
  c.onState(room(1));
  await h.flush();
  h.player.setState({ queue: h.player.getState().queue.slice(0, 1) });
  h.route("remove", { at: 1 });
  assert.equal(c.commands.length, 0);
  assert.match(h.toasts.at(-1), /queue changed/);
});
test("your own music stays yours while a room is connecting or awaiting approval", async (t) => {
  const h = await setup(t);
  await h.api.connectTogether(options);
  h.api.useTogether.setState({ status: "waiting", room: null });
  assert.equal(h.route("toggle"), false);
  h.api.useTogether.setState({ status: "connecting", room: null });
  assert.equal(h.route("next"), false);
});
test("creating a room from a playing song keeps it playing until the room has it", async (t) => {
  const h = await setup(t);
  const song = room(1).queue[0].track;
  h.player.setState({
    track: song,
    queue: [song],
    index: 0,
    state: "playing",
    anchor: { positionMs: 42000, atMs: performance.now(), rate: 1 },
  });
  await h.api.connectTogether({ ...options, pin: undefined });
  const c = h.clients[0];
  const answers = [];
  c.command = (cmd) => {
    c.commands.push(cmd);
    return new Promise((r) => answers.push(() => r(true)));
  };
  c.onState(room(1, { owner: "self", queue: [], current: null, playing: false }));
  await h.flush();
  assert.deepEqual(
    c.commands.map((x) => x.kind),
    ["enqueue"],
  );
  c.onState(room(2, { owner: "self", queue: [room(1).queue[0]], playing: false, positionMs: 0 }));
  await h.flush();
  answers.shift()();
  await h.flush();
  answers.shift()();
  await h.flush();
  c.onState(room(4, { owner: "self", queue: [room(1).queue[0]], playing: true, positionMs: 42000 }));
  assert.equal(h.calls.length, 0, "the room's first states must not stop the music");
  answers.shift()();
  await h.flush();
  await h.flush();
  assert.deepEqual(
    c.commands.map((x) => x.kind),
    ["enqueue", "seek", "play"],
  );
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].playing, true);
  assert.ok(h.calls[0].positionMs >= 42000);
});
