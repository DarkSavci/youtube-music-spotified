import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RoomMode } from "../../../listen-together/client-v2.mjs";
import { api } from "../lib/api";
import {
  connectTogether,
  useRoomPreferences,
  useTogether,
} from "../lib/together";
import { RoomAvatar } from "./RoomAvatar";
import { IconArtist, IconChevronRight, IconPlus, IconQueue } from "./Icon";

export const roomPresets: {
  id: RoomMode;
  title: string;
  description: string;
}[] = [
  {
    id: "collaborative",
    title: "Everyone’s the DJ",
    description: "Everyone can play, pause, skip and shape the queue.",
  },
  {
    id: "contributions",
    title: "Take requests",
    description: "Friends add songs. You choose what plays and when.",
  },
  {
    id: "listen",
    title: "Just listen",
    description: "You handle the music. Friends settle in and listen.",
  },
];

/** Who you join as, and the create and join-by-PIN panels. */
export function RoomLobby({
  onNeedServer,
  onError,
}: {
  onNeedServer: () => void;
  onError: (message: string) => void;
}) {
  const prefs = useRoomPreferences();
  const status = useTogether((s) => s.status);
  const [pin, setPin] = useState(""),
    [mode, setMode] = useState<RoomMode>("collaborative");
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const accountName = me?.account?.name || "Listener";
  const name = prefs.name.trim() || accountName;
  const connect = async (join: boolean) => {
    const selected = prefs.servers.find((s) => s.id === prefs.selected);
    if (!selected) {
      onNeedServer();
      return;
    }
    onError("");
    try {
      await connectTogether({
        server: selected.url,
        profile: { name, avatar: prefs.avatar },
        mode,
        roomName: join ? undefined : prefs.roomName.trim(),
        ...(join ? { pin: pin.replace(/\s/g, "") } : {}),
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not connect.");
    }
  };
  return (
    <>
      <div className="room-identity">
        <RoomAvatar member={{ name, avatar: prefs.avatar }} />
        <label>
          Joining as
          <input
            maxLength={50}
            value={prefs.name}
            placeholder={accountName}
            onChange={(e) => prefs.update({ name: e.target.value })}
          />
        </label>
        {me?.account?.avatarUrl && (
          <label className="room-check">
            <input
              type="checkbox"
              checked={!!prefs.avatar}
              onChange={(e) =>
                prefs.update({
                  avatar: e.target.checked ? me.account?.avatarUrl || "" : "",
                })
              }
            />
            Share my profile picture
          </label>
        )}
      </div>
      <div className="rooms-lobby">
        <section className="room-panel room-create">
          <span className="room-featureicon">
            <IconQueue size={26} />
          </span>
          <h2>Start something good.</h2>
          <p>
            Pick the mood. Invite your people. Build the soundtrack together.
          </p>
          <label className="room-namefield" htmlFor="room-name">
            Room name <span>(optional)</span>
            <input
              id="room-name"
              maxLength={80}
              placeholder="Friday night together"
              value={prefs.roomName}
              onChange={(e) => prefs.update({ roomName: e.target.value })}
              aria-describedby="room-name-hint"
            />
            <small id="room-name-hint">
              Remembered on this device for your next room. Visible to
              listeners.
            </small>
          </label>
          <div
            className="room-presets"
            role="group"
            aria-label="Room permissions"
          >
            {roomPresets.map((p) => (
              <button
                key={p.id}
                aria-pressed={mode === p.id}
                className={`room-preset ${mode === p.id ? "is-selected" : ""}`}
                onClick={() => setMode(p.id)}
              >
                <span className="room-radio" />
                <span>
                  <strong>{p.title}</strong>
                  <small>{p.description}</small>
                </span>
              </button>
            ))}
          </div>
          <button
            className="room-primary"
            disabled={status !== "disconnected"}
            onClick={() => void connect(false)}
          >
            <IconPlus size={20} />
            {status === "connecting" ? "Connecting…" : "Create room"}
          </button>
        </section>
        <section className="room-panel room-join">
          <span className="room-featureicon">
            <IconArtist size={26} />
          </span>
          <h2>Your friends are waiting.</h2>
          <p>
            Enter their 8-digit PIN. Make sure you’re both on the same server.
          </p>
          <label htmlFor="room-pin">Room PIN</label>
          <input
            id="room-pin"
            className="room-pininput"
            inputMode="numeric"
            autoComplete="off"
            placeholder="0000 0000"
            maxLength={9}
            value={pin}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 8);
              setPin(
                digits.length > 4
                  ? `${digits.slice(0, 4)} ${digits.slice(4)}`
                  : digits,
              );
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                status === "disconnected" &&
                pin.replace(/\s/g, "").length === 8
              )
                void connect(true);
            }}
          />
          <button
            className="room-secondary"
            disabled={
              pin.replace(/\s/g, "").length !== 8 || status !== "disconnected"
            }
            onClick={() => void connect(true)}
          >
            Join room <IconChevronRight />
          </button>
          <div className="room-note">
            Joining pauses your personal queue. We’ll bring it back when you
            leave.
          </div>
        </section>
      </div>
    </>
  );
}
