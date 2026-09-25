import { useSettings } from "../lib/settings";
import { checkRoomServer } from "../../../listen-together/client-v2.mjs";
import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  connectTogether,
  leaveTogether,
  retryTogetherPlayback,
  roomCanControl,
  roomCommand,
  saveRoomServer,
  useRoomPreferences,
  useTogether,
} from "../lib/together";
import { api } from "../lib/api";
import {
  artistNames,
  artworkAtLeast,
  formatDuration,
  type Track,
} from "../lib/types";
import { toast } from "../lib/toast";
import { useCreatePlaylist } from "../lib/playlists";
import { usePrompt } from "../components/Prompt";
import { Artwork } from "../components/Artwork";
import {
  IconArtist,
  IconCopy,
  IconPlus,
  IconPlay,
  IconPause,
  IconSkipNext,
  IconSkipPrev,
  IconQueue,
  IconSettings,
  IconClose,
  IconSearch,
  IconChevronRight,
} from "../components/Icon";
import type {
  Entry,
  Member,
  RoomMode,
} from "../../../listen-together/client-v2.mjs";

const presets: { id: RoomMode; title: string; description: string }[] = [
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
function Avatar({
  member,
  small = false,
}: {
  member: { name: string; avatar?: string };
  small?: boolean;
}) {
  const [failed, setFailed] = useState("");
  return (
    <span
      className={`room-avatar ${small ? "room-avatar--small" : ""}`}
      title={member.name}
      aria-label={member.name}
    >
      {member.avatar && failed !== member.avatar ? (
        <img
          src={member.avatar}
          onError={() => setFailed(member.avatar || "")}
          alt=""
        />
      ) : (
        member.name.trim().slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
export function Together() {
  const sharing = useSettings();
  const [serverCheck, setServerCheck] = useState("");
  const session = useTogether(),
    prefs = useRoomPreferences();
  const { room, member, status } = session;
  const [manage, setManage] = useState(false),
    [editing, setEditing] = useState<string>();
  const [serverName, setServerName] = useState(""),
    [serverURL, setServerURL] = useState("");
  const [pin, setPin] = useState(""),
    [mode, setMode] = useState<RoomMode>("collaborative");
  const [localError, setLocalError] = useState(""),
    [settings, setSettings] = useState(false),
    [leaving, setLeaving] = useState(false);
  const [nextLeader, setNextLeader] = useState(""),
    [tab, setTab] = useState<"queue" | "history" | "activity">("queue");
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<Track[]>([]),
    [searching, setSearching] = useState(false);
  const selected = prefs.servers.find((s) => s.id === prefs.selected);
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const name = prefs.name || me?.account?.name || "Listener";
  const owner = room?.owner === member,
    control = roomCanControl();
  const current = room?.queue.find((e) => e.id === room.current);
  const activeIndex = room?.queue.findIndex((e) => e.id === room.current) ?? -1;
  const prompt = usePrompt(),
    createPlaylist = useCreatePlaylist();
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      api
        .search(query, "songs", abort.signal)
        .then((data) => {
          const tracks = data.shelves.flatMap((s) =>
            s.items.flatMap((i) => (i.track ? [i.track] : [])),
          );
          setResults(
            [...new Map(tracks.map((t) => [t.id, t])).values()].slice(0, 12),
          );
        })
        .catch((e) => {
          if (!abort.signal.aborted) setLocalError(e.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearching(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query]);
  const connect = async (join: boolean) => {
    if (!selected) {
      setManage(true);
      return;
    }
    setLocalError("");
    try {
      await connectTogether({
        server: selected.url,
        profile: { name, avatar: prefs.avatar },
        mode,
        roomName: join ? undefined : prefs.roomName.trim(),
        ...(join ? { pin: pin.replace(/\s/g, "") } : {}),
      });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Could not connect.");
    }
  };
  const saveServer = (e: FormEvent) => {
    e.preventDefault();
    try {
      saveRoomServer(serverName, serverURL, editing);
      setManage(false);
      setLocalError("");
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : "Invalid server address.",
      );
    }
  };
  const copyPIN = () => {
    if (room)
      void navigator.clipboard.writeText(room.pin).then(
        () => toast("PIN copied. Friends need the same server."),
        () => setLocalError("Could not copy. Select the PIN to copy it."),
      );
  };
  const saveHistory = async () => {
    if (!room?.history.length) return;
    const title = await prompt.text({
      title: "Save room discoveries",
      label: "Playlist name",
      initial: "Listen Together",
    });
    if (title)
      createPlaylist.mutate(
        { title, tracks: room.history.map((e) => e.track) },
        {
          onSuccess: () => toast("Room history saved to your library."),
          onError: () =>
            setLocalError(
              "Could not save the playlist. Check your sign-in and try again.",
            ),
        },
      );
  };
  const row = (entry: Entry, index: number, history = false) => (
    <li
      key={`${entry.id}:${index}`}
      className={`room-track ${entry.id === room?.current && !history ? "room-track--current" : ""}`}
    >
      <span className="room-track__number">{index + 1}</span>
      <Artwork
        src={artworkAtLeast(entry.track.artwork, 80)}
        className="room-track__art"
        alt=""
      />
      <span className="room-track__meta">
        <strong>{entry.track.title}</strong>
        <span>{artistNames(entry.track.artists)}</span>
      </span>
      <span className="room-track__by" title={`Added by ${entry.addedBy.name}`}>
        <Avatar member={entry.addedBy} small />
      </span>
      <span className="room-track__duration">
        {formatDuration(entry.track.durationMs)}
      </span>
      {history ? (
        <button
          className="iconbtn"
          title="Add to queue"
          aria-label={`Add ${entry.track.title} to queue`}
          onClick={() =>
            void roomCommand({ kind: "enqueue", tracks: [entry.track] })
          }
        >
          <IconPlus />
        </button>
      ) : (
        <>
          {control && (
            <button
              className="iconbtn"
              title="Play now"
              aria-label={`Play ${entry.track.title}`}
              onClick={() =>
                void roomCommand({ kind: "jump", entry: entry.id })
              }
            >
              <IconPlay size={18} />
            </button>
          )}
          {entry.id !== room?.current &&
            (control ||
              (room?.mode === "contributions" &&
                entry.addedBy.id === member)) && (
              <button
                className="iconbtn"
                title="Remove"
                aria-label={`Remove ${entry.track.title}`}
                onClick={() =>
                  void roomCommand({ kind: "remove", entry: entry.id })
                }
              >
                <IconClose size={18} />
              </button>
            )}
        </>
      )}
    </li>
  );
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
      <div className="room-serverbar">
        <span className="room-serverdot" />
        <label>
          Server{" "}
          <select
            aria-label="Room server"
            value={prefs.selected}
            disabled={status !== "disconnected"}
            onChange={(e) => prefs.update({ selected: e.target.value })}
          >
            <option value="" disabled>
              Choose a server
            </option>
            {prefs.servers.map((s) => (
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
        {room && (
          <span className="room-sync" role="status">
            {status === "reconnecting" ? "Reconnecting…" : session.sync}
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
                onClick={() => {
                  prefs.update({
                    servers: prefs.servers.filter((s) => s.id !== editing),
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
      {(localError || session.error) && (
        <div className="room-alert" role="alert">
          {localError || session.error}
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
      {!room ? (
        <>
          <div className="room-identity">
            <Avatar member={{ name, avatar: prefs.avatar }} />
            <label>
              Joining as
              <input
                maxLength={50}
                value={name}
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
                      avatar: e.target.checked
                        ? me.account?.avatarUrl || ""
                        : "",
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
                Pick the mood. Invite your people. Build the soundtrack
                together.
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
                <small id="room-name-hint">Remembered on this device for your next room. Visible to listeners.</small>
              </label>
              <div
                className="room-presets"
                role="radiogroup"
                aria-label="Room permissions"
              >
                {presets.map((p) => (
                  <button
                    key={p.id}
                    role="radio"
                    aria-checked={mode === p.id}
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
                Enter their 8-digit PIN. Make sure you’re both on the same
                server.
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
                  if (e.key === "Enter" && pin.replace(/\s/g, "").length === 8)
                    void connect(true);
                }}
              />
              <button
                className="room-secondary"
                disabled={
                  pin.replace(/\s/g, "").length !== 8 ||
                  status !== "disconnected"
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
      ) : (
        <>
          <div className="room-sessionhead">
            <div>
              <span className="rooms-eyebrow">
                {presets.find((p) => p.id === room.mode)?.title}
              </span>
              <h2>
                {room.name || `${room.members.find((m) => m.id === room.owner)?.name || "Your friends"}’s room`}
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
            <section
              className="room-panel room-leave"
              role="dialog"
              aria-label="Leave room"
            >
              <h2>{owner ? "Keep the music going." : "Leave this room?"}</h2>
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
                    setLeaving(false);
                  }}
                >
                  Leave room
                </button>
                <button
                  className="room-secondary"
                  onClick={() => setLeaving(false)}
                >
                  Stay
                </button>
                {owner && (
                  <button
                    className="room-danger"
                    onClick={() => {
                      void roomCommand({ kind: "end" });
                      setLeaving(false);
                    }}
                  >
                    End room for everyone
                  </button>
                )}
              </div>
            </section>
          )}
          {settings && owner && (
            <section className="room-panel room-settings">
              <h2>Room settings</h2>
              <div className="room-formrow">
                <label>
                  Who controls playback?
                  <select
                    value={room.mode}
                    onChange={(e) =>
                      void roomCommand({
                        kind: "settings",
                        mode: e.target.value,
                      })
                    }
                  >
                    {presets.map((p) => (
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
                    onChange={(e) =>
                      void roomCommand({
                        kind: "settings",
                        policy: e.target.value,
                      })
                    }
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
                    onBlur={(e) =>
                      void roomCommand({
                        kind: "settings",
                        limit: Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <div className="room-actions">
                <label className="room-check">
                  <input
                    type="checkbox"
                    checked={room.joinApproval}
                    onChange={(e) =>
                      void roomCommand({
                        kind: "settings",
                        joinApproval: e.target.checked,
                      })
                    }
                  />
                  Approve new listeners
                </label>
                <label className="room-check">
                  <input
                    type="checkbox"
                    checked={room.locked}
                    onChange={(e) =>
                      void roomCommand({
                        kind: "settings",
                        locked: e.target.checked,
                      })
                    }
                  />
                  Lock new joins
                </label>
                <label className="room-check">
                  <input
                    type="checkbox"
                    checked={room.duplicates}
                    onChange={(e) =>
                      void roomCommand({
                        kind: "settings",
                        duplicates: e.target.checked,
                      })
                    }
                  />
                  Allow duplicates
                </label>
                <label className="room-check">
                  <input
                    type="checkbox"
                    checked={room.voteSkip}
                    onChange={(e) =>
                      void roomCommand({
                        kind: "settings",
                        voteSkip: e.target.checked,
                      })
                    }
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
          )}
          {room.countdown && (
            <div className="room-ready room-panel" role="status">
              <strong>
                {room.countdown.startAt
                  ? `Starting in ${Math.max(0, Math.ceil((room.countdown.startAt - Date.now()) / 1000))}…`
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
                  onClick={() =>
                    void roomCommand({ kind: "countdown", force: true })
                  }
                >
                  Start in 3 seconds
                </button>
              )}
            </div>
          )}
          <div className="room-livegrid">
            <main>
              <section className="room-now">
                <Artwork
                  className="room-now__art"
                  src={artworkAtLeast(current?.track.artwork, 320)}
                  alt=""
                />
                <div className="room-now__body">
                  <span className="rooms-eyebrow">
                    {room.playing
                      ? "NOW PLAYING, TOGETHER"
                      : "READY WHEN YOU ARE"}
                  </span>
                  <h2>{current?.track.title || "Make the first pick."}</h2>
                  <p>
                    {current
                      ? artistNames(current.track.artists)
                      : "Add a song below, or use search anywhere in the app."}
                  </p>
                  {current && (
                    <span className="room-added">
                      <Avatar small member={current.addedBy} />
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
                        void roomCommand({
                          kind: room.playing ? "pause" : "play",
                        })
                      }
                    >
                      {room.playing ? (
                        <IconPause size={28} />
                      ) : (
                        <IconPlay size={28} />
                      )}
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
                    <small>
                      Last controlled by {room.lastControlledBy.name}
                    </small>
                  )}
                </div>
              </section>
              <div className="room-queuetop">
                <nav aria-label="Room content">
                  {(["queue", "history", "activity"] as const).map((t) => (
                    <button
                      key={t}
                      className={tab === t ? "is-selected" : ""}
                      onClick={() => setTab(t)}
                    >
                      {t === "queue"
                        ? `Queue · ${room.queue.length}`
                        : t === "history"
                          ? "History"
                          : "Activity"}
                    </button>
                  ))}
                </nav>
                {room.undo && room.undo.revision === room.revision && (
                  <button
                    className="room-textbtn"
                    onClick={() => void roomCommand({ kind: "undo" })}
                  >
                    Undo edit
                  </button>
                )}
              </div>
              {tab === "queue" && (
                <>
                  <label className="room-search">
                    <IconSearch size={20} />
                    <input
                      aria-label="Find songs to add"
                      placeholder="Find a song to add to the room"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                      <button
                        className="iconbtn"
                        aria-label="Clear search"
                        onClick={() => setQuery("")}
                      >
                        <IconClose size={18} />
                      </button>
                    )}
                  </label>
                  {query ? (
                    <ul className="room-tracklist">
                      {!searching && results.length === 0 && (
                        <li className="room-empty">
                          No songs found. Try another search.
                        </li>
                      )}
                      {searching && <li className="room-empty">Searching…</li>}
                      {results.map((t) => (
                        <li key={t.id} className="room-track">
                          <Artwork
                            src={artworkAtLeast(t.artwork, 80)}
                            className="room-track__art"
                            alt=""
                          />
                          <span className="room-track__meta">
                            <strong>{t.title}</strong>
                            <span>{artistNames(t.artists)}</span>
                          </span>
                          <button
                            className="room-secondary"
                            onClick={() =>
                              void roomCommand({ kind: "enqueue", tracks: [t] })
                            }
                          >
                            <IconPlus size={18} />
                            Add
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <ul className="room-tracklist">
                      {room.queue
                        .slice(Math.max(0, activeIndex))
                        .map((e, i) => row(e, Math.max(0, activeIndex) + i))}
                      {room.queue.length === 0 && (
                        <li className="room-empty">
                          <IconQueue size={32} />
                          <p>Good music starts with one song.</p>
                        </li>
                      )}
                    </ul>
                  )}
                </>
              )}
              {tab === "history" && (
                <>
                  <button
                    className="room-secondary"
                    disabled={!room.history.length || createPlaylist.isPending}
                    onClick={() => void saveHistory()}
                  >
                    Save as playlist
                  </button>
                  <ul className="room-tracklist">
                    {room.history.map((e, i) => row(e, i, true))}
                    {!room.history.length && (
                      <li className="room-empty">
                        Songs played in this room will appear here.
                      </li>
                    )}
                  </ul>
                </>
              )}
              {tab === "activity" && (
                <ol className="room-activity">
                  {[...room.activity].reverse().map((e) => (
                    <li key={e.id}>
                      <span>{e.text}</span>
                      <time>
                        {new Date(e.at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
            </main>
            <aside className="room-panel room-listeners">
              {owner && room.pending.length > 0 && (
                <div className="room-waiting">
                  <h3>Waiting to join</h3>
                  {room.pending.map((p) => (
                    <div key={p.id}>
                      <Avatar member={p} small />
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
                    <Avatar member={m} />
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
                              void roomCommand({
                                kind: "transfer",
                                member: m.id,
                              })
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
                {window.spotifier?.discordPresence && <label className="room-check">
                  <input type="checkbox" checked={sharing.discordShareRoom} disabled={!sharing.discordEnabled} onChange={e => sharing.set("discordShareRoom", e.target.checked)} />
                  Include room name in Discord activity
                </label>}
                {window.spotifier?.discordPresence && !sharing.discordEnabled && <small>Enable Discord activity in Settings to share your room name.</small>}
                <label className="room-check">
                  <input
                    type="checkbox"
                    checked={prefs.followVideo}
                    onChange={(e) =>
                      prefs.update({ followVideo: e.target.checked })
                    }
                  />
                  Follow others’ video display changes
                </label>
                <p>
                  Everyone hears the same version. You decide whether to show
                  its video.
                </p>
                <label className="room-check">
                  <input
                    type="checkbox"
                    checked={prefs.notifications}
                    onChange={(e) =>
                      prefs.update({ notifications: e.target.checked })
                    }
                  />
                  Show room activity notifications
                </label>
                <button
                  className="room-textbtn"
                  onClick={retryTogetherPlayback}
                >
                  Resync me
                </button>
                <small>Only affects your playback.</small>
              </div>
            </aside>
          </div>
        </>
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
