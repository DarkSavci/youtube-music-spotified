import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  RoomClientV2,
  type RoomState,
  type ConnectOptions,
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

interface Server {
  id: string;
  name: string;
  url: string;
}
interface Preferences {
  servers: Server[];
  selected: string;
  roomName: string;
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
export function roomCanControl() {
  const { room, member } = useTogether.getState();
  return (
    !!room &&
    (room.owner === member ||
      room.mode === "collaborative" ||
      room.members.find((m) => m.id === member)?.role === "dj")
  );
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
    client.send({ type: "status", status: "unavailable" });
    return;
  }
  const pos = position(room),
    playing = ["playing", "loading", "stalled"].includes(state.state);
  const drift = Math.abs(currentPosition(state) - pos);
  const queueChanged =
    state.queue.length !== room.queue.length ||
    state.queue.some((t, i) => t.id !== room.queue[i]?.track.id);
  const correct =
    drift > 1000 &&
    Date.now() - correctionAt > 4000 &&
    !["loading", "stalled"].includes(state.state);
  const sync = ["loading", "stalled"].includes(state.state)
    ? "Buffering"
    : drift > 1000 && room.playing
      ? "Catching up"
      : room.playing
        ? "In sync"
        : "Paused together";
  useTogether.setState({ sync });
  client.send({
    type: "status",
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
  const reason = denied(room, kind, data);
  if (reason) {
    toast(reason);
    return true;
  }
  if (kind === "seek") {
    routeSeek(data.positionMs, room.current);
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
  void roomCommand(command);
  return true;
}
export async function leaveTogether(next?: string) {
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
    await leaveRoomPlayback();
    if (old && generation === leavingGeneration)
      useVideo.setState({ enabled: personalVideo });
  }
}
export async function connectTogether(options: ConnectOptions) {
  if (!isServerAuthoritative())
    throw new Error(
      "Wait for the local music service to connect, then try again.",
    );
  await leaveTogether();
  const version = ++generation;
  const seed = usePlayer.getState();
  personalVideo = useVideo.getState().enabled;
  appliedEntry = "";
  lastVideo = 0;
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
      if (
        previous &&
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
