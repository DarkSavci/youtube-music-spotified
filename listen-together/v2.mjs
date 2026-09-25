import { randomBytes, randomInt } from "node:crypto";
import { cleanSnapshot } from "./protocol.mjs";

export const VERSION = 2;
export const modes = ["collaborative", "contributions", "listen"];
const id = () => randomBytes(18).toString("base64url");
export function publicImage(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      [
        "i.ytimg.com",
        "lh3.googleusercontent.com",
        "yt3.googleusercontent.com",
        "yt3.ggpht.com",
        "www.gstatic.com",
      ].includes(u.hostname) &&
      u.href.length < 2048
      ? u.href
      : "";
  } catch {
    return "";
  }
}
export function cleanTrack(value) {
  const track = cleanSnapshot({
    track: value,
    playing: false,
    positionMs: 0,
  }).track;
  if (!track) throw new Error("Choose a track first.");
  return {
    ...track,
    explicit: value.explicit === true,
    playable: true,
    artwork: (Array.isArray(value.artwork) ? value.artwork : [])
      .slice(0, 3)
      .map((a) => ({
        url: publicImage(a.url),
        width: Math.min(2048, Math.max(1, Number(a.width) || 480)),
        height: Math.min(2048, Math.max(1, Number(a.height) || 480)),
      }))
      .filter((a) => a.url),
  };
}
export function profile(value = {}) {
  return {
    name:
      String(value.name || "Listener")
        .trim()
        .slice(0, 50) || "Listener",
    avatar: publicImage(value.avatar),
  };
}
export function position(room, now = Date.now()) {
  const t = room.queue.find((e) => e.id === room.current)?.track;
  return Math.min(
    t?.durationMs || 86400000,
    room.positionMs + (room.playing ? Math.max(0, now - room.at) : 0),
  );
}
export function makeRoom(pin, options = {}, now = Date.now()) {
  return {
    id: id(),
    pin,
    name: typeof options.roomName === "string"
      ? options.roomName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80)
      : "",
    members: new Map(),
    owner: "",
    mode: modes.includes(options.mode) ? options.mode : "collaborative",
    locked: false,
    queue: [],
    current: null,
    positionMs: 0,
    at: now,
    playing: false,
    revision: 0,
    expires: now + 21600000,
    activity: [],
    history: [],
    repeat: "off",
    policy: "fifo",
    duplicates: true,
    limit: 50,
    lastControlledBy: null,
    video: null,
    votes: [],
    voteSkip: false,
    undo: null,
    joinApproval: false,
    pending: [],
    countdown: null,
  };
}
export function addMember(room, value) {
  const member = {
    id: id(),
    token: id() + id(),
    ...profile(value),
    connected: true,
    disconnectedAt: null,
    status: "connecting",
    role: "listener",
    operations: new Map(),
  };
  room.members.set(member.id, member);
  if (!room.owner) room.owner = member.id;
  return member;
}
export function canControl(room, member) {
  return (
    room.owner === member.id ||
    member.role === "dj" ||
    room.mode === "collaborative"
  );
}
export function snapshot(room) {
  const { creatorIP, ...publicRoom } = room;
  return {
    ...publicRoom,
    members: [...room.members.values()].map(
      ({ token, operations, socket, ...m }) => m,
    ),
    undo: room.undo
      ? { revision: room.undo.revision, expires: room.undo.expires }
      : null,
  };
}
export function event(room, text, now = Date.now()) {
  room.activity = [...room.activity.slice(-29), { id: id(), text, at: now }];
}
export function transfer(room, preferred) {
  const eligible = [...room.members.values()].filter(
    (m) => m.connected && m.id !== room.owner,
  );
  const next = preferred
    ? eligible.find((m) => m.id === preferred)
    : eligible[randomInt(Math.max(1, eligible.length))];
  if (preferred && !next) throw new Error("Choose a connected listener.");
  room.owner = next?.id || "";
  if (next) event(room, `${next.name} is now the leader.`);
}
function currentEntry(room) {
  return room.queue.find((e) => e.id === room.current);
}
function advance(room, direction = 1, now = Date.now()) {
  const old = currentEntry(room);
  const index = room.queue.findIndex((e) => e.id === room.current);
  if (old && direction > 0) room.history = [...room.history.slice(-99), old];
  let next = index + direction;
  if (next >= room.queue.length && room.repeat === "all") next = 0;
  if (next < 0) next = 0;
  if (next >= room.queue.length) {
    room.playing = false;
    room.positionMs = old?.track.durationMs || 0;
  } else {
    room.current = room.queue[next]?.id || null;
    room.positionMs = 0;
  }
  room.at = now;
  room.votes = [];
  room.video = null;
}
function fair(room) {
  if (room.policy !== "turns") return;
  const at = room.queue.findIndex((e) => e.id === room.current);
  const rest = room.queue.slice(at + 1),
    groups = new Map();
  for (const entry of rest) {
    if (!groups.has(entry.addedBy.id)) groups.set(entry.addedBy.id, []);
    groups.get(entry.addedBy.id).push(entry);
  }
  const keys = [...groups.keys()];
  const last = currentEntry(room)?.addedBy.id;
  if (keys.includes(last)) keys.push(...keys.splice(keys.indexOf(last), 1));
  const result = [];
  while (result.length < rest.length)
    for (const key of keys) {
      const entry = groups.get(key).shift();
      if (entry) result.push(entry);
    }
  room.queue = [...room.queue.slice(0, at + 1), ...result];
}
export function command(room, member, cmd, now = Date.now()) {
  if (!cmd || typeof cmd.op !== "string" || cmd.op.length > 100 || !cmd.op)
    throw new Error("Invalid operation.");
  if (member.operations.has(cmd.op)) return false;
  const owner = room.owner === member.id,
    control = canControl(room, member);
  const admin = [
    "settings",
    "transfer",
    "kick",
    "rotate",
    "end",
    "role",
    "approve",
    "deny",
    "countdown",
  ];
  const transport = [
    "play",
    "pause",
    "seek",
    "next",
    "previous",
    "jump",
    "replace",
    "variant",
    "display",
  ];
  if (admin.includes(cmd.kind) && !owner)
    throw new Error("Only the leader can change room settings.");
  if (transport.includes(cmd.kind) && !control)
    throw new Error("The leader controls playback in this room.");
  if (
    ["seek", "next", "previous", "variant", "jump", "replace"].includes(
      cmd.kind,
    ) &&
    cmd.current !== room.current
  )
    throw new Error("The song changed. Try again.");
  if (
    [
      "seek",
      "next",
      "previous",
      "variant",
      "jump",
      "replace",
      "move",
      "remove",
      "undo",
      "settings",
    ].includes(cmd.kind) &&
    cmd.base !== room.revision
  )
    throw new Error("The room changed. Try again.");
  const entry = room.queue.find((e) => e.id === cmd.entry);
  const oldPosition = position(room, now);
  switch (cmd.kind) {
    case "play":
      if (!currentEntry(room)) throw new Error("Add some music first.");
      room.playing = true;
      break;
    case "pause":
      room.playing = false;
      break;
    case "seek":
      if (!Number.isFinite(cmd.positionMs) || cmd.positionMs < 0)
        throw new Error("Invalid position.");
      break;
    case "next":
      advance(room, 1, now);
      break;
    case "previous":
      if (oldPosition > 3000) {
        room.positionMs = 0;
        room.at = now;
      } else advance(room, -1, now);
      break;
    case "jump":
      if (!entry) throw new Error("That queue entry is gone.");
      room.current = entry.id;
      room.positionMs = 0;
      room.at = now;
      room.playing = true;
      room.video = null;
      room.votes = [];
      break;
    case "replace":
    case "enqueue": {
      if (!control && room.mode !== "contributions")
        throw new Error("This room is listen only.");
      if (
        !Array.isArray(cmd.tracks) ||
        !cmd.tracks.length ||
        cmd.tracks.length > 100
      )
        throw new Error("Add between 1 and 100 songs at a time.");
      const tracks = cmd.tracks.map(cleanTrack);
      if (room.queue.length + tracks.length > 500 && cmd.kind !== "replace")
        throw new Error("The room queue is full (500 songs).");
      const future = room.queue.slice(
        room.queue.findIndex((e) => e.id === room.current) + 1,
      );
      if (
        !owner &&
        future.filter((e) => e.addedBy.id === member.id).length +
          tracks.length >
          room.limit
      )
        throw new Error("Your queue contribution limit has been reached.");
      if (
        !room.duplicates &&
        new Set([
          ...(cmd.kind === "replace" ? [] : future.map((e) => e.track.id)),
          ...tracks.map((t) => t.id),
        ]).size <
          (cmd.kind === "replace" ? 0 : future.length) + tracks.length
      )
        throw new Error("Duplicate songs are disabled in this room.");
      const added = tracks.map((track) => ({
        id: id(),
        track,
        addedBy: { id: member.id, name: member.name, avatar: member.avatar },
        addedAt: now,
      }));
      if (cmd.kind === "replace") {
        room.queue = added;
        room.current = added[0].id;
        room.playing = true;
        room.positionMs = 0;
        room.at = now;
        room.video = null;
        room.votes = [];
      } else {
        if (cmd.before && !room.queue.some((e) => e.id === cmd.before))
          throw new Error("That queue entry is gone.");
        if (cmd.before && !control)
          throw new Error(
            "Only playback controllers may insert ahead of others.",
          );
        const index = cmd.before
          ? room.queue.findIndex((e) => e.id === cmd.before)
          : room.queue.length;
        room.queue.splice(index, 0, ...added);
        if (!room.current) {
          room.current = added[0].id;
          room.positionMs = 0;
          room.at = now;
        }
        fair(room);
      }
      event(
        room,
        `${member.name} added ${added.length === 1 ? added[0].track.title : `${added.length} songs`}.`,
        now,
      );
      break;
    }
    case "remove":
    case "move": {
      if (!entry) throw new Error("That queue entry is gone.");
      if (
        !control &&
        !(
          room.mode === "contributions" &&
          entry.addedBy.id === member.id &&
          entry.id !== room.current
        )
      )
        throw new Error("You may only edit your upcoming contributions.");
      if (cmd.kind === "move" && !control)
        throw new Error("The leader controls queue order.");
      if (entry.id === room.current)
        throw new Error("Skip the current song instead.");
      if (
        cmd.kind === "move" &&
        (cmd.before === entry.id ||
          (cmd.before && !room.queue.some((e) => e.id === cmd.before)))
      )
        throw new Error("Invalid queue destination.");
      room.undo = {
        queue: [...room.queue],
        current: room.current,
        by: member.id,
        revision: room.revision + 1,
        expires: now + 10000,
      };
      room.queue = room.queue.filter((e) => e.id !== entry.id);
      if (cmd.kind === "move")
        room.queue.splice(
          cmd.before
            ? room.queue.findIndex((e) => e.id === cmd.before)
            : room.queue.length,
          0,
          entry,
        );
      break;
    }
    case "undo":
      if (
        !room.undo ||
        room.undo.expires < now ||
        room.undo.revision !== room.revision ||
        (room.undo.by !== member.id && !owner)
      )
        throw new Error("This edit can no longer be undone.");
      room.queue = room.undo.queue;
      room.current = room.undo.current;
      room.undo = null;
      break;
    case "settings": {
      if (cmd.mode !== undefined && !modes.includes(cmd.mode))
        throw new Error("Invalid room mode.");
      if (cmd.policy !== undefined && !["fifo", "turns"].includes(cmd.policy))
        throw new Error("Invalid queue policy.");
      if (
        cmd.repeat !== undefined &&
        !["off", "one", "all"].includes(cmd.repeat)
      )
        throw new Error("Invalid repeat mode.");
      for (const key of ["locked", "duplicates", "voteSkip", "joinApproval"])
        if (cmd[key] !== undefined && typeof cmd[key] !== "boolean")
          throw new Error("Invalid setting.");
      if (
        cmd.limit !== undefined &&
        (!Number.isInteger(cmd.limit) || cmd.limit < 1 || cmd.limit > 100)
      )
        throw new Error("Limit must be between 1 and 100.");
      for (const key of [
        "mode",
        "policy",
        "repeat",
        "locked",
        "duplicates",
        "voteSkip",
        "limit",
        "joinApproval",
      ])
        if (cmd[key] !== undefined) room[key] = cmd[key];
      fair(room);
      event(room, `${member.name} updated room settings.`, now);
      break;
    }
    case "role": {
      const target = room.members.get(cmd.member);
      if (!target || !["dj", "listener"].includes(cmd.role))
        throw new Error("Invalid member role.");
      target.role = cmd.role;
      break;
    }
    case "transfer":
      transfer(room, cmd.member);
      break;
    case "variant":
      if (cmd.expectedID && currentEntry(room)?.track.id !== cmd.expectedID)
        throw new Error("The media version changed. Try again.");
      if (!currentEntry(room)) throw new Error("No current song.");
      const oldDuration = currentEntry(room).track.durationMs;
      currentEntry(room).track = cleanTrack(cmd.track);
      room.positionMs =
        Math.abs(currentEntry(room).track.durationMs - oldDuration) < 5000
          ? oldPosition
          : 0;
      room.at = now;
      room.video = { shown: true, by: member.id, revision: room.revision + 1 };
      break;
    case "display":
      if (typeof cmd.shown !== "boolean")
        throw new Error("Invalid video display intent.");
      room.video = {
        shown: cmd.shown,
        by: member.id,
        revision: room.revision + 1,
      };
      break;
    case "vote": {
      if (!room.voteSkip || !room.current)
        throw new Error("Skip voting is not enabled.");
      if (cmd.current !== room.current) throw new Error("The song changed.");
      if (!room.votes.includes(member.id)) room.votes.push(member.id);
      const connected = [...room.members.values()].filter((m) => m.connected);
      if (
        room.votes.filter((v) => connected.some((m) => m.id === v)).length >
        connected.length / 2
      )
        advance(room, 1, now);
      break;
    }
    case "ready":
      member.ready = cmd.ready === true;
      break;
    case "countdown":
      if (!currentEntry(room)) throw new Error("Add music first.");
      room.positionMs = oldPosition;
      room.at = now;
      room.playing = false;
      room.countdown = {
        expires: now + 60000,
        startAt: cmd.force ? now + 3000 : null,
      };
      event(
        room,
        cmd.force
          ? "Starting together in 3 seconds."
          : "Waiting for everyone to be ready.",
        now,
      );
      break;
    case "approve":
    case "deny":
    case "rotate":
    case "kick":
    case "end":
      break; // Admission/socket operations belong to the server.
    default:
      throw new Error("Unknown room command.");
  }
  if (["play", "pause", "seek"].includes(cmd.kind)) {
    room.positionMs =
      cmd.kind === "seek"
        ? Math.min(
            cmd.positionMs,
            currentEntry(room)?.track.durationMs || 86400000,
          )
        : oldPosition;
    room.at = now;
  }
  if (transport.includes(cmd.kind) && !["display"].includes(cmd.kind))
    room.countdown = null;
  if (transport.includes(cmd.kind))
    room.lastControlledBy = { id: member.id, name: member.name };
  room.revision++;
  member.operations.set(cmd.op, room.revision);
  if (member.operations.size > 500)
    member.operations.delete(member.operations.keys().next().value);
  return true;
}
export function tick(room, now = Date.now()) {
  if (room.countdown) {
    const connected = [...room.members.values()].filter((m) => m.connected);
    if (room.countdown.startAt && now >= room.countdown.startAt) {
      room.at = room.countdown.startAt;
      room.playing = true;
      room.countdown = null;
      for (const m of room.members.values()) m.ready = false;
      room.revision++;
      return true;
    }
    if (
      !room.countdown.startAt &&
      connected.length &&
      connected.every((m) => m.ready)
    ) {
      room.countdown.startAt = now + 3000;
      room.revision++;
      return true;
    }
    if (room.countdown.expires < now) {
      room.countdown = null;
      event(room, "Ready check expired. The leader can try again.", now);
      room.revision++;
      return true;
    }
  }
  const track = currentEntry(room)?.track;
  if (
    !room.playing ||
    !track?.durationMs ||
    position(room, now) < track.durationMs
  )
    return false;
  if (room.repeat === "one") {
    room.positionMs = 0;
    room.at = now;
    room.votes = [];
  } else advance(room, 1, now);
  room.revision++;
  return true;
}
