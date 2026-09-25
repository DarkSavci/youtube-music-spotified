import { useState, type FormEvent } from "react";
import { checkRoomServer } from "../../../listen-together/client-v2.mjs";
import {
  saveRoomServer,
  useRoomPreferences,
  useTogether,
} from "../lib/together";
import { IconSettings } from "./Icon";
import { usePrompt } from "./Prompt";

/** The saved-server picker, and the form to add or edit one. */
export function RoomServers({
  manage,
  setManage,
  onError,
}: {
  manage: boolean;
  setManage: (open: boolean) => void;
  onError: (message: string) => void;
}) {
  const servers = useRoomPreferences((s) => s.servers),
    selectedId = useRoomPreferences((s) => s.selected),
    update = useRoomPreferences((s) => s.update);
  const status = useTogether((s) => s.status),
    inRoom = useTogether((s) => !!s.room),
    sync = useTogether((s) => s.sync);
  const [editing, setEditing] = useState<string>();
  const [serverName, setServerName] = useState(""),
    [serverURL, setServerURL] = useState(""),
    [serverCheck, setServerCheck] = useState("");
  const selected = servers.find((s) => s.id === selectedId);
  const prompt = usePrompt();
  const saveServer = (e: FormEvent) => {
    e.preventDefault();
    try {
      saveRoomServer(serverName, serverURL, editing);
      setManage(false);
      onError("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Invalid server address.");
    }
  };
  return (
    <>
      <div className="room-serverbar">
        <span className="room-serverdot" />
        <label>
          Server{" "}
          <select
            aria-label="Room server"
            value={selectedId}
            disabled={status !== "disconnected"}
            onChange={(e) => update({ selected: e.target.value })}
          >
            <option value="" disabled>
              Choose a server
            </option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="room-textbtn"
          disabled={status !== "disconnected"}
          onClick={() => {
            setEditing(selected?.id);
            setServerName(selected?.name || "");
            setServerURL(selected?.url || "");
            setManage(!manage);
          }}
        >
          <IconSettings size={17} />
          {selected ? "Manage" : "Add server"}
        </button>
        {inRoom && (
          <span className="room-sync" role="status">
            {status === "reconnecting" ? "Reconnecting…" : sync}
          </span>
        )}
      </div>
      {manage && (
        <form className="room-serveredit room-panel" onSubmit={saveServer}>
          <h2>{editing ? "Edit server" : "Add a server"}</h2>
          <p>
            Save this once. Your friends select the same server to join with a
            PIN.
          </p>
          <div className="room-formrow">
            <label>
              Name
              <input
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
                placeholder="Our music room"
              />
            </label>
            <label>
              Address
              <input
                required
                value={serverURL}
                onChange={(e) => setServerURL(e.target.value)}
                placeholder="wss://listen.example.com"
                spellCheck={false}
              />
            </label>
          </div>
          <div className="room-actions">
            <button className="room-primary">Save server</button>
            <button
              type="button"
              className="room-secondary"
              disabled={serverCheck === "Checking…"}
              onClick={() => {
                setServerCheck("Checking…");
                void checkRoomServer(serverURL).then(
                  () => setServerCheck("Ready for v2 rooms"),
                  (error) => setServerCheck(error.message),
                );
              }}
            >
              Test connection
            </button>
            <span role="status" className="room-servercheck">
              {serverCheck}
            </span>
            <button
              type="button"
              className="room-secondary"
              onClick={() => {
                setEditing(undefined);
                setServerName("");
                setServerURL("");
              }}
            >
              Add another
            </button>
            {editing && (
              <button
                type="button"
                className="room-textbtn"
                onClick={async () => {
                  const name = servers.find((s) => s.id === editing)?.name;
                  if (
                    !(await prompt.confirm({
                      title: `Remove ${name || "this server"}?`,
                      body: "You can add it again later with its address.",
                      confirmLabel: "Remove",
                      danger: true,
                    }))
                  )
                    return;
                  update({
                    servers: servers.filter((s) => s.id !== editing),
                    selected: "",
                  });
                  setManage(false);
                }}
              >
                Remove saved server
              </button>
            )}
            <button
              type="button"
              className="room-textbtn"
              onClick={() => setManage(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </>
  );
}
