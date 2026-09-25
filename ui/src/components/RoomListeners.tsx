import type { Member, RoomState } from "../../../listen-together/client-v2.mjs";
import {
  retryTogetherPlayback,
  roomCommand,
  useRoomPreferences,
} from "../lib/together";
import { RoomAvatar } from "./RoomAvatar";
import { IconClose, IconSettings } from "./Icon";

/** Who is in the room, join requests, and this listener's own preferences. */
export function RoomListeners({
  room,
  member,
}: {
  room: RoomState;
  member: string;
}) {
  const owner = room.owner === member;
  const followVideo = useRoomPreferences((s) => s.followVideo),
    notifications = useRoomPreferences((s) => s.notifications),
    update = useRoomPreferences((s) => s.update);
  return (
    <aside className="room-panel room-listeners">
      {owner && room.pending.length > 0 && (
        <div className="room-waiting">
          <h3>Waiting to join</h3>
          {room.pending.map((p) => (
            <div key={p.id}>
              <RoomAvatar member={p} small />
              <span>{p.name}</span>
              <button
                className="room-textbtn"
                onClick={() =>
                  void roomCommand({ kind: "approve", request: p.id })
                }
              >
                Accept
              </button>
              <button
                className="iconbtn"
                aria-label={`Decline ${p.name}`}
                onClick={() =>
                  void roomCommand({ kind: "deny", request: p.id })
                }
              >
                <IconClose size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <h3>
        In the room <span>{room.members.length}</span>
      </h3>
      <ul>
        {room.members.map((m: Member) => (
          <li key={m.id}>
            <RoomAvatar member={m} />
            <div>
              <strong>
                {m.name}
                {m.id === member ? " (you)" : ""}
              </strong>
              <small>
                {room.owner === m.id
                  ? "Leader"
                  : m.role === "dj"
                    ? "DJ"
                    : "Listener"}{" "}
                · {m.connected ? m.status : "Reconnecting"}
              </small>
            </div>
            {owner && m.id !== member && (
              <details>
                <summary aria-label={`Manage ${m.name}`}>
                  <IconSettings size={16} />
                </summary>
                <div className="room-membermenu">
                  <button
                    onClick={() =>
                      void roomCommand({
                        kind: "role",
                        member: m.id,
                        role: m.role === "dj" ? "listener" : "dj",
                      })
                    }
                  >
                    {m.role === "dj" ? "Make listener" : "Make DJ"}
                  </button>
                  <button
                    disabled={!m.connected}
                    onClick={() =>
                      void roomCommand({ kind: "transfer", member: m.id })
                    }
                  >
                    Make leader
                  </button>
                  <button
                    onClick={() =>
                      void roomCommand({ kind: "kick", member: m.id })
                    }
                  >
                    Remove & rotate PIN
                  </button>
                </div>
              </details>
            )}
          </li>
        ))}
      </ul>
      <div className="room-localprefs">
        <small>
          Room expires at{" "}
          {new Date(room.expires).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </small>
        <h4>Your experience</h4>
        <label className="room-check">
          <input
            type="checkbox"
            checked={followVideo}
            onChange={(e) => update({ followVideo: e.target.checked })}
          />
          Follow others’ video display changes
        </label>
        <p>
          Everyone hears the same version. You decide whether to show its video.
        </p>
        <label className="room-check">
          <input
            type="checkbox"
            checked={notifications}
            onChange={(e) => update({ notifications: e.target.checked })}
          />
          Show room activity notifications
        </label>
        <button className="room-textbtn" onClick={retryTogetherPlayback}>
          Resync me
        </button>
        <small>Only affects your playback.</small>
      </div>
    </aside>
  );
}
