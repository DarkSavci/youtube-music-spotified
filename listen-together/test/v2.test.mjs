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
import { createRoomServerV2 } from "../server-v2.mjs";
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
    graceMs: 200,
    emptyMs: 300,
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
