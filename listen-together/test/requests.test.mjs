import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  tick,
  makeRoom,
  addMember,
  command,
  dropRequests,
  transfer,
} from "../v2.mjs";
import { createRoomServerV2 } from "../server-v2.mjs";

const song = (n) => ({
  id: `requestsng${n}`,
  title: `Song ${n}`,
  artists: [{ name: "Artist" }],
  durationMs: 10000,
  artwork: [],
});
function setup(settings = { mode: "contributions" }) {
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
  send(leader, { kind: "settings", ...settings });
  return { room, leader, guest, send };
}

test("a guest's song in a room that takes requests waits for the leader", () => {
  const { room, leader, guest, send } = setup();
  send(leader, { kind: "enqueue", tracks: [song(0)] });
  const revision = room.revision;
  // Older apps still send a plain addition; it becomes a request too.
  send(guest, { kind: "enqueue", tracks: [song(1)] });
  send(guest, { kind: "request", tracks: [song(2)] });
  assert.equal(room.queue.length, 1);
  assert.deepEqual(
    room.requests.map((r) => [r.track.id, r.by.id]),
    [
      [song(1).id, guest.id],
      [song(2).id, guest.id],
    ],
  );
  // Waiting requests must not make the leader's pending commands stale.
  assert.equal(room.revision, revision);
  assert.match(room.activity.at(-1).text, /Guest requested Song 2/);
});

test("accepting keeps the requester's attribution and chosen position", () => {
  const { room, leader, guest, send } = setup();
  send(leader, { kind: "enqueue", tracks: [song(0), song(1)] });
  send(guest, { kind: "request", tracks: [song(2)] });
  send(guest, { kind: "request", tracks: [song(3)] });
  const [first, second] = room.requests;
  const revision = room.revision;
  send(leader, { kind: "acceptRequest", request: second.id, placement: "next" });
  assert.equal(room.revision, revision + 1);
  assert.deepEqual(
    room.queue.map((e) => e.track.id),
    [song(0).id, song(3).id, song(1).id],
  );
  assert.equal(room.queue[1].addedBy.id, guest.id);
  assert.equal(room.queue[1].request, second.id);
  send(leader, { kind: "acceptRequest", request: first.id });
  assert.equal(room.queue.at(-1).track.id, song(2).id);
  assert.equal(room.requests.length, 0);
  // A second answer to the same request is refused, not applied twice.
  assert.throws(
    () => send(leader, { kind: "acceptRequest", request: first.id }),
    /already handled/,
  );
});

test("accept all, decline and cancel", () => {
  const { room, leader, guest, send } = setup();
  send(guest, { kind: "request", tracks: [song(1), song(2), song(3)] });
  const [a, b, c] = room.requests.map((r) => r.id);
  // An empty room gets its first song from an accepted request.
  send(leader, { kind: "acceptRequest", requests: [a, b] });
  assert.equal(room.current, room.queue[0].id);
  assert.equal(room.queue.length, 2);
  assert.throws(
    () => send(leader, { kind: "cancelRequest", request: c }),
    /your own/,
  );
  send(guest, { kind: "request", tracks: [song(4)] });
  const d = room.requests.at(-1).id;
  const revision = room.revision;
  send(leader, { kind: "declineRequest", request: c });
  send(guest, { kind: "cancelRequest", request: d });
  assert.equal(room.requests.length, 0);
  assert.equal(room.revision, revision);
  assert.throws(
    () => send(guest, { kind: "acceptRequest", request: d }),
    /leader and DJs/,
  );
});

test("DJs may answer requests; guests may not", () => {
  const { room, leader, guest, send } = setup();
  const third = addMember(room, { name: "Third" });
  send(third, { kind: "request", tracks: [song(1)] });
  assert.throws(
    () =>
      send(guest, { kind: "declineRequest", request: room.requests[0].id }),
    /leader and DJs/,
  );
  send(leader, { kind: "role", member: guest.id, role: "dj" });
  // A DJ adds directly, and may answer others.
  send(guest, { kind: "request", tracks: [song(2)] });
  assert.equal(room.queue.at(-1).track.id, song(2).id);
  send(guest, { kind: "acceptRequest", request: room.requests[0].id });
  assert.equal(room.queue.at(-1).addedBy.id, third.id);
});

test("limits and duplicates count waiting requests, and are checked again on accept", () => {
  const { room, leader, guest, send } = setup({
    mode: "contributions",
    limit: 2,
    duplicates: false,
  });
  send(guest, { kind: "request", tracks: [song(1)] });
  assert.throws(
    () => send(guest, { kind: "request", tracks: [song(1)] }),
    /already queued or requested/,
  );
  send(guest, { kind: "request", tracks: [song(2)] });
  assert.throws(
    () => send(guest, { kind: "request", tracks: [song(3)] }),
    /limit/,
  );
  // The leader queues the same song while its request waits.
  send(leader, { kind: "enqueue", tracks: [song(0), song(1)] });
  const [dupe, other] = room.requests.map((r) => r.id);
  assert.throws(
    () => send(leader, { kind: "acceptRequest", request: dupe }),
    /already in the queue/,
  );
  // Accept all takes what it can and leaves the refused one waiting.
  send(leader, { kind: "acceptRequest", requests: [dupe, other] });
  assert.deepEqual(
    room.requests.map((r) => r.id),
    [dupe],
  );
});

test("auto-accept and mode changes settle waiting requests", () => {
  let { room, leader, guest, send } = setup({
    mode: "contributions",
    autoAccept: true,
  });
  send(guest, { kind: "enqueue", tracks: [song(1)] });
  assert.equal(room.queue.length, 1);
  assert.equal(room.requests.length, 0);

  ({ room, leader, guest, send } = setup());
  send(guest, { kind: "request", tracks: [song(1)] });
  send(leader, { kind: "settings", mode: "collaborative" });
  assert.equal(room.requests.length, 0);
  assert.equal(room.queue[0].addedBy.id, guest.id);

  ({ room, leader, guest, send } = setup());
  send(guest, { kind: "request", tracks: [song(1)] });
  send(leader, { kind: "settings", mode: "listen" });
  assert.equal(room.requests.length, 0);
  assert.equal(room.queue.length, 0);
  assert.throws(
    () => send(guest, { kind: "request", tracks: [song(2)] }),
    /listen only/,
  );
});

test("requests survive a handover and leave with their requester", () => {
  const { room, leader, guest, send } = setup();
  const third = addMember(room, { name: "Third" });
  send(guest, { kind: "request", tracks: [song(1)] });
  send(third, { kind: "request", tracks: [song(2)] });
  transfer(room, third.id);
  // The new leader's own request is theirs to accept.
  send(third, { kind: "acceptRequest", request: room.requests[1].id });
  assert.equal(room.requests.length, 1);
  assert.throws(
    () => send(leader, { kind: "declineRequest", request: room.requests[0].id }),
    /leader and DJs/,
  );
  assert.equal(dropRequests(room, guest.id), true);
  assert.equal(room.requests.length, 0);
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
      waiters.push({
        match,
        resolve,
        timer: setTimeout(
          () => reject(new Error("Timed out: " + JSON.stringify(messages))),
          2000,
        ),
      });
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
  const state = () => messages.filter((m) => m.type === "state").at(-1)?.room;
  const settle = (match) =>
    wait((m) => m.type === "state" && match(m.room));
  return { ws, messages, wait, send, state, settle };
}

test("real sockets: request, accept, decline, and a kicked guest's requests go", async (t) => {
  const server = createRoomServerV2({ intervalMs: 20 });
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.http.address().port}`;
  const host = await connect(url);
  host.send({ type: "create", mode: "contributions", profile: { name: "Host" } });
  await host.wait((m) => m.type === "joined");
  const initial = (await host.wait((m) => m.type === "state")).room;
  const guest = await connect(url);
  guest.send({ type: "join", pin: initial.pin, profile: { name: "Guest" } });
  const joined = await guest.wait((m) => m.type === "joined");
  const command = (client, op, data) => {
    client.send({ type: "command", command: { op, ...data } });
    return client.wait((m) => (m.type === "ack" || m.type === "error") && m.op === op);
  };
  assert.equal(
    (await command(guest, "r1", { kind: "request", tracks: [song(1), song(2)] })).type,
    "ack",
  );
  const pending = (
    await host.settle((room) => room.requests?.length === 2)
  ).room.requests;
  assert.equal(pending[0].by.name, "Guest");
  assert.equal(
    (await command(host, "a1", { kind: "acceptRequest", request: pending[0].id }))
      .type,
    "ack",
  );
  const accepted = await guest.settle((room) => room.queue.length === 1);
  assert.equal(accepted.room.queue[0].request, pending[0].id);
  await command(host, "d1", { kind: "declineRequest", request: pending[1].id });
  await guest.settle((room) => room.requests.length === 0);
  await command(guest, "r2", { kind: "request", tracks: [song(3)] });
  await host.settle((room) => room.requests.length === 1);
  await command(host, "k1", { kind: "kick", member: joined.member });
  await host.settle(
    (room) => room.requests.length === 0 && room.members.length === 1,
  );
});

const many = (n) => ({
  id: `q${String(n).padStart(10, "0")}`,
  title: `Many ${n}`,
  artists: [{ name: "Artist" }],
  durationMs: 10000,
  artwork: [],
});
test("one guest cannot hold every waiting slot, or loop request and cancel", () => {
  const { room, guest, send } = setup();
  assert.throws(
    () =>
      send(guest, {
        kind: "request",
        tracks: Array.from({ length: 11 }, (_, n) => many(n)),
      }),
    /10 requests waiting/,
  );
  let op = 0;
  const at = (now, data) =>
    command(room, guest, { op: `loop-${++op}`, ...data }, now);
  for (let n = 0; n < 10; n++) {
    at(1000 + n, { kind: "request", tracks: [many(n)] });
    at(1000 + n, { kind: "cancelRequest", request: room.requests[0].id });
  }
  assert.throws(
    () => at(2000, { kind: "request", tracks: [many(10)] }),
    /requesting quickly/,
  );
  // A refused attempt does not count, and the window moves on.
  at(62000, { kind: "request", tracks: [many(10)] });
  assert.equal(room.requests.length, 1);
});
test("accepting keeps only a few played songs, like adding does", () => {
  const { room, leader, guest, send } = setup();
  send(leader, {
    kind: "enqueue",
    tracks: Array.from({ length: 40 }, (_, n) => many(n)),
  });
  send(leader, { kind: "jump", entry: room.queue[30].id });
  send(guest, { kind: "request", tracks: [song(1)] });
  send(leader, { kind: "acceptRequest", request: room.requests[0].id });
  // 20 played songs, the current one, 9 upcoming and the accepted request.
  assert.equal(room.queue.length, 31);
  assert.equal(room.queue.at(-1).track.id, song(1).id);
  assert.equal(room.queue.findIndex((e) => e.id === room.current), 20);
});
test("a refused accept leaves the played songs where they were", () => {
  const { room, leader, guest, send } = setup();
  send(leader, {
    kind: "enqueue",
    tracks: Array.from({ length: 40 }, (_, n) => many(n)),
  });
  send(leader, { kind: "jump", entry: room.queue[30].id });
  send(guest, { kind: "request", tracks: [many(35)] });
  // Turned off after asking, so the accept is refused as a duplicate.
  send(leader, { kind: "settings", duplicates: false });
  const queue = room.queue,
    revision = room.revision;
  assert.throws(
    () => send(leader, { kind: "acceptRequest", request: room.requests[0].id }),
    /already in the queue/,
  );
  assert.equal(room.queue, queue);
  assert.equal(room.queue.length, 40);
  assert.equal(room.revision, revision);
});
test("an explicit accept lets a request in even past the guest's limit", () => {
  const { room, leader, guest, send } = setup({ mode: "contributions", limit: 5 });
  send(guest, { kind: "request", tracks: [song(1), song(2)] });
  send(leader, { kind: "settings", limit: 1 });
  send(leader, {
    kind: "acceptRequest",
    requests: room.requests.map((r) => r.id),
  });
  assert.equal(room.queue.filter((e) => e.addedBy.id === guest.id).length, 2);
});

test("accepting a request after the queue ran out starts it", () => {
  const { room, leader, guest, send } = setup();
  send(leader, { kind: "enqueue", tracks: [song(0)] });
  send(leader, { kind: "play" });
  const first = room.current;
  assert.equal(tick(room, 12000), true);
  assert.equal(room.finished, true);
  send(guest, { kind: "request", tracks: [song(1)] });
  send(leader, { kind: "acceptRequest", request: room.requests[0].id });
  assert.equal(room.queue.find((e) => e.id === room.current).track.id, song(1).id);
  assert.equal(room.playing, true);
  assert.equal(room.finished, false);
  assert.equal(room.history.at(-1).id, first);
});
