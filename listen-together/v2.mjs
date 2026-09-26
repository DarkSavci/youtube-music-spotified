import { randomBytes, randomInt } from "node:crypto";
import { cleanSnapshot } from "./protocol.mjs";

export const VERSION = 2;
export const modes = ["collaborative", "contributions", "listen"];
/** How long a song nobody can play holds the room before it moves on. */
export const UNPLAYABLE_GRACE_MS = 10000;
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
    // Songs guests asked for in a "Take requests" room, waiting for the
    // leader or a DJ. autoAccept restores adding them straight to the queue.
    requests: [],
    autoAccept: false,
    // Set when the queue ran out: the last song ended with nothing after it.
    // A song added then starts at once instead of waiting for someone to
    // notice the room went quiet.
    finished: false,
    // When every connected listener first said the current song will not
    // play for them; the room moves on after a grace period.
    unplayableSince: null,
    // Songs the room has had (played, or jumped past), so radio never brings
    // one back. The queue keeps only a few played songs and the history
    // records only what ended, so neither is enough on its own. Kept here,
    // never sent to listeners.
    heard: new Set(),
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
/** Whether this member's additions wait for approval instead of queueing. */
export function requesting(room, member) {
  return (
    room.mode === "contributions" &&
    !room.autoAccept &&
    !canControl(room, member)
  );
}
/** Forgets a member's pending requests, e.g. when they leave or are removed. */
export function dropRequests(room, memberId) {
  const before = room.requests.length;
  room.requests = room.requests.filter((r) => r.by.id !== memberId);
  return room.requests.length !== before;
}
export function snapshot(room) {
  const { creatorIP, heard, ...publicRoom } = room;
  return {
    ...publicRoom,
    members: [...room.members.values()].map(
      ({ token, operations, socket, ...m }) => m,
    ),
    undo: room.undo
      ? {
          revision: room.undo.revision,
          expires: room.undo.expires,
          by: room.undo.by,
        }
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
  let next = index + direction;
  if (next >= room.queue.length && room.repeat === "all") next = 0;
  if (next < 0) next = 0;
  if (next >= room.queue.length) {
    room.playing = false;
    room.positionMs = old?.track.durationMs || 0;
    room.finished = direction > 0 && !!old;
  } else {
    room.finished = false;
    // Only a song that is left behind joins the history; pressing next at
    // the end of the queue must not record the same song again.
    if (old && direction > 0 && room.queue[next].id !== old.id)
      room.history = [...room.history.slice(-99), old];
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
  // Radio fills in after everyone's picks; it takes no one's turn.
  const upcoming = room.queue.slice(at + 1);
  const rest = upcoming.filter((e) => !e.radio),
    radio = upcoming.filter((e) => e.radio),
    groups = new Map();
  for (const entry of rest) {
    if (!groups.has(entry.addedBy.id)) groups.set(entry.addedBy.id, []);
    groups.get(entry.addedBy.id).push(entry);
  }
  const keys = [...groups.keys()];
  // Whose pick played last decides the next turn; radio is nobody's turn.
  const last = room.queue
    .slice(0, at + 1)
    .findLast((e) => !e.radio)?.addedBy.id;
  if (keys.includes(last)) keys.push(...keys.splice(keys.indexOf(last), 1));
  const result = [];
  while (result.length < rest.length)
    for (const key of keys) {
      const entry = groups.get(key).shift();
      if (entry) result.push(entry);
    }
  room.queue = [...room.queue.slice(0, at + 1), ...result, ...radio];
}
// Radio a room adds to keep its music going: at most this many songs of it
// wait at once. It is not anyone's contribution, so it does not count toward
// a guest's limit, and what people add or accept goes ahead of it.
const RADIO_UPCOMING = 50;
/** How many songs a room remembers having had, oldest forgotten first. */
const HEARD_MAX = 1000;
/**
 * Notes the current song and everything before it as had. Called before a
 * command or tick can move on or trim the queue, so a song jumped past is
 * remembered even though it never reaches the history.
 */
export function rememberHeard(room) {
  const heard = room.heard;
  if (!heard) return;
  const at = room.queue.findIndex((e) => e.id === room.current);
  for (const e of room.queue.slice(0, at + 1)) {
    heard.delete(e.track.id);
    heard.add(e.track.id);
  }
  for (const e of room.history.slice(-50)) if (!heard.has(e.track.id)) heard.add(e.track.id);
  for (const old of heard) {
    if (heard.size <= HEARD_MAX) break;
    heard.delete(old);
  }
}
/** Where a song someone added goes: after the other picks, before the radio. */
function pickSlot(room) {
  const at = room.queue.findIndex((e) => e.id === room.current);
  const radio = room.queue.findIndex((e, i) => i > at && e.radio);
  return radio === -1 ? room.queue.length : radio;
}
/** Drops upcoming radio copies of songs someone just chose themselves. */
function dropRadioCopies(room, trackIds) {
  const at = room.queue.findIndex((e) => e.id === room.current);
  room.queue = room.queue.filter(
    (e, i) => i <= at || !e.radio || !trackIds.has(e.track.id),
  );
}
// Waiting requests: at most 50 per room, and no one guest may hold more than
// 10 of them, so one guest cannot crowd everyone else out of the leader's
// attention. Asking is also throttled, so a guest who requests and cancels in
// a loop cannot flood the leader with notifications and activity.
const REQUESTS_PER_ROOM = 50,
  REQUESTS_PER_GUEST = 10,
  REQUEST_BURST = 10,
  REQUEST_WINDOW_MS = 60000;
const requestTimes = new WeakMap();
// Moves requests into the queue. Each one is judged on its own, so one
// duplicate does not hold back the rest; the first refusal is reported only
// when nothing could be accepted. The per-guest queue limit is deliberately
// not applied here: it was checked when the guest asked, and a leader or DJ
// accepting a request is choosing to let that song in.
function acceptRequests(room, ids, placement, member, now) {
  let refusal = null;
  const accepted = [];
  // Like an addition, only a few played songs stay behind the current one,
  // so the history does not count toward the 500-song cap. The trim is kept
  // only if something is accepted: a refused accept leaves the room as it was.
  const untrimmed = room.queue;
  const played = room.queue.findIndex((e) => e.id === room.current);
  if (played > 20) room.queue = room.queue.slice(played - 20);
  for (const requestId of ids) {
    const request = room.requests.find((r) => r.id === requestId);
    if (!request) {
      refusal ??= "That request was already handled.";
      continue;
    }
    const at = room.queue.findIndex((e) => e.id === room.current);
    if (room.queue.length >= 500) {
      refusal ??= "The room queue is full (500 songs).";
      break;
    }
    if (
      !room.duplicates &&
      room.queue
        .slice(at + 1)
        .some((e) => !e.radio && e.track.id === request.track.id)
    ) {
      refusal ??= "That song is already in the queue.";
      continue;
    }
    const entry = {
      id: id(),
      track: request.track,
      catalogueMs: request.track.durationMs,
      addedBy: request.by,
      addedAt: now,
      request: request.id,
    };
    dropRadioCopies(room, new Set([request.track.id]));
    if (placement === "next") {
      // Accepted together, "next" keeps them in the order they were chosen.
      const previous = accepted.at(-1);
      room.queue.splice(
        previous ? room.queue.indexOf(previous) + 1 : at + 1,
        0,
        entry,
      );
    } else room.queue.splice(pickSlot(room), 0, entry);
    room.requests = room.requests.filter((r) => r.id !== request.id);
    accepted.push(entry);
  }
  if (!accepted.length) {
    room.queue = untrimmed;
    throw new Error(refusal || "Choose a request.");
  }
  if (!room.current) {
    room.current = accepted[0].id;
    room.positionMs = 0;
    room.at = now;
  } else if (room.finished) {
    // The queue had run out: carry on with the accepted song, as an addition
    // would.
    const old = currentEntry(room);
    if (old) room.history = [...room.history.slice(-99), old];
    room.current = accepted[0].id;
    room.positionMs = 0;
    room.at = now;
    room.playing = true;
    room.finished = false;
    room.votes = [];
    room.video = null;
  }
  // "Play next" is a deliberate position that taking turns must keep.
  if (placement !== "next") fair(room);
  event(
    room,
    accepted.length === 1
      ? `${member.name} accepted ${accepted[0].addedBy.name}’s request for ${accepted[0].track.title}.`
      : `${member.name} accepted ${accepted.length} requests.`,
    now,
  );
}
export function command(room, member, cmd, now = Date.now()) {
  if (!cmd || typeof cmd.op !== "string" || cmd.op.length > 100 || !cmd.op)
    throw new Error("Invalid operation.");
  if (member.operations.has(cmd.op)) return false;
  rememberHeard(room);
  const owner = room.owner === member.id,
    control = canControl(room, member);
  // Older apps add songs directly; in a room that takes requests the relay
  // turns a guest's addition into a request instead of refusing it. And a
  // request from someone who may add directly is simply an addition.
  // Radio is outside anyone's contribution limit, so only those who control
  // playback may add it (the app offers it to no one else).
  if (cmd.kind === "enqueue" && cmd.radio === true && !control)
    throw new Error("Only playback controllers can add radio.");
  if (cmd.kind === "enqueue" && requesting(room, member))
    cmd = { ...cmd, kind: "request" };
  else if (cmd.kind === "request" && !requesting(room, member))
    cmd = { ...cmd, kind: "enqueue", before: undefined };
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
  if (
    ["acceptRequest", "declineRequest"].includes(cmd.kind) &&
    !owner &&
    member.role !== "dj"
  )
    throw new Error("Only the leader and DJs can answer requests.");
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
    // Skips are pinned to the song by `current` alone: requiring the exact
    // revision refused them whenever anything else in the room changed at the
    // same moment — someone adding a song, a setting, the relay's own advance.
    [
      "seek",
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
  // Ready answers and skip votes that do not skip describe listeners, not
  // the queue or playback, so they must not make the leader's pending
  // commands stale by moving the revision.
  let presence = false;
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
    case "next": {
      const finished = room.finished;
      advance(room, 1, now);
      // Next after the queue ran out moves onto a song added since: that
      // is a request to hear it, not to sit paused on it.
      if (finished && !room.finished) room.playing = true;
      break;
    }
    case "ended": {
      // A listener's player reached the end of the current song. The relay's
      // clock does this too, but only from the catalogue length, which is
      // missing for some songs and a little off for others. Whoever notices
      // first moves the room on; the rest are told the song changed.
      // Every listener reports the same end, so the late ones, and a report
      // from a player whose clock ran ahead of the room, are quietly ignored
      // rather than answered with an error.
      const track = currentEntry(room)?.track;
      // Judged against the shorter of the song's length now and the length
      // it was added with: a corrected length may not hold a real end back.
      const catalogue = currentEntry(room)?.catalogueMs;
      const length = catalogue
        ? Math.min(catalogue, track?.durationMs || catalogue)
        : track?.durationMs;
      if (
        !track ||
        !room.playing ||
        cmd.current !== room.current ||
        (length ? oldPosition < length - 10000 : !control)
      ) {
        member.operations.set(cmd.op, room.revision);
        return false;
      }
      if (room.repeat === "one") {
        room.positionMs = 0;
        room.at = now;
        room.votes = [];
      } else advance(room, 1, now);
      break;
    }
    case "duration": {
      // The length a listener's player measured. It fills a missing catalogue
      // length or corrects a rounded one, which is what the relay's clock
      // ends songs by. It is accepted once per song and only near the length
      // the song was added with, so it cannot be used to cut a song short
      // or stretch it out; and only from members who could skip it anyway.
      if (!control)
        throw new Error("The leader controls playback in this room.");
      const target = entry?.track;
      const ms = Math.round(Number(cmd.durationMs));
      if (!target) throw new Error("That queue entry is gone.");
      if (!Number.isFinite(ms) || ms < 1000 || ms > 14400000)
        throw new Error("Invalid duration.");
      const catalogue = entry.catalogueMs ?? target.durationMs;
      const diff = Math.abs(ms - catalogue);
      if (entry.measured || (catalogue && (diff <= 1000 || diff > 15000))) {
        member.operations.set(cmd.op, room.revision);
        return false;
      }
      entry.catalogueMs = catalogue;
      entry.measured = true;
      if (entry.id === room.current) {
        room.positionMs = Math.min(oldPosition, ms);
        room.at = now;
      }
      target.durationMs = ms;
      presence = true;
      break;
    }
    case "previous": {
      // The sender says which "previous" they meant from what they saw: back
      // to the start, or back a song. Two presses at once then restart once
      // rather than one restarting and the other going back a song.
      const restart =
        typeof cmd.restart === "boolean" ? cmd.restart : oldPosition > 3000;
      if (restart) {
        room.positionMs = 0;
        room.at = now;
      } else advance(room, -1, now);
      break;
    }
    case "jump":
      if (!entry) throw new Error("That queue entry is gone.");
      room.finished = false;
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
      let tracks = cmd.tracks.map(cleanTrack);
      const radio = cmd.kind === "enqueue" && cmd.radio === true;
      if (radio && cmd.before) throw new Error("Radio goes after the queue.");
      // Played songs stay in the queue for "previous", but only a few: the
      // history keeps the rest, and the cap is for what is still to come.
      const at = room.queue.findIndex((e) => e.id === room.current);
      if (cmd.kind !== "replace" && at > 20)
        room.queue = room.queue.slice(at - 20);
      // A replaced queue no longer holds anyone's upcoming songs.
      const future =
        cmd.kind === "replace"
          ? []
          : room.queue.slice(
              room.queue.findIndex((e) => e.id === room.current) + 1,
            );
      if (radio) {
        // Radio never repeats what is already coming up, and only so much
        // of it waits at once; what does not fit is simply not added.
        const seen = new Set([
          ...future.map((e) => e.track.id),
          ...room.queue
            .slice(0, room.queue.length - future.length)
            .map((e) => e.track.id),
          ...room.history.slice(-50).map((e) => e.track.id),
          ...(room.heard ?? []),
        ]);
        tracks = tracks.filter((t) => !seen.has(t.id) && seen.add(t.id));
        const waiting = future.filter((e) => e.radio).length;
        tracks = tracks.slice(0, Math.max(0, RADIO_UPCOMING - waiting));
        if (!tracks.length) throw new Error("The room already has radio queued.");
      }
      if (room.queue.length + tracks.length > 500 && cmd.kind !== "replace")
        throw new Error("The room queue is full (500 songs).");
      if (
        !owner &&
        !radio &&
        future.filter((e) => e.addedBy.id === member.id && !e.radio).length +
          tracks.length >
          room.limit
      )
        throw new Error("Your queue contribution limit has been reached.");
      // Only the new songs are judged: a duplicate queued before the
      // setting was turned off must not block every later addition. Radio
      // is nobody's choice, so its copy gives way instead.
      if (!room.duplicates && !radio) {
        const seen = new Set(
          future.filter((e) => !e.radio).map((e) => e.track.id),
        );
        for (const track of tracks) {
          if (seen.has(track.id))
            throw new Error("Duplicate songs are disabled in this room.");
          seen.add(track.id);
        }
      }
      const added = tracks.map((track) => ({
        id: id(),
        track,
        catalogueMs: track.durationMs,
        addedBy: { id: member.id, name: member.name, avatar: member.avatar },
        addedAt: now,
        ...(radio ? { radio: true } : {}),
      }));
      if (cmd.kind === "replace") {
        room.finished = false;
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
        if (!radio) dropRadioCopies(room, new Set(added.map((e) => e.track.id)));
        const index = cmd.before
          ? room.queue.findIndex((e) => e.id === cmd.before)
          : radio
            ? room.queue.length
            : pickSlot(room);
        room.queue.splice(index, 0, ...added);
        if (!room.current) {
          room.current = added[0].id;
          room.positionMs = 0;
          room.at = now;
        } else if (room.finished && !cmd.before) {
          // The queue had run out: carry on with what was just added.
          const old = currentEntry(room);
          if (old) room.history = [...room.history.slice(-99), old];
          room.current = added[0].id;
          room.positionMs = 0;
          room.at = now;
          room.playing = true;
          room.finished = false;
          room.votes = [];
          room.video = null;
        }
        // "Play next" is a deliberate position that taking turns must keep.
        if (!cmd.before) fair(room);
      }
      event(
        room,
        radio
          ? `${member.name} added ${added.length} radio ${added.length === 1 ? "song" : "songs"}.`
          : `${member.name} added ${added.length === 1 ? added[0].track.title : `${added.length} songs`}.`,
        now,
      );
      break;
    }
    case "request": {
      if (
        !Array.isArray(cmd.tracks) ||
        !cmd.tracks.length ||
        cmd.tracks.length > 100
      )
        throw new Error("Request between 1 and 100 songs at a time.");
      const tracks = cmd.tracks.map(cleanTrack);
      const recent = (requestTimes.get(member) ?? []).filter(
        (at) => now - at < REQUEST_WINDOW_MS,
      );
      if (recent.length >= REQUEST_BURST)
        throw new Error("You're requesting quickly. Wait a moment, then try again.");
      if (room.requests.length + tracks.length > REQUESTS_PER_ROOM)
        throw new Error(
          "The leader has too many requests waiting. Try again soon.",
        );
      if (
        room.requests.filter((r) => r.by.id === member.id).length +
          tracks.length >
        REQUESTS_PER_GUEST
      )
        throw new Error(
          `You can have ${REQUESTS_PER_GUEST} requests waiting at a time.`,
        );
      const future = room.queue.slice(
        room.queue.findIndex((e) => e.id === room.current) + 1,
      );
      // Waiting requests count toward the same limit as queued songs, or
      // the limit would only apply to what the leader already accepted.
      if (
        future.filter((e) => e.addedBy.id === member.id && !e.radio).length +
          room.requests.filter((r) => r.by.id === member.id).length +
          tracks.length >
        room.limit
      )
        throw new Error("Your queue contribution limit has been reached.");
      if (!room.duplicates) {
        // A song only the radio would play can still be asked for; accepting
        // it replaces the radio's copy.
        const seen = new Set([
          ...future.filter((e) => !e.radio).map((e) => e.track.id),
          ...room.requests.map((r) => r.track.id),
        ]);
        for (const track of tracks) {
          if (seen.has(track.id))
            throw new Error("That song is already queued or requested.");
          seen.add(track.id);
        }
      }
      requestTimes.set(member, [...recent, now]);
      const by = { id: member.id, name: member.name, avatar: member.avatar };
      room.requests = [
        ...room.requests,
        ...tracks.map((track) => ({ id: id(), track, by, at: now })),
      ];
      event(
        room,
        `${member.name} requested ${tracks.length === 1 ? tracks[0].title : `${tracks.length} songs`}.`,
        now,
      );
      // Waiting requests do not change what plays, so they must not make
      // the leader's pending commands stale.
      presence = true;
      break;
    }
    case "acceptRequest": {
      const ids = Array.isArray(cmd.requests) ? cmd.requests : [cmd.request];
      if (
        !ids.length ||
        ids.length > 50 ||
        ids.some((r) => typeof r !== "string")
      )
        throw new Error("Choose a request.");
      if (
        cmd.placement !== undefined &&
        !["end", "next"].includes(cmd.placement)
      )
        throw new Error("Invalid queue position.");
      acceptRequests(room, ids, cmd.placement, member, now);
      break;
    }
    case "declineRequest":
    case "cancelRequest": {
      const ids = Array.isArray(cmd.requests) ? cmd.requests : [cmd.request];
      const found = room.requests.filter((r) => ids.includes(r.id));
      if (!found.length) throw new Error("That request was already handled.");
      if (
        cmd.kind === "cancelRequest" &&
        found.some((r) => r.by.id !== member.id)
      )
        throw new Error("You can only cancel your own requests.");
      room.requests = room.requests.filter((r) => !ids.includes(r.id));
      if (cmd.kind === "declineRequest")
        event(
          room,
          found.length === 1
            ? `${member.name} declined ${found[0].by.name}’s request.`
            : `${member.name} declined ${found.length} requests.`,
          now,
        );
      presence = true;
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
      for (const key of [
        "locked",
        "duplicates",
        "voteSkip",
        "joinApproval",
        "autoAccept",
      ])
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
        "autoAccept",
      ])
        if (cmd[key] !== undefined) room[key] = cmd[key];
      fair(room);
      // Requests only wait in a room that takes them. Where guests may add
      // directly they are accepted; in a listen-only room they are dropped.
      if (room.requests.length && room.mode === "listen") {
        room.requests = [];
        event(room, "Waiting song requests were cleared.", now);
      } else if (
        room.requests.length &&
        (room.mode === "collaborative" || room.autoAccept)
      ) {
        try {
          acceptRequests(room, room.requests.map((r) => r.id), "end", member, now);
        } catch {}
        // Whatever could not be queued (full, duplicates) is dropped rather
        // than left waiting for an approval nobody will give.
        room.requests = [];
      }
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
      currentEntry(room).catalogueMs = currentEntry(room).track.durationMs;
      currentEntry(room).measured = false;
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
      if (room.votes.includes(member.id)) {
        member.operations.set(cmd.op, room.revision);
        return false;
      }
      room.votes.push(member.id);
      const connected = [...room.members.values()].filter((m) => m.connected);
      if (
        room.votes.filter((v) => connected.some((m) => m.id === v)).length >
        connected.length / 2
      )
        advance(room, 1, now);
      else presence = true;
      break;
    }
    case "ready":
      if (!room.countdown || room.countdown.startAt)
        throw new Error("There is no ready check right now.");
      if (member.ready === (cmd.ready === true)) {
        member.operations.set(cmd.op, room.revision);
        return false;
      }
      member.ready = cmd.ready === true;
      presence = true;
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
      // Answers belong to one ready check, not to whichever comes next.
      for (const m of room.members.values()) m.ready = false;
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
  if (["play", "seek", "previous"].includes(cmd.kind)) room.finished = false;
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
  if (
    room.countdown &&
    transport.includes(cmd.kind) &&
    !["display"].includes(cmd.kind)
  ) {
    room.countdown = null;
    for (const m of room.members.values()) m.ready = false;
  }
  if (transport.includes(cmd.kind))
    room.lastControlledBy = { id: member.id, name: member.name };
  if (!presence) room.revision++;
  member.operations.set(cmd.op, room.revision);
  if (member.operations.size > 500)
    member.operations.delete(member.operations.keys().next().value);
  return true;
}
export function tick(room, now = Date.now()) {
  rememberHeard(room);
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
      for (const m of room.members.values()) m.ready = false;
      event(room, "Ready check expired. The leader can try again.", now);
      room.revision++;
      return true;
    }
  }
  // Everyone connected said the current song will not play for them (the
  // app reports it per entry). With nobody hearing it, the relay's clock is
  // all that would move the room on, and a song without a length never
  // ends; so the room moves on after a grace period. One listener who
  // cannot play a song never skips it for the others.
  const connected = [...room.members.values()].filter((m) => m.connected);
  if (
    room.playing &&
    room.current &&
    connected.length &&
    connected.every(
      (m) => m.status === "unavailable" && m.statusEntry === room.current,
    )
  ) {
    room.unplayableSince ??= now;
    if (now - room.unplayableSince >= UNPLAYABLE_GRACE_MS) {
      const title = currentEntry(room)?.track.title;
      room.unplayableSince = null;
      advance(room, 1, now);
      event(room, `Nobody could play ${title}, so the room moved on.`, now);
      room.revision++;
      return true;
    }
  } else room.unplayableSince = null;
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
