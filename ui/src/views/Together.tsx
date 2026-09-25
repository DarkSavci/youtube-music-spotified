import { useState } from "react";
import { leaveTogether, useTogether } from "../lib/together";
import { RoomLive } from "../components/RoomLive";
import { RoomLobby } from "../components/RoomLobby";
import { RoomServers } from "../components/RoomServers";
import { IconClose } from "../components/Icon";

export function Together() {
  const room = useTogether((s) => s.room),
    member = useTogether((s) => s.member),
    status = useTogether((s) => s.status),
    sessionError = useTogether((s) => s.error);
  const [manage, setManage] = useState(false),
    [localError, setLocalError] = useState("");
  return (
    <div className="rooms-page">
      <header className="rooms-heading">
        <div>
          <span className="rooms-eyebrow">YOUR MUSIC, TOGETHER</span>
          <h1>Listen Together</h1>
          <p>A shared queue. Your own sound.</p>
        </div>
        <span className="rooms-preview">
          {import.meta.env.VITE_ROOM_PREVIEW
            ? "Isolated preview"
            : "Preview · v2"}
        </span>
      </header>
      {import.meta.env.VITE_ROOM_PREVIEW && (
        <p className="room-preview-note">
          Sample catalog for UI testing. Your installed app and live rooms are
          separate.
        </p>
      )}
      <RoomServers
        manage={manage}
        setManage={setManage}
        onError={setLocalError}
      />
      {(localError || sessionError) && (
        <div className="room-alert" role="alert">
          {localError || sessionError}
          <button
            className="iconbtn"
            aria-label="Dismiss error"
            onClick={() => {
              setLocalError("");
              useTogether.setState({ error: null });
            }}
          >
            <IconClose size={18} />
          </button>
        </div>
      )}
      {room ? (
        <RoomLive room={room} member={member} onError={setLocalError} />
      ) : (
        <RoomLobby
          onNeedServer={() => setManage(true)}
          onError={setLocalError}
        />
      )}
      {status === "waiting" && (
        <div className="room-panel" role="status">
          <h2>Waiting for the leader…</h2>
          <p>
            Your name and picture were sent for approval. You’ll join when they
            accept.
          </p>
          <button
            className="room-secondary"
            onClick={() => void leaveTogether()}
          >
            Cancel request
          </button>
        </div>
      )}
      {status === "connecting" && !room && (
        <button className="room-textbtn" onClick={() => void leaveTogether()}>
          Cancel connection
        </button>
      )}
      <footer className="rooms-footer">
        Music plays through each person’s own account. Volume stays personal.
        Only your chosen name, picture and room activity are shared.
      </footer>
    </div>
  );
}
