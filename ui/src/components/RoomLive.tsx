import { useEffect, useRef, useState } from "react";
import type { RoomState } from "../../../listen-together/client-v2.mjs";
import {
  leaveTogether,
  roomCanControl,
  roomCommand,
  roomNow,
} from "../lib/together";
import { toast } from "../lib/toast";
import { artistNames, artworkAtLeast } from "../lib/types";
import { Artwork } from "./Artwork";
import { RoomAvatar } from "./RoomAvatar";
import { roomPresets } from "./RoomLobby";
import { RoomListeners } from "./RoomListeners";
import { RoomQueue } from "./RoomQueue";
import { RoomSettings } from "./RoomSettings";
import {
  IconCopy,
  IconPause,
  IconPlay,
  IconSettings,
  IconSkipNext,
  IconSkipPrev,
} from "./Icon";

function LeaveDialog({
  room,
  member,
  onClose,
}: {
  room: RoomState;
  member: string;
  onClose: () => void;
}) {
  const owner = room.owner === member;
  const [nextLeader, setNextLeader] = useState("");
  // An inline panel rather than a modal: focus moves to it so keyboard and
  // screen-reader users land on the choice they just asked for.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="room-panel room-leave" aria-label="Leave room">
      <h2 ref={heading} tabIndex={-1}>
        {owner ? "Keep the music going." : "Leave this room?"}
      </h2>
      <p>
        {owner
          ? "Choose the next leader, or let us pick a connected listener. The room and queue stay together."
          : "Your personal queue will be restored, paused."}
      </p>
      {owner && (
        <label>
          Next leader
          <select
            value={nextLeader}
            onChange={(e) => setNextLeader(e.target.value)}
          >
            <option value="">Choose someone at random</option>
            {room.members
              .filter((m) => m.id !== member && m.connected)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
      )}
      <div className="room-actions">
        <button
          className="room-primary"
          onClick={() => {
            void leaveTogether(nextLeader || undefined);
            onClose();
          }}
        >
          Leave room
        </button>
        <button className="room-secondary" onClick={onClose}>
          Stay
        </button>
        {owner && (
          <button
            className="room-danger"
            onClick={() => {
              void roomCommand({ kind: "end" });
              onClose();
            }}
          >
            End room for everyone
          </button>
        )}
      </div>
    </section>
  );
}

function ReadyCheck({ room, owner }: { room: RoomState; owner: boolean }) {
  const countdown = room.countdown;
  const [, setClock] = useState(0);
  const startAt = countdown?.startAt;
  useEffect(() => {
    if (!startAt) return;
    const timer = setInterval(() => setClock((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [startAt]);
  if (!countdown) return null;
  return (
    <div className="room-ready room-panel" role="status">
      <strong>
        {countdown.startAt
          ? `Starting in ${Math.max(0, Math.ceil((countdown.startAt - roomNow()) / 1000))}…`
          : "Ready for a shared start?"}
      </strong>
      <span>
        {room.members.filter((m) => m.ready && m.connected).length} of{" "}
        {room.members.filter((m) => m.connected).length} ready
      </span>
      <button
        className="room-primary"
        onClick={() => void roomCommand({ kind: "ready", ready: true })}
      >
        I’m ready
      </button>
      {owner && (
        <button
          className="room-secondary"
          onClick={() => void roomCommand({ kind: "countdown", force: true })}
        >
          Start in 3 seconds
        </button>
      )}
    </div>
  );
}

function NowPlaying({ room, control }: { room: RoomState; control: boolean }) {
  const canAdd = control || room.mode === "contributions";
  const current = room.queue.find((e) => e.id === room.current);
  return (
    <section className="room-now">
      <Artwork
        className="room-now__art"
        src={artworkAtLeast(current?.track.artwork, 320)}
        alt=""
      />
      <div className="room-now__body">
        <span className="rooms-eyebrow">
          {room.playing ? "NOW PLAYING, TOGETHER" : "READY WHEN YOU ARE"}
        </span>
        <h2>{current?.track.title || "Make the first pick."}</h2>
        <p>
          {current
            ? artistNames(current.track.artists)
            : canAdd
              ? "Add a song below, or use search anywhere in the app."
              : "The leader will pick the first song."}
        </p>
        {current && (
          <span className="room-added">
            <RoomAvatar small member={current.addedBy} />
            Added by {current.addedBy.name}
          </span>
        )}
        <div className="room-actions">
          <button
            className="iconbtn"
            disabled={!control}
            aria-label="Previous song"
            onClick={() => void roomCommand({ kind: "previous" })}
          >
            <IconSkipPrev />
          </button>
          <button
            className="room-play"
            disabled={!control || !current}
            aria-label={room.playing ? "Pause room" : "Play room"}
            onClick={() =>
              void roomCommand({ kind: room.playing ? "pause" : "play" })
            }
          >
            {room.playing ? <IconPause size={28} /> : <IconPlay size={28} />}
          </button>
          <button
            className="iconbtn"
            disabled={!control}
            aria-label="Next song"
            onClick={() => void roomCommand({ kind: "next" })}
          >
            <IconSkipNext />
          </button>
          {room.voteSkip && (
            <button
              className="room-textbtn"
              onClick={() => void roomCommand({ kind: "vote" })}
            >
              Vote to skip · {room.votes.length}
            </button>
          )}
        </div>
        {room.lastControlledBy && (
          <small>Last controlled by {room.lastControlledBy.name}</small>
        )}
      </div>
    </section>
  );
}

/** The room you are in: its header, now playing, queue and listeners. */
export function RoomLive({
  room,
  member,
  onError,
}: {
  room: RoomState;
  member: string;
  onError: (message: string) => void;
}) {
  const [settings, setSettings] = useState(false),
    [leaving, setLeaving] = useState(false);
  const owner = room.owner === member,
    control = roomCanControl();
  const copyPIN = () =>
    void navigator.clipboard.writeText(room.pin).then(
      () => toast("PIN copied. Friends need the same server."),
      () => onError("Could not copy. Select the PIN to copy it."),
    );
  return (
    <>
      <div className="room-sessionhead">
        <div>
          <span className="rooms-eyebrow">
            {roomPresets.find((p) => p.id === room.mode)?.title}
          </span>
          <h2>
            {room.name ||
              `${room.members.find((m) => m.id === room.owner)?.name || "Your friends"}’s room`}
          </h2>
        </div>
        <div className="room-pinshare">
          <span>Invite with PIN</span>
          <button onClick={copyPIN} title="Copy room PIN">
            {room.pin.slice(0, 4)} {room.pin.slice(4)}
            <IconCopy size={18} />
          </button>
        </div>
        <button className="room-secondary" onClick={() => setLeaving(true)}>
          Leave room
        </button>
        {owner && (
          <button
            className="iconbtn"
            aria-label="Room settings"
            aria-expanded={settings}
            onClick={() => setSettings(!settings)}
          >
            <IconSettings />
          </button>
        )}
      </div>
      {leaving && (
        <LeaveDialog
          room={room}
          member={member}
          onClose={() => setLeaving(false)}
        />
      )}
      {settings && owner && <RoomSettings room={room} />}
      <ReadyCheck room={room} owner={owner} />
      <div className="room-livegrid">
        <main>
          <NowPlaying room={room} control={control} />
          <RoomQueue
            room={room}
            member={member}
            control={control}
            onError={onError}
          />
        </main>
        <RoomListeners room={room} member={member} />
      </div>
    </>
  );
}
