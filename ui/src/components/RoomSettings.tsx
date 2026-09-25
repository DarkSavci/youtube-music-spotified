import type { RoomState } from "../../../listen-together/client-v2.mjs";
import { roomCommand } from "../lib/together";
import { roomPresets } from "./RoomLobby";

const settings = (patch: Record<string, unknown>) =>
  void roomCommand({ kind: "settings", ...patch });

/** The leader's controls over permissions, joining and the queue. */
export function RoomSettings({ room }: { room: RoomState }) {
  return (
    <section className="room-panel room-settings">
      <h2>Room settings</h2>
      <div className="room-formrow">
        <label>
          Who controls playback?
          <select
            value={room.mode}
            onChange={(e) => settings({ mode: e.target.value })}
          >
            {roomPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Queue order
          <select
            value={room.policy}
            onChange={(e) => settings({ policy: e.target.value })}
          >
            <option value="fifo">First in, first out</option>
            <option value="turns">Take turns</option>
          </select>
        </label>
        <label>
          Songs per guest
          <input
            type="number"
            min={1}
            max={100}
            defaultValue={room.limit}
            onBlur={(e) => settings({ limit: Number(e.target.value) })}
          />
        </label>
      </div>
      <div className="room-actions">
        <label className="room-check">
          <input
            type="checkbox"
            checked={room.joinApproval}
            onChange={(e) => settings({ joinApproval: e.target.checked })}
          />
          Approve new listeners
        </label>
        <label className="room-check">
          <input
            type="checkbox"
            checked={room.locked}
            onChange={(e) => settings({ locked: e.target.checked })}
          />
          Lock new joins
        </label>
        <label className="room-check">
          <input
            type="checkbox"
            checked={room.duplicates}
            onChange={(e) => settings({ duplicates: e.target.checked })}
          />
          Allow duplicates
        </label>
        <label className="room-check">
          <input
            type="checkbox"
            checked={room.voteSkip}
            onChange={(e) => settings({ voteSkip: e.target.checked })}
          />
          Vote to skip
        </label>
        <button
          className="room-secondary"
          onClick={() => void roomCommand({ kind: "rotate" })}
        >
          Rotate PIN
        </button>
        <small>Everyone stays. The old PIN stops working.</small>
        <button
          className="room-secondary"
          onClick={() => void roomCommand({ kind: "countdown" })}
        >
          Start together / ready check
        </button>
      </div>
    </section>
  );
}
