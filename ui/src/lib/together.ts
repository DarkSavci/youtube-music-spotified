import { create } from "zustand";
import { RoomClient, type RoomStatus } from "../../../listen-together/client.mjs";
import { positionAt, type Snapshot } from "../../../listen-together/protocol.mjs";
import { currentPosition, usePlayer } from "./player";
import { transport, isServerAuthoritative, leaveRoomPlayback, syncRoomPlayback } from "./playback";

export const useTogether = create<RoomStatus>(() => ({ status: "disconnected", role: null, members: 0, invitation: "", error: null }));
let client: RoomClient | null = null;
let latest: Snapshot | null = null;
let interval: ReturnType<typeof setInterval> | undefined;
let unsubscribe: (() => void) | undefined;
let pendingPublish: ReturnType<typeof setTimeout> | undefined;
let applying = false;
let generation = 0;
let lastCorrection = 0;
let task: Promise<void> = Promise.resolve();

async function applyLatest(force = false) {
  if (applying || !latest || !client || useTogether.getState().role !== "guest") return;
  const snapshot = latest;
  const state = usePlayer.getState();
  const track = snapshot.track ? { ...snapshot.track, artwork: [], explicit: false, isVideo: false, playable: true } : null;
  const changed = track?.id !== state.track?.id;
  // A failed/unavailable track waits for a new selection or explicit retry.
  if (!changed && state.track?.playable === false && !force) return;
  if (!changed && state.notice && !force) return;
  const position = positionAt(snapshot, client.serverNow());
  const playing = state.state === "playing" || state.state === "loading" || state.state === "stalled";
  const drift = Math.abs(currentPosition(state) - position);
  const correct = drift > 800 && Date.now() - lastCorrection > 4000 && state.state !== "loading" && state.state !== "stalled";
  if (!force && state.followingRoom && !changed && playing === snapshot.playing && !correct) return;
  applying = true;
  const revision = generation;
  task = (async () => {
    try {
      if (force || changed) usePlayer.setState({ notice: null });
      await syncRoomPlayback(track, position, snapshot.playing);
      lastCorrection = Date.now();
    } catch (error) {
      if (revision === generation) useTogether.setState({ error: error instanceof Error ? error.message : "Could not synchronize playback." });
    } finally { applying = false; }
  })();
  await task;
  if (revision === generation && snapshot !== latest) void applyLatest();
}

export async function leaveTogether() {
  generation++;
  useTogether.setState({ status: "disconnected", role: null, members: 0 });
  const old = client; client = null; latest = null;
  clearInterval(interval); clearTimeout(pendingPublish); unsubscribe?.(); unsubscribe = undefined;
  old?.stop();
  await task;
  await leaveRoomPlayback();
}

export async function connectTogether(options: { server?: string; invitation?: string }) {
  if (!isServerAuthoritative()) throw new Error("Wait for the local music service to connect, then try again.");
  await leaveTogether();
  const revision = ++generation;
  const next = new RoomClient({
    onStatus: status => {
      if (revision !== generation) return;
      useTogether.setState(status);
      if (status.status === "disconnected") {
        void leaveTogether().then(() => {
          if (generation === revision + 1) useTogether.setState({ error: status.error ?? null });
        });
      } else if (status.status === "connected" && status.role === "guest") {
        // Pause existing playback while waiting for the first host snapshot.
        const current = usePlayer.getState();
        if (["playing", "loading", "stalled"].includes(current.state)) transport.toggle();
      }
    },
    onSnapshot: snapshot => {
      if (revision !== generation) return;
      const jumped = latest?.track?.id === snapshot.track?.id && latest !== null && Math.abs(positionAt(latest, snapshot.at) - snapshot.positionMs) > 1000;
      latest = snapshot;
      void applyLatest(jumped);
    },
    getSnapshot: () => {
      const state = usePlayer.getState();
      return { track: state.track, playing: state.state === "playing", positionMs: currentPosition(state) };
    },
  });
  client = next;
  try { next.connect(options); }
  catch (error) { await leaveTogether(); throw error; }
  interval = setInterval(() => { void applyLatest(); }, 1000);
  // Track, pause and seek changes get prompt updates; ordinary position
  // reports use the transport's periodic snapshot instead.
  let previous = usePlayer.getState();
  unsubscribe = usePlayer.subscribe(state => {
    const significant = state.track?.id !== previous.track?.id || state.state !== previous.state || Math.abs(currentPosition(previous) - currentPosition(state)) > 1000;
    previous = state;
    if (significant && useTogether.getState().role === "host") {
      clearTimeout(pendingPublish);
      pendingPublish = setTimeout(() => client?.publish(), 150);
    }
  });
}
export function retryTogetherPlayback() { void applyLatest(true); }
