import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  RoomClientV2,
  type RoomState,
  type ConnectOptions,
  type RoomMode,
} from "../../../listen-together/client-v2.mjs";
import { endpointURL } from "../../../listen-together/protocol.mjs";
import { currentPosition, usePlayer } from "./player";
import {
  isServerAuthoritative,
  leaveRoomPlayback,
  setRoomTransport,
  syncRoomPlayback,
} from "./playback";
import { useVideo } from "./video";
import { toast } from "./toast";
import { api } from "./api";
import { useSettings } from "./settings";
import type { Track } from "./types";

interface Server {
  id: string;
  name: string;
  url: string;
}
interface Preferences {
  servers: Server[];
  selected: string;
  roomName: string;
  /** Who controls a new room, kept like its name so leaving the page does not reset it. */
  mode: RoomMode;
  name: string;
  avatar: string;
  followVideo: boolean;
  notifications: boolean;
  update: (patch: Partial<Omit<Preferences, "update">>) => void;
}
export const useRoomPreferences = create<Preferences>()(
  persist(
    (set) => ({
      servers: [],
      selected: "",
      roomName: "",
      mode: "collaborative",
      name: "",
      avatar: "",
      followVideo: false,
      notifications: false,
      update: (patch) => set(patch),
    }),
    { name: "spotifier.rooms.v2" },
  ),
);
export function saveRoomServer(
  name: string,
  url: string,
  id: string = crypto.randomUUID(),
) {
  const normalized = endpointURL(url.trim());
  const prefs = useRoomPreferences.getState();
  prefs.update({
    servers: [
      ...prefs.servers.filter((s) => s.id !== id),
      { id, name: name.trim() || new URL(normalized).host, url: normalized },
    ],
    selected: id,
  });
}
export const useTogether = create(() => ({
  status: "disconnected" as
    | "disconnected"
    | "connecting"
    | "reconnecting"
    | "connected"
    | "waiting",
  room: null as RoomState | null,
  member: "",
  error: null as string | null,
  sync: "Ready to join",
}));
let client: RoomClientV2 | null = null;
let generation = 0,
  applying = false,
  correctionAt = 0,
  lastVideo = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let task: Promise<void> = Promise.resolve();
let appliedEntry = "";
let personalVideo = false;
let reconnectPause: Promise<void> | null = null;
// A forced sync (an explicit seek, a retry) that arrives while another sync
// is running is kept for the follow-up instead of being dropped.
let pendingForce = false;
// After reconnecting, the last state received is stale until the relay
// sends a fresh one, so nothing is applied from it in the meantime.
let awaitingFresh = false;
// While a new room is being seeded from the creator's own music, its first
// states (empty, then paused at the start) must not interrupt that music.
let awaitingSeed = false;
// What this player has already told the relay: when it last reported the
// end of which entry (repeated now and then, since an early one is ignored),
// and which entry's media it reported a measured length for.
let reportedEnd = { entry: "", at: 0 };
let reportedLength = "";
/** How often an ignored end report is repeated while the room still plays the song. */
const END_REPORT_EVERY_MS = 5000;
// The leader's radio top-up: the seed last fetched for, whether a fetch is
// running, and when a failed one may be tried again.
let radioSeed = "";
let radioBusy = false;
let radioRetryAt = 0;
/** Songs left after the current one before the leader adds radio, as autoplay does. */
const RADIO_LOW = 5;
export function roomCanControl() {
  const { room, member } = useTogether.getState();
  return (
    !!room &&
    (room.owner === member ||
      room.mode === "collaborative" ||
      room.members.find((m) => m.id === member)?.role === "dj")
  );
}
/**
 * Whether songs this listener adds wait for the leader's approval: a guest in
 * a "Take requests" room, unless the leader accepts everything.
 */
export function roomRequesting() {
  const { room } = useTogether.getState();
  return (
    !!room &&
    room.mode === "contributions" &&
    !room.autoAccept &&
    !roomCanControl()
  );
}
/**
 * Adds songs to the room, or asks for them where the leader approves.
 *
 * Whether they were queued or became requests is the relay's decision: the
 * leader may switch auto-accept or the mode while this is on its way. So the
 * answer is read from the room state the relay sends before acknowledging.
 */
export async function roomAddTracks(tracks: unknown[], before?: unknown) {
  const { member, room } = useTogether.getState();
  const waiting = new Set((room?.requests ?? []).map((r) => r.id));
  const requesting = roomRequesting();
  const ok = await roomCommand(
    requesting ? { kind: "request", tracks } : { kind: "enqueue", tracks, before },
  );
  const sent = (useTogether.getState().room?.requests ?? []).filter(
    (r) => r.by.id === member && !waiting.has(r.id),
  ).length;
  if (ok && sent)
    toast(
      sent === 1
        ? "Request sent. The leader decides what plays."
        : `${sent} requests sent. The leader decides what plays.`,
    );
  return ok;
}
// Requests this listener withdrew, so their disappearance is not reported
// as the leader declining them.
const cancelledRequests = new Set<string>();
export async function cancelRoomRequest(request: string) {
  cancelledRequests.add(request);
  const ok = await roomCommand({ kind: "cancelRequest", request });
  if (!ok) cancelledRequests.delete(request);
  return ok;
}
function requestOutcome(added: string[], refused: string[]) {
  const [a] = added,
    [r] = refused;
  if (a && !r)
    return added.length === 1
      ? `“${a}” was added to the queue.`
      : `${added.length} of your requests were added to the queue.`;
  if (r && !a)
    return refused.length === 1
      ? `Your request for “${r}” wasn’t added.`
      : `${refused.length} of your requests weren’t added.`;
  if (a && r)
    return `${added.length} of your requests ${added.length === 1 ? "was" : "were"} added to the queue, ${refused.length} ${refused.length === 1 ? "wasn’t" : "weren’t"}.`;
  return null;
}
/**
 * Tells the leader about new requests, and a guest what became of theirs.
 * Returns whether it said anything, so the same news is not toasted twice.
 */
function reportRequests(previous: RoomState, room: RoomState, member: string) {
  let said = false;
  const before = new Set((previous.requests ?? []).map((r) => r.id));
  const answers =
    room.owner === member ||
    room.members.find((m) => m.id === member)?.role === "dj";
  const arrived = (room.requests ?? []).filter(
    (r) => !before.has(r.id) && r.by.id !== member,
  );
  const [first] = arrived;
  if (answers && first) {
    toast(
      arrived.length === 1
        ? `${first.by.name} requested “${first.track.title}”.`
        : `${arrived.length} new song requests.`,
    );
    said = true;
  }
  // Accept all, or a change of mode, answers several requests at once; they
  // are told in one toast, since each toast replaces the one before it.
  const now = new Set((room.requests ?? []).map((r) => r.id));
  const added: string[] = [],
    refused: string[] = [];
  for (const request of previous.requests ?? []) {
    if (request.by.id !== member || now.has(request.id)) continue;
    if (cancelledRequests.delete(request.id)) continue;
    const accepted = [...room.queue, ...(room.history ?? [])].some(
      (e) => e.request === request.id,
    );
    (accepted ? added : refused).push(request.track.title);
  }
  const outcome = requestOutcome(added, refused);
  if (outcome) {
    toast(outcome);
    said = true;
  }
  return said;
}
/** The relay's clock, for countdowns and expiries it sets. */
export function roomNow() {
  return client?.serverNow() ?? Date.now();
}
export async function roomCommand(data: Record<string, unknown>) {
  if (useTogether.getState().status !== "connected") {
    toast("Wait for the room to reconnect.");
    return false;
  }
  useTogether.setState({ error: null });
  // "Previous" means back to the start or back a song depending on where the
  // song was when it was pressed; saying which keeps two presses at once from
  // doing both.
  const room = useTogether.getState().room;
  if (data.kind === "previous" && data.restart === undefined && room)
    data = { ...data, restart: position(room) > 3000 };
  return (await client?.command(data)) ?? false;
}
function position(room: RoomState) {
  const track = room.queue.find((e) => e.id === room.current)?.track;
  return Math.min(
    track?.durationMs || 86400000,
    room.positionMs +
      (room.playing
        ? Math.max(0, (client?.serverNow() ?? Date.now()) - room.at)
        : 0),
  );
}
async function applyLatest(force = false) {
  const { room, status } = useTogether.getState();
  if (applying || reconnectPause) {
    if (force) pendingForce = true;
    return;
  }
  if (!room || !client || status !== "connected" || awaitingFresh) return;
  if (awaitingSeed) return;
  force ||= pendingForce;
  pendingForce = false;
  const index = room.queue.findIndex((e) => e.id === room.current);
  const track = room.queue[index]?.track ?? null;
  // appliedEntry is "" for no song, so an empty room must compare as "" too
  // or it looks changed on every tick and re-syncs once a second.
  const state = usePlayer.getState(),
    changed =
      appliedEntry !== (room.current ?? "") || state.track?.id !== track?.id;
  if (!force && !changed && (state.notice || state.track?.playable === false)) {
    useTogether.setState({ sync: "Track unavailable" });
    // Which song: the relay moves on when everyone says so about the same one.
    client.send({ type: "status", status: "unavailable", entry: room.current });
    return;
  }
  // This player reached the end of the song the room is still counting down
  // (the room ends songs by their catalogue length, which can be a little
  // long, or missing). Starting it again would replay it from the top; it
  // waits for the next one instead, and tells the room it is over.
  const local = state.roomPlayback;
  const endedHere =
    !changed && !!local?.ended && local.entry === (room.current ?? "");
  // The relay ignores an end reported well before the song's length (this
  // player's clock may have run ahead), so it is repeated until the room
  // moves on rather than left to the relay's own clock.
  if (
    endedHere &&
    room.playing &&
    (reportedEnd.entry !== room.current ||
      Date.now() - reportedEnd.at >= END_REPORT_EVERY_MS)
  ) {
    reportedEnd = { entry: room.current ?? "", at: Date.now() };
    void client.command({ kind: "ended", current: room.current });
  }
  // Keyed by entry and media: the video version of a song is measured again.
  const lengthKey = `${room.current}:${track?.id}`;
  if (
    local?.entry === room.current &&
    local.durationMs > 0 &&
    track &&
    state.track?.id === track.id &&
    reportedLength !== lengthKey &&
    roomCanControl() &&
    (!track.durationMs ||
      (Math.abs(local.durationMs - track.durationMs) > 1000 &&
        Math.abs(local.durationMs - track.durationMs) <= 15000))
  ) {
    reportedLength = lengthKey;
    void client.command({
      kind: "duration",
      entry: room.current,
      durationMs: local.durationMs,
    });
  }
  const pos = position(room),
    playing =
      ["playing", "loading", "stalled"].includes(state.state) ||
      (endedHere && room.playing);
  const drift = Math.abs(currentPosition(state) - pos);
  const queueChanged =
    state.queue.length !== room.queue.length ||
    state.queue.some((t, i) => t.id !== room.queue[i]?.track.id);
  const correct =
    !endedHere &&
    drift > 1000 &&
    Date.now() - correctionAt > 4000 &&
    !["loading", "stalled"].includes(state.state);
  const sync = endedHere && room.playing
    ? "Waiting for the next song"
    : ["loading", "stalled"].includes(state.state)
    ? "Buffering"
    : drift > 1000 && room.playing
      ? "Catching up"
      : room.playing
        ? "In sync"
        : "Paused together";
  useTogether.setState({ sync });
  client.send({
    type: "status",
    entry: room.current,
    status:
      sync === "Buffering"
        ? "buffering"
        : sync === "Catching up"
          ? "catching up"
          : room.playing
            ? "listening"
            : "paused",
  });
  if (
    !force &&
    !changed &&
    !queueChanged &&
    state.followingRoom &&
    room.playing === playing &&
    !correct
  )
    return;
  applying = true;
  const version = generation;
  task = (async () => {
    try {
      if (force || changed) usePlayer.setState({ notice: null });
      await syncRoomPlayback(
        track,
        pos,
        room.playing,
        room.queue.map((e) => e.track),
        Math.max(0, index),
        room.current ?? undefined,
      );
      if (version === generation) {
        appliedEntry = room.current || "";
        correctionAt = Date.now();
      }
    } catch (err) {
      if (version === generation)
        useTogether.setState({
          error:
            err instanceof Error
              ? err.message
              : "Could not synchronize playback.",
        });
    } finally {
      applying = false;
    }
  })();
  await task;
  if (
    version === generation &&
    (room !== useTogether.getState().room || pendingForce)
  )
    void applyLatest();
}
// Mirrors the relay's permission rules, so a listener without them gets the
// answer here rather than a rejected round trip for every press.
function denied(room: RoomState, kind: string, data: Record<string, unknown>) {
  const { member } = useTogether.getState();
  if (kind === "repeat" && room.owner !== member)
    return "Only the leader can change room settings.";
  if (roomCanControl()) return null;
  if (kind === "enqueue" && room.mode === "contributions") return null;
  // A request has no position yet; the leader chooses where it goes.
  if (kind === "enqueueNext" && roomRequesting()) return null;
  // With nothing after the current song, "next" is an ordinary append.
  if (kind === "enqueueNext" && room.mode === "contributions")
    return room.queue[room.queue.findIndex((e) => e.id === room.current) + 1]
      ? "Only playback controllers may insert ahead of others."
      : null;
  if (kind === "remove" && room.mode === "contributions") {
    const entry = room.queue[Number(data.at)];
    return entry?.addedBy.id === member && entry.id !== room.current
      ? null
      : "You may only edit your upcoming contributions.";
  }
  if (kind === "move") return "The leader controls queue order.";
  return ["enqueue", "enqueueNext", "remove"].includes(kind)
    ? "This room is listen only."
    : "The leader controls playback in this room.";
}
// Dragging the seek bar fires every step; only where it settles is sent, so
// a scrub neither trips the relay's message limit nor races its own revisions.
// The song is pinned when the drag settles: if it changes in the meantime,
// the relay refuses the seek instead of applying it to the next song.
let seekTimer: ReturnType<typeof setTimeout> | undefined;
function routeSeek(positionMs: unknown, current: string | null) {
  clearTimeout(seekTimer);
  seekTimer = setTimeout(
    () => void roomCommand({ kind: "seek", positionMs, current }),
    150,
  );
}
function route(kind: string, data: Record<string, unknown> = {}) {
  const { room, status } = useTogether.getState();
  if (status === "disconnected") return false;
  if (!room && (status === "connecting" || status === "waiting")) return false;
  if (!room || status !== "connected") {
    toast("Wait for the room to connect.");
    return true;
  }
  if (kind === "shuffle") {
    toast("Choose First in, first out or Take turns in room settings.");
    return true;
  }
  // A guest who may only add songs asks for the one they picked, rather than
  // being told they cannot start it: from search (radio) or from an album or
  // playlist row (replace, whose first track is the one clicked).
  if (
    (kind === "radio" || kind === "replace") &&
    !roomCanControl() &&
    room.mode === "contributions"
  ) {
    const picked = kind === "radio" ? data.track : (data.tracks as unknown[] | undefined)?.[0];
    if (picked) void roomAddTracks([picked]);
    return true;
  }
  const reason = denied(room, kind, data);
  if (reason) {
    toast(reason);
    return true;
  }
  if (kind === "seek") {
    routeSeek(data.positionMs, room.current);
    return true;
  }
  if (kind === "radio") {
    void startRoomRadio(data.track as Track);
    return true;
  }
  if (["jump", "remove", "move"].includes(kind)) {
    const local = usePlayer.getState().queue;
    if (
      local.length !== room.queue.length ||
      local.some((t, i) => t.id !== room.queue[i]?.track.id)
    ) {
      toast("The room's queue changed. Try again in a moment.");
      return true;
    }
  }
  let command: Record<string, unknown> = { kind, ...data };
  if (Array.isArray(data.tracks) && data.tracks.length > 100) {
    command.tracks = data.tracks.slice(0, 100);
    toast("Using the first 100 songs. Add more in batches from your library.");
  }
  if (kind === "toggle") command = { kind: room.playing ? "pause" : "play" };
  if (kind === "jump" || kind === "remove")
    command.entry = room.queue[Number(data.at)]?.id;
  if (kind === "move") {
    command.entry = room.queue[Number(data.from)]?.id;
    const remaining = room.queue.filter((e) => e.id !== command.entry);
    command.before = remaining[Number(data.to)]?.id;
  }
  if (kind === "enqueueNext") {
    command.kind = "enqueue";
    command.before =
      room.queue[room.queue.findIndex((e) => e.id === room.current) + 1]?.id;
  }
  if (kind === "repeat")
    command = {
      kind: "settings",
      repeat:
        room.repeat === "off" ? "all" : room.repeat === "all" ? "one" : "off",
    };
  // Additions go through the relay's decision to queue or request them.
  if (command.kind === "enqueue" && Array.isArray(command.tracks))
    void roomAddTracks(command.tracks, command.before);
  else void roomCommand(command);
  return true;
}
/** The room's songs, played and upcoming, as ids, for leaving out repeats. */
function roomTrackIds(room: RoomState) {
  return new Set([
    ...room.queue.map((e) => e.track.id),
    ...room.history.map((e) => e.track.id),
  ]);
}
/**
 * How many radio songs the room will still take. Radio is nobody's pick, so
 * it is held to the room's size and to how much radio may wait at once
 * (the relay's RADIO_UPCOMING), not to anyone's contribution limit.
 */
function radioAllowance(room: RoomState) {
  const space = Math.min(100, 500 - room.queue.length);
  const at = room.queue.findIndex((e) => e.id === room.current);
  const waiting = room.queue.slice(at + 1).filter((e) => e.radio).length;
  return Math.min(space, 50 - waiting);
}
/** Radio songs worth adding after `seed`: playable, and not in the room already. */
async function radioFor(seed: string, room: RoomState) {
  const found = await api.radio(seed);
  const seen = roomTrackIds(useTogether.getState().room ?? room);
  seen.add(seed);
  return found.filter((t) => {
    if (t.playable === false || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}
/*
 * Plays a song in the room the way YouTube Music plays one on its own: the
 * song at once, then its radio after it. The radio is added only if the room
 * is still on that song when it arrives; someone may have picked another.
 */
export async function startRoomRadio(track: Track) {
  const version = generation;
  // The leader's top-up must not fetch the same radio a second time.
  radioSeed = track.id;
  radioBusy = true;
  try {
    if (!(await roomCommand({ kind: "replace", tracks: [track] }))) return;
    const room = useTogether.getState().room;
    if (!room) return;
    const tracks = await radioFor(track.id, room);
    const now = useTogether.getState().room;
    if (
      version !== generation ||
      !now ||
      now.queue.find((e) => e.id === now.current)?.track.id !== track.id
    )
      return;
    const allowed = radioAllowance(now);
    // Marked as radio: what people add later goes ahead of it.
    if (tracks.length && allowed > 0)
      await roomCommand({ kind: "enqueue", tracks: tracks.slice(0, allowed), radio: true });
  } catch {
    if (version === generation) toast("Couldn't load this song's radio.");
  } finally {
    if (version === generation) radioBusy = false;
  }
}
/*
 * Keeps a room's music going the way autoplay keeps a queue going: when fewer
 * than a handful of songs are left, the leader adds the last song's radio.
 * Only the leader does it, so members do not each add their own copy.
 */
async function topUpRoomRadio(room: RoomState) {
  const { member, status } = useTogether.getState();
  if (
    status !== "connected" ||
    room.owner !== member ||
    room.repeat !== "off" ||
    !useSettings.getState().autoplay ||
    radioBusy ||
    awaitingSeed ||
    Date.now() < radioRetryAt
  )
    return;
  const last = room.queue.at(-1);
  if (!last || last.track.id === radioSeed) return;
  const at = room.queue.findIndex((e) => e.id === room.current);
  if (room.queue.length - 1 - at >= RADIO_LOW) return;
  // Whoever just added this song may be adding its radio after it.
  if (roomNow() - (last.addedAt ?? 0) < 8000) return;
  const version = generation;
  radioBusy = true;
  try {
    const tracks = await radioFor(last.track.id, room);
    const { room: now, member: me } = useTogether.getState();
    // Still the leader, still wanting radio, and still the same end of queue.
    if (
      version !== generation ||
      !now ||
      now.owner !== me ||
      now.repeat !== "off" ||
      !useSettings.getState().autoplay ||
      now.queue.at(-1)?.id !== last.id
    )
      return;
    radioSeed = last.track.id;
    const allowed = radioAllowance(now);
    if (tracks.length && allowed > 0)
      await roomCommand({ kind: "enqueue", tracks: tracks.slice(0, allowed), radio: true });
  } catch {
    radioRetryAt = Date.now() + 30000;
  } finally {
    if (version === generation) radioBusy = false;
  }
}
/**
 * Leaves the room. Playback carries on with the room's queue unless
 * `keepQueue` is false, which brings back the queue from before the room.
 */
export async function leaveTogether(next?: string, keepQueue = true) {
  const leavingGeneration = ++generation;
  reconnectPause = null;
  pendingForce = false;
  awaitingFresh = false;
  awaitingSeed = false;
  clearInterval(timer);
  clearTimeout(seekTimer);
  const old = client;
  client = null;
  old?.leave(next);
  setRoomTransport(null);
  useTogether.setState({
    status: "disconnected",
    room: null,
    member: "",
    sync: "Ready to join",
  });
  await task;
  if (generation === leavingGeneration) {
    await leaveRoomPlayback(keepQueue);
    if (old && generation === leavingGeneration)
      useVideo.setState({ enabled: personalVideo });
  }
}
export async function connectTogether(options: ConnectOptions) {
  if (!isServerAuthoritative())
    throw new Error(
      "Wait for the local music service to connect, then try again.",
    );
  // Switching rooms: the next room starts from the personal queue, not the
  // last room's.
  await leaveTogether(undefined, false);
  const version = ++generation;
  const seed = usePlayer.getState();
  personalVideo = useVideo.getState().enabled;
  appliedEntry = "";
  lastVideo = 0;
  reportedEnd = { entry: "", at: 0 };
  reportedLength = "";
  radioSeed = "";
  radioBusy = false;
  radioRetryAt = 0;
  useTogether.setState({ error: null });
  setRoomTransport(route);
  let seeded = false;
  client = new RoomClientV2({
    onStatus: (status) => {
      if (version !== generation) return;
      useTogether.setState({ status });
      if (status === "reconnecting") {
        awaitingFresh = true;
        const paused = task.then(async () => {
          if (
            version === generation &&
            useTogether.getState().status === "reconnecting"
          ) {
            const s = usePlayer.getState();
            await syncRoomPlayback(
              s.track,
              currentPosition(s),
              false,
              s.queue,
              Math.max(0, s.index),
            );
          }
        });
        reconnectPause = paused
          .catch(() => {})
          .finally(() => {
            reconnectPause = null;
            if (version === generation) void applyLatest(true);
          });
        task = reconnectPause;
      }
    },
    onJoined: (member) => {
      if (version === generation) useTogether.setState({ member });
    },
    onError: (error) => {
      if (version === generation) {
        useTogether.setState({ error });
        toast(error);
      }
    },
    onEnded: (message) => {
      if (version === generation)
        void leaveTogether().then(() => {
          if (generation === version + 1)
            useTogether.setState({ error: message || null });
        });
    },
    onState: (room) => {
      if (version !== generation) return;
      const previous = useTogether.getState().room;
      if (previous && previous.revision > room.revision) return;
      awaitingFresh = false;
      useTogether.setState({ room });
      if (room.video && room.video.revision > lastVideo) {
        lastVideo = room.video.revision;
        if (
          room.video.by !== useTogether.getState().member &&
          useRoomPreferences.getState().followVideo
        )
          useVideo.setState({
            enabled: room.video.shown,
            revision: useVideo.getState().revision + 1,
          });
      }
      const told =
        !!previous && reportRequests(previous, room, useTogether.getState().member);
      if (
        previous &&
        !told &&
        useRoomPreferences.getState().notifications &&
        previous.activity.at(-1)?.id !== room.activity.at(-1)?.id
      )
        toast(room.activity.at(-1)?.text || "Room updated");
      if (!seeded && !options.pin) {
        seeded = true;
        if (seed.track) {
          // The creator's music keeps playing until the room has it at the
          // same place, rather than stopping for the empty first state.
          awaitingSeed = true;
          void roomCommand({
            kind: "enqueue",
            tracks: seed.queue.slice(
              Math.max(0, seed.index),
              Math.max(0, seed.index) + 100,
            ),
          })
            .then(async (ok) => {
              if (ok && version === generation) {
                const now = usePlayer.getState();
                await roomCommand({
                  kind: "seek",
                  positionMs: currentPosition(now),
                });
                if (["playing", "loading", "stalled"].includes(now.state))
                  await roomCommand({ kind: "play" });
              }
            })
            .finally(() => {
              if (version !== generation) return;
              awaitingSeed = false;
              void applyLatest();
            });
        }
      }
      const jumped =
        previous &&
        previous.current === room.current &&
        Math.abs(
          previous.positionMs +
            (previous.playing ? Math.max(0, room.at - previous.at) : 0) -
            room.positionMs,
        ) > 1000;
      void applyLatest(Boolean(jumped));
      void topUpRoomRadio(room);
    },
  });
  try {
    client.connect(options);
  } catch (err) {
    await leaveTogether();
    throw err;
  }
  timer = setInterval(() => void applyLatest(), 1000);
}
export function retryTogetherPlayback() {
  void applyLatest(true);
}
