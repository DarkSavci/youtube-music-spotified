import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRoom, addMember, command } from "../v2.mjs";

// Radio a room adds is nobody's pick: people's songs go ahead of it, it does
// not use up a guest's contribution limit, and only so much of it waits.
const song = (n) => ({
  id: `r${String(n).padStart(10, "0")}`,
  title: `Song ${n}`,
  artists: [{ name: "Artist" }],
  durationMs: 10000,
  artwork: [],
});
const range = (from, to) => Array.from({ length: to - from }, (_, i) => song(from + i));
function setup(settings = {}) {
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
  if (Object.keys(settings).length) send(leader, { kind: "settings", ...settings });
  return { room, leader, guest, send };
}
const upcoming = (room) =>
  room.queue.slice(room.queue.findIndex((e) => e.id === room.current) + 1);

test("songs people add go ahead of the radio", () => {
  const { room, leader, guest, send } = setup({ mode: "collaborative" });
  send(leader, { kind: "enqueue", tracks: [song(0)] });
  send(leader, { kind: "enqueue", tracks: range(100, 149), radio: true });
  send(guest, { kind: "enqueue", tracks: [song(1)] });
  send(leader, { kind: "enqueue", tracks: [song(2)] });
  const next = upcoming(room);
  assert.deepEqual(
    next.slice(0, 2).map((e) => e.track.id),
    [song(1).id, song(2).id],
  );
  assert.equal(next.slice(2).every((e) => e.radio), true);
  assert.equal(next.length, 51);
});

test("an accepted request goes ahead of the radio", () => {
  const { room, leader, guest, send } = setup({ mode: "contributions" });
  send(leader, { kind: "enqueue", tracks: [song(0)] });
  send(leader, { kind: "enqueue", tracks: range(100, 149), radio: true });
  send(guest, { kind: "request", tracks: [song(1)] });
  send(leader, { kind: "acceptRequest", request: room.requests[0].id });
  assert.equal(upcoming(room)[0].track.id, song(1).id);
  assert.equal(upcoming(room)[0].radio, undefined);
});

test("radio does not use up a guest's limit, and a pick replaces its radio copy", () => {
  const { room, leader, guest, send } = setup({ mode: "collaborative", limit: 2, duplicates: false });
  send(leader, { kind: "enqueue", tracks: [song(0)] });
  // A guest who started a song's radio still has their whole allowance.
  send(guest, { kind: "enqueue", tracks: range(100, 130), radio: true });
  send(guest, { kind: "enqueue", tracks: [song(1)] });
  // Choosing a song the radio would have played moves it up, without a copy.
  send(guest, { kind: "enqueue", tracks: [song(110)] });
  const ids = upcoming(room).map((e) => e.track.id);
  assert.deepEqual(ids.slice(0, 2), [song(1).id, song(110).id]);
  assert.equal(ids.filter((x) => x === song(110).id).length, 1);
  assert.throws(
    () => send(guest, { kind: "enqueue", tracks: [song(2)] }),
    /contribution limit/,
  );
});

test("only so much radio waits, and none of it repeats what is coming up", () => {
  const { room, leader, send } = setup();
  send(leader, { kind: "enqueue", tracks: [song(0), song(100)] });
  send(leader, { kind: "enqueue", tracks: range(100, 180), radio: true });
  const radio = upcoming(room).filter((e) => e.radio);
  assert.equal(radio.length, 50);
  assert.equal(radio.some((e) => e.track.id === song(100).id), false);
  assert.throws(
    () => send(leader, { kind: "enqueue", tracks: range(200, 210), radio: true }),
    /already has radio/,
  );
});

test("taking turns shares the picks and leaves the radio at the end", () => {
  const { room, leader, guest, send } = setup({ mode: "collaborative", policy: "turns" });
  send(leader, { kind: "enqueue", tracks: [song(0)] });
  send(leader, { kind: "enqueue", tracks: range(100, 105), radio: true });
  send(leader, { kind: "enqueue", tracks: [song(1), song(2)] });
  send(guest, { kind: "enqueue", tracks: [song(3)] });
  const next = upcoming(room);
  assert.equal(next.slice(0, 3).some((e) => e.radio), false);
  assert.equal(next.slice(3).every((e) => e.radio), true);
  // The guest's pick is not stuck behind both of the leader's.
  assert.ok(next.findIndex((e) => e.addedBy.id === guest.id) < 2);
});

test("only playback controllers add radio, even where guests add directly", () => {
  for (const settings of [
    { mode: "contributions" },
    { mode: "contributions", autoAccept: true, limit: 2 },
  ]) {
    const { room, leader, guest, send } = setup(settings);
    send(leader, { kind: "enqueue", tracks: [song(0)] });
    assert.throws(
      () => send(guest, { kind: "enqueue", tracks: range(100, 150), radio: true }),
      /playback controllers/,
    );
    assert.equal(room.requests.length, 0);
    assert.equal(room.queue.filter((e) => e.radio).length, 0);
  }
});

test("a song only the radio would play can still be requested", () => {
  const { room, leader, guest, send } = setup({ mode: "contributions", duplicates: false });
  send(leader, { kind: "enqueue", tracks: [song(0)] });
  send(leader, { kind: "enqueue", tracks: [song(7)], radio: true });
  send(guest, { kind: "request", tracks: [song(7)] });
  send(leader, { kind: "acceptRequest", request: room.requests[0].id });
  const copies = upcoming(room).filter((e) => e.track.id === song(7).id);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].radio, undefined);
});

test("a radio song playing is nobody's turn", () => {
  const { room, leader, guest, send } = setup({ mode: "collaborative", policy: "turns" });
  send(leader, { kind: "enqueue", tracks: [song(0)] });
  send(guest, { kind: "enqueue", tracks: [song(9)] });
  send(leader, { kind: "next" });
  // The guest's pick is playing; then a radio song plays after it.
  send(leader, { kind: "enqueue", tracks: [song(100)], radio: true });
  send(leader, { kind: "next" });
  assert.equal(room.queue.find((e) => e.id === room.current).radio, true);
  send(guest, { kind: "enqueue", tracks: [song(1), song(2)] });
  send(leader, { kind: "enqueue", tracks: [song(3)] });
  // The guest's pick played last, so the leader goes first.
  assert.deepEqual(
    upcoming(room).map((e) => e.track.id),
    [song(3).id, song(1).id, song(2).id],
  );
});

test("radio does not replay the song that just finished", () => {
  const { room, leader, send } = setup();
  send(leader, { kind: "enqueue", tracks: [song(0)] });
  send(leader, { kind: "next" });
  assert.equal(room.finished, true);
  send(leader, { kind: "enqueue", tracks: [song(0), song(5)], radio: true });
  assert.equal(room.queue.find((e) => e.id === room.current).track.id, song(5).id);
  assert.equal(room.queue.filter((e) => e.radio).length, 1);
});

test("radio added after the queue ran out still starts", async () => {
  const { tick } = await import("../v2.mjs");
  const { room, leader, send } = setup();
  send(leader, { kind: "enqueue", tracks: [song(0)] });
  send(leader, { kind: "play" });
  assert.equal(tick(room, 12000), true);
  assert.equal(room.finished, true);
  send(leader, { kind: "enqueue", tracks: range(100, 103), radio: true });
  assert.equal(room.queue.find((e) => e.id === room.current).track.id, song(100).id);
  assert.equal(room.playing, true);
});
