import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  makeRoom,
  addMember,
  snapshot,
  command,
  tick,
  transfer,
  cleanTrack,
  position,
} from "../v2.mjs";
import { createRoomServerV2, limitKey } from "../server-v2.mjs";
const track = (n) => ({
  id: `abcdefghij${n}`,
  title: `Song ${n}`,
  artists: [{ name: "Artist" }],
  durationMs: 10000,
  artwork: [
    {
      url: "https://i.ytimg.com/vi/abcdefghij0/hqdefault.jpg",
      width: 480,
      height: 360,
    },
  ],
  account: { secret: "never send" },
  streamURL: "private",
});
function setup() {
  const room = makeRoom("01234567", {}, 1000),
    leader = addMember(room, { name: "Leader" }),
    guest = addMember(room, { name: "Guest" });
  let i = 0;
  const send = (m, data) =>
    command(
      room,
      m,
      { op: `op-${++i}`, base: room.revision, current: room.current, ...data },
      1000,
    );
  return { room, leader, guest, send };
}
test("allowlisted metadata, attribution, PIN and credentials stay separate", () => {
  const { room, leader, send } = setup();
  send(leader, { kind: "enqueue", tracks: [track(0)] });
  assert.equal(room.queue[0].addedBy.id, leader.id);
  assert.equal(room.queue[0].track.artwork.length, 1);
  assert.equal(room.queue[0].track.streamURL, undefined);
  assert.equal(room.queue[0].track.account, undefined);
  room.creatorIP = "private-ip";
  const wire = JSON.stringify(snapshot(room));
  assert.ok(!wire.includes(leader.token));
  assert.ok(!wire.includes("operations"));
  assert.ok(!wire.includes("private-ip"));
  const dirty = cleanTrack({
    ...track(1),
    artwork: [
      { url: "https://localhost/secret" },
      { url: "file:///tmp/cookie" },
      { url: "https://i.ytimg.com.evil.com/test" },
    ],
  });
  assert.deepEqual(dirty.artwork, []);
});
test("shared timeline deduplicates commands and rejects stale concurrent skips", () => {
  const { room, leader, guest, send } = setup();
  send(leader, { kind: "enqueue", tracks: [track(0), track(1), track(2)] });
  send(guest, { kind: "play" });
  const next = {
    kind: "next",
    op: "unique",
    base: room.revision,
    current: room.current,
  };
  assert.equal(command(room, guest, next, 2000), true);
  const current = room.current;
  assert.equal(command(room, guest, next, 2001), false);
  assert.equal(room.current, current);
  assert.throws(
    () => command(room, leader, { ...next, op: "other" }, 2002),
    /changed/,
  );
  assert.equal(tick(room, 12001), true);
  const revision = room.revision;
  assert.equal(tick(room, 12001), false);
  assert.equal(room.revision, revision);
});
test("permissions distinguish contributions, transport, DJ and moderation", () => {
  const { room, leader, guest, send } = setup();
  send(leader, { kind: "settings", mode: "contributions" });
  send(leader, { kind: "enqueue", tracks: [track(0)] });
  send(guest, { kind: "enqueue", tracks: [track(1)] });
  assert.throws(() => send(guest, { kind: "pause" }), /leader/);
  assert.throws(() => send(guest, { kind: "rotate" }), /leader/);
  send(guest, { kind: "remove", entry: room.queue[1].id });
  send(leader, { kind: "role", member: guest.id, role: "dj" });
  send(guest, { kind: "play" });
  assert.equal(room.playing, true);
  send(leader, { kind: "settings", mode: "listen" });
  send(leader, { kind: "role", member: guest.id, role: "listener" });
  assert.throws(
    () => send(guest, { kind: "enqueue", tracks: [track(2)] }),
    /listen only/,
  );
});
test("handover keeps queue, playback and member identity", () => {
  const { room, leader, guest, send } = setup();
  send(leader, { kind: "enqueue", tracks: [track(0)] });
  send(leader, { kind: "play" });
  const queue = JSON.stringify(room.queue);
  transfer(room, guest.id);
  assert.equal(room.owner, guest.id);
  assert.equal(JSON.stringify(room.queue), queue);
  assert.equal(room.playing, true);
  assert.throws(() => send(leader, { kind: "end" }), /leader/);
});
test("fair queue, bounded contributions, guarded undo and majority skip voting", () => {
  const { room, leader, guest, send } = setup();
  send(leader, { kind: "enqueue", tracks: [track(0), track(1), track(2)] });
  send(guest, { kind: "enqueue", tracks: [track(3), track(4)] });
  send(leader, { kind: "settings", policy: "turns", voteSkip: true });
  assert.equal(room.queue[1].addedBy.id, guest.id);
  assert.equal(room.queue[2].addedBy.id, leader.id);
  const before = room.queue.map((e) => e.id);
  send(guest, { kind: "remove", entry: room.queue[1].id });
  send(guest, { kind: "undo" });
  assert.deepEqual(
    room.queue.map((e) => e.id),
    before,
  );
  const current = room.current;
  send(leader, { kind: "vote" });
  assert.equal(room.current, current);
  send(guest, { kind: "vote" });
  assert.notEqual(room.current, current);
  assert.equal(room.votes.length, 0);
  send(leader, { kind: "settings", limit: 1 });
  assert.throws(
    () => send(guest, { kind: "enqueue", tracks: [track(5), track(6)] }),
    /limit/,
  );
});
test("video hide is presentation only; version swap preserves entry attribution and near timing", () => {
  const { room, leader, guest, send } = setup();
  send(leader, { kind: "enqueue", tracks: [track(0)] });
  send(leader, { kind: "seek", positionMs: 3000 });
  const entry = room.current;
  send(guest, { kind: "variant", track: { ...track(1), isVideo: true } });
  assert.equal(room.current, entry);
  assert.equal(room.queue[0].addedBy.id, leader.id);
  assert.equal(room.positionMs, 3000);
  send(guest, { kind: "display", shown: false });
  assert.equal(room.queue[0].track.id, track(1).id);
  assert.equal(room.positionMs, 3000);
  assert.equal(room.video.shown, false);
  send(leader, { kind: "play" });
  assert.equal(position(room, 2000), 4000);
});
async function connect(url) {
  const ws = new WebSocket(url, { origin: "file://" }),
    messages = [],
    waiters = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw);
    messages.push(message);
    for (const waiter of [...waiters])
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
  });
  const wait = (match) => {
    const existing = messages.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = {
        match,
        resolve,
        timer: setTimeout(
          () => reject(new Error("Timed out: " + JSON.stringify(messages))),
          2000,
        ),
      };
      waiters.push(w);
    });
  };
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const send = (data) => ws.send(JSON.stringify(data));
  await wait((m) => m.type === "hello");
  send({ type: "hello", version: 2 });
  await wait((m) => m.type === "ready");
  return {
    ws,
    messages,
    wait,
    send,
    state: () => messages.filter((m) => m.type === "state").at(-1)?.room,
  };
}
test("real sockets: rotation, reconnect, kick revocation, leave vs end and desktop Origin", async (t) => {
  const server = createRoomServerV2({
    intervalMs: 20,
    // Long enough that a slow CI runner still reconnects within the grace.
    graceMs: 2000,
    emptyMs: 3000,
  });
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  const a = await connect(url);
  a.send({ type: "create", profile: { name: "A" } });
  const aj = await a.wait((m) => m.type === "joined");
  const initial = (await a.wait((m) => m.type === "state")).room;
  const b = await connect(url);
  b.send({ type: "join", pin: initial.pin, profile: { name: "B" } });
  const bj = await b.wait((m) => m.type === "joined");
  await b.wait((m) => m.type === "state");
  a.send({ type: "command", command: { kind: "rotate", op: "rotate" } });
  await a.wait((m) => m.type === "ack" && m.op === "rotate");
  const rotated = a.state();
  assert.notEqual(rotated.pin, initial.pin);
  assert.equal(rotated.members.length, 2);
  const rejected = await connect(url);
  rejected.send({ type: "join", pin: initial.pin });
  await rejected.wait(
    (m) => m.type === "error" && m.message.includes("invalid"),
  );
  rejected.ws.close();
  b.ws.close();
  const resumed = await connect(url);
  resumed.send({ type: "resume", roomId: aj.roomId, token: bj.token });
  const resumedJoin = await resumed.wait((m) => m.type === "joined");
  assert.equal(resumedJoin.member, bj.member);
  a.send({ type: "leave", next: bj.member });
  await resumed.wait((m) => m.type === "state" && m.room.owner === bj.member);
  assert.equal(resumed.state().members.length, 1);
  const c = await connect(url);
  c.send({ type: "join", pin: rotated.pin, profile: { name: "C" } });
  const cj = await c.wait((m) => m.type === "joined");
  resumed.send({
    type: "command",
    command: { kind: "kick", member: cj.member, op: "kick" },
  });
  await c.wait((m) => m.type === "ended");
  const kicked = await connect(url);
  kicked.send({ type: "resume", roomId: aj.roomId, token: cj.token });
  await kicked.wait((m) => m.type === "error" && m.fatal);
  resumed.send({ type: "command", command: { kind: "end", op: "end" } });
  await resumed.wait((m) => m.type === "ended");
});

test("readiness counts connected listeners, starts on a shared anchor, and times out safely", () => {
  const { room, leader, guest, send } = setup();
  send(leader, { kind: "enqueue", tracks: [track(0)] });
  send(leader, { kind: "countdown" });
  send(leader, { kind: "ready", ready: true });
  assert.equal(tick(room, 2000), false);
  send(guest, { kind: "ready", ready: true });
  assert.equal(tick(room, 2000), true);
  assert.equal(room.countdown.startAt, 5000);
  assert.equal(room.playing, false);
  assert.equal(tick(room, 5001), true);
  assert.equal(room.playing, true);
  assert.equal(room.at, 5000);
  send(leader, { kind: "countdown" });
  tick(room, 62000);
  assert.equal(room.countdown, null);
  assert.equal(room.playing, false);
});
test("owner disconnect grace transfers to a connected guest without ending the room", async (t) => {
  const server = createRoomServerV2({ intervalMs: 10, graceMs: 30 });
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  const a = await connect(url);
  a.send({ type: "create", profile: { name: "A" } });
  await a.wait((m) => m.type === "joined");
  const initial = (await a.wait((m) => m.type === "state")).room;
  const b = await connect(url);
  b.send({ type: "join", pin: initial.pin, profile: { name: "B" } });
  const bj = await b.wait((m) => m.type === "joined");
  a.ws.terminate();
  const promoted = await b.wait(
    (m) => m.type === "state" && m.room.owner === bj.member,
  );
  assert.equal(promoted.room.id, initial.id);
  assert.equal(promoted.room.pin, initial.pin);
});
test("join approval does not expose the queue or admit someone before acceptance", async (t) => {
  const server = createRoomServerV2();
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  const a = await connect(url);
  a.send({ type: "create", profile: { name: "A" } });
  await a.wait((m) => m.type === "joined");
  const initial = (await a.wait((m) => m.type === "state")).room;
  a.send({
    type: "command",
    command: {
      kind: "settings",
      joinApproval: true,
      base: initial.revision,
      op: "approval",
    },
  });
  await a.wait((m) => m.type === "ack" && m.op === "approval");
  const b = await connect(url);
  b.send({ type: "join", pin: initial.pin, profile: { name: "B" } });
  await b.wait((m) => m.type === "waiting");
  assert.equal(
    b.messages.some((m) => m.type === "state" || m.type === "joined"),
    false,
  );
  const requested = await a.wait(
    (m) => m.type === "state" && m.room.pending.length === 1,
  );
  a.send({
    type: "command",
    command: {
      kind: "approve",
      request: requested.room.pending[0].id,
      op: "accept",
    },
  });
  await b.wait((m) => m.type === "joined");
  const state = (await b.wait((m) => m.type === "state")).room;
  assert.equal(state.members.length, 2);
  assert.equal(state.pending.length, 0);
});

test("read-only server probe accepts v2 and rejects invalid endpoints without opening a room", async (t) => {
  const { checkRoomServer } = await import("../client-v2.mjs");
  const server = createRoomServerV2();
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  assert.equal(
    await checkRoomServer(`ws://127.0.0.1:${server.http.address().port}`),
    true,
  );
  await assert.rejects(checkRoomServer("not a URL"));
  await assert.rejects(checkRoomServer("ws://example.com"), /wss/);
});

test("room names are bounded public metadata and survive leadership changes", () => {
  const room = makeRoom("12345678", { roomName: "  Friday\nnight  " });
  const first = addMember(room, { name: "First" });
  const next = addMember(room, { name: "Next" });
  assert.equal(snapshot(room).name, "Friday night");
  transfer(room, next.id);
  assert.equal(room.owner, next.id);
  assert.equal(snapshot(room).name, "Friday night");
  assert.equal(makeRoom("12345678", { roomName: "x".repeat(200) }).name.length, 80);
  assert.equal(makeRoom("12345678", { roomName: {} }).name, "");
  assert.equal(makeRoom("12345678").name, "");
});
test("join refusals look alike, and a stale handover still lets the leader leave", async (t) => {
  const server = createRoomServerV2({ intervalMs: 20 });
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  const a = await connect(url);
  a.send({ type: "create", profile: { name: "A" } });
  const aj = await a.wait((m) => m.type === "joined");
  const initial = (await a.wait((m) => m.type === "state")).room;
  const b = await connect(url);
  b.send({ type: "join", pin: initial.pin, profile: { name: "B" } });
  const bj = await b.wait((m) => m.type === "joined");
  await a.wait((m) => m.type === "state" && m.room.members.length === 2);
  a.send({
    type: "command",
    command: { kind: "settings", locked: true, base: a.state().revision, op: "lock" },
  });
  await a.wait((m) => m.type === "ack" && m.op === "lock");
  const refusal = async (pin) => {
    const c = await connect(url);
    c.send({ type: "join", pin, profile: { name: "C" } });
    const { message } = await c.wait((m) => m.type === "error");
    c.ws.close();
    return message;
  };
  const missing = initial.pin === "00000000" ? "00000001" : "00000000";
  assert.equal(await refusal(initial.pin), await refusal(missing));
  a.send({ type: "leave", next: "someone-who-left" });
  await a.wait((m) => m.type === "ended");
  const after = await b.wait(
    (m) => m.type === "state" && m.room.members.length === 1,
  );
  assert.equal(after.room.owner, bj.member);
  assert.notEqual(after.room.owner, aj.member);
});
test("per-source limits group IPv6 clients by /64", () => {
  assert.equal(limitKey("203.0.113.9"), "203.0.113.9");
  assert.equal(limitKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(
    limitKey("2001:db8:1:2:aaaa::1"),
    limitKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"),
  );
  assert.notEqual(limitKey("2001:db8:1:2::1"), limitKey("2001:db8:1:3::1"));
});

const song = (n) => ({ ...track(0), id: `s${String(n).padStart(10, "0")}` });
test("a duplicate queued before duplicates were turned off does not block new songs", () => {
  const { room, leader, send } = setup();
  send(leader, { kind: "enqueue", tracks: [song(1), song(2), song(2)] });
  send(leader, { kind: "settings", duplicates: false });
  send(leader, { kind: "enqueue", tracks: [song(3)] });
  assert.equal(room.queue.at(-1).track.id, song(3).id);
  assert.throws(
    () => send(leader, { kind: "enqueue", tracks: [song(2)] }),
    /Duplicate/,
  );
  assert.throws(
    () => send(leader, { kind: "enqueue", tracks: [song(4), song(4)] }),
    /Duplicate/,
  );
});
test("ready answers belong to one ready check and never make other commands stale", () => {
  const { room, leader, guest, send } = setup();
  send(leader, { kind: "enqueue", tracks: [track(0)] });
  assert.throws(() => send(guest, { kind: "ready", ready: true }), /ready check/);
  send(leader, { kind: "countdown" });
  const revision = room.revision;
  send(guest, { kind: "ready", ready: true });
  assert.equal(room.revision, revision);
  assert.equal(send(guest, { kind: "ready", ready: true }), false);
  // A leader command prepared before the ready answer is still current.
  assert.equal(
    command(room, leader, {
      kind: "seek",
      positionMs: 1000,
      op: "seek-after-ready",
      base: revision,
      current: room.current,
    }),
    true,
  );
  tick(room, 62000);
  assert.equal(room.countdown, null);
  assert.equal(guest.ready, false);
  send(leader, { kind: "countdown" });
  send(leader, { kind: "ready", ready: true });
  assert.equal(room.countdown.startAt, null);
});
test("play next keeps its place when the room takes turns", () => {
  const { room, leader, guest, send } = setup();
  send(leader, { kind: "enqueue", tracks: [song(1), song(2), song(3)] });
  send(leader, { kind: "settings", policy: "turns" });
  send(leader, {
    kind: "enqueue",
    tracks: [song(4)],
    before: room.queue[1].id,
  });
  assert.equal(room.queue[1].track.id, song(4).id);
});
test("played songs do not count against the queue cap or repeat in history", () => {
  const { room, leader, send } = setup();
  send(leader, { kind: "settings", limit: 100 });
  for (let i = 0; i < 5; i++)
    send(leader, {
      kind: "enqueue",
      tracks: Array.from({ length: 100 }, (_, j) => song(i * 100 + j)),
    });
  assert.equal(room.queue.length, 500);
  room.current = room.queue.at(-1).id;
  send(leader, { kind: "enqueue", tracks: [song(900)] });
  assert.ok(room.queue.length <= 22);
  assert.equal(room.queue.at(-1).track.id, song(900).id);
  const history = room.history.length;
  send(leader, { kind: "next" });
  send(leader, { kind: "next" });
  send(leader, { kind: "next" });
  assert.equal(room.history.length, history + 1);
});
test("replacing the queue only counts the new songs against a contribution limit", () => {
  const { room, leader, guest, send } = setup();
  send(leader, { kind: "role", member: guest.id, role: "dj" });
  send(leader, { kind: "settings", limit: 3 });
  send(guest, { kind: "enqueue", tracks: [song(1), song(2), song(3)] });
  send(guest, { kind: "replace", tracks: [song(4), song(5)] });
  assert.deepEqual(
    room.queue.map((e) => e.track.id),
    [song(4).id, song(5).id],
  );
});
test("the undo offer names who may take it", () => {
  const { room, leader, guest, send } = setup();
  send(leader, { kind: "settings", mode: "contributions" });
  send(leader, { kind: "enqueue", tracks: [song(1)] });
  send(guest, { kind: "enqueue", tracks: [song(2)] });
  send(guest, { kind: "remove", entry: room.queue[1].id });
  assert.equal(snapshot(room).undo.by, guest.id);
});
test("a burst of status changes reaches everyone as a few states, and no one is dropped", async (t) => {
  const server = createRoomServerV2({ intervalMs: 20 });
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  const a = await connect(url);
  a.send({ type: "create", mode: "listen", profile: { name: "A" } });
  const initial = (await a.wait((m) => m.type === "state")).room;
  const b = await connect(url);
  b.send({ type: "join", pin: initial.pin, profile: { name: "B" } });
  await b.wait((m) => m.type === "joined");
  await new Promise((r) => setTimeout(r, 300));
  const before = a.messages.filter((m) => m.type === "state").length;
  let closed = false;
  a.ws.on("close", () => (closed = true));
  for (let i = 0; i < 90; i++)
    b.send({ type: "status", status: i % 2 ? "paused" : "listening" });
  await new Promise((r) => setTimeout(r, 600));
  const states = a.messages.filter((m) => m.type === "state").length - before;
  assert.equal(closed, false);
  assert.ok(states >= 1 && states <= 6, `${states} states`);
  assert.equal(
    a.state().members.find((m) => m.name === "B").status,
    "paused",
  );
});
test("guessing PINs cannot stop members with a credential from reconnecting", async (t) => {
  const server = createRoomServerV2({ trustProxy: true });
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  const a = await connect(url);
  a.send({ type: "create", profile: { name: "A" } });
  const joined = await a.wait((m) => m.type === "joined");
  const from = async (address) => {
    const ws = new WebSocket(url, {
      origin: "file://",
      headers: { "x-forwarded-for": address },
    });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "hello", version: 2 }));
    return ws;
  };
  for (let i = 0; i < 21; i++) {
    const ws = await from(`2001:db8:${i}::1`);
    for (let j = 0; j < 30; j++)
      ws.send(JSON.stringify({ type: "join", pin: "00000000" }));
  }
  await new Promise((r) => setTimeout(r, 300));
  a.ws.close();
  const back = await connect(url);
  back.send({ type: "resume", roomId: joined.roomId, token: joined.token });
  await back.wait((m) => m.type === "joined");
});
test("a retried moderation command is acknowledged, and old apps are told to update", async (t) => {
  const server = createRoomServerV2();
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  const a = await connect(url);
  a.send({ type: "create", profile: { name: "A" } });
  const initial = (await a.wait((m) => m.type === "state")).room;
  const b = await connect(url);
  b.send({ type: "join", pin: initial.pin, profile: { name: "B" } });
  const bj = await b.wait((m) => m.type === "joined");
  const kick = { kind: "kick", member: bj.member, op: "kick-once" };
  a.send({ type: "command", command: kick });
  await a.wait((m) => m.type === "ack" && m.op === "kick-once");
  a.send({ type: "command", command: kick });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    a.messages.filter((m) => m.type === "ack" && m.op === "kick-once").length,
    2,
  );
  assert.ok(!a.messages.some((m) => m.type === "error"));
  const old = new WebSocket(url, { origin: "file://" });
  const messages = [];
  old.on("message", (raw) => messages.push(JSON.parse(raw)));
  await new Promise((r) => old.once("open", r));
  old.send(JSON.stringify({ type: "create" }));
  await new Promise((r) => old.once("close", r));
  assert.match(
    messages.find((m) => m.type === "error").message,
    /newer version of the app/,
  );
});

test("the app's client resumes its seat after a dropped connection and forgets it on stop", async (t) => {
  const { RoomClientV2 } = await import("../client-v2.mjs");
  const server = createRoomServerV2({ intervalMs: 20 });
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const statuses = [],
    errors = [];
  let member = "",
    ended = null;
  const joins = [];
  const client = new RoomClientV2({
    onState: () => {},
    onStatus: (s) => statuses.push(s),
    onError: (e) => errors.push(e),
    onEnded: (reason) => (ended = reason),
    onJoined: (id) => {
      member = id;
      joins.push(id);
    },
  });
  const until = async (check) => {
    for (let i = 0; i < 200 && !check(); i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(check());
  };
  client.connect({
    server: `ws://127.0.0.1:${server.http.address().port}`,
    profile: { name: "App" },
  });
  await until(() => joins.length === 1 && client.state);
  client.socket.close();
  await until(() => joins.length === 2);
  assert.equal(joins[1], member);
  assert.ok(statuses.includes("reconnecting"));
  assert.equal(ended, null);
  client.stop();
  assert.equal(client.credential, null);
});
test("the app's client recognises a relay that never greets within a few seconds of connecting", async (t) => {
  const { RoomClientV2 } = await import("../client-v2.mjs");
  const { WebSocketServer } = await import("ws");
  const silent = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => silent.once("listening", r));
  t.after(() => new Promise((r) => silent.close(r)));
  const started = Date.now();
  const reason = await new Promise((resolve) => {
    new RoomClientV2({
      onState: () => {},
      onStatus: () => {},
      onError: () => {},
      onEnded: resolve,
    }).connect({
      server: `ws://127.0.0.1:${silent.address().port}`,
      profile: { name: "App" },
    });
  });
  assert.match(reason, /No v2 handshake/);
  assert.ok(Date.now() - started < 6000);
  for (const ws of silent.clients) ws.terminate();
});
