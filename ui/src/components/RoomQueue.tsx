import { useEffect, useState } from "react";
import type {
  Entry,
  RoomState,
  SongRequest,
} from "../../../listen-together/client-v2.mjs";
import { api } from "../lib/api";
import { useCreatePlaylist } from "../lib/playlists";
import {
  cancelRoomRequest,
  roomAddTracks,
  roomCommand,
  roomNow,
  roomRequesting,
  startRoomRadio,
} from "../lib/together";
import { toast } from "../lib/toast";
import {
  artistNames,
  artworkAtLeast,
  formatDuration,
  type Track,
} from "../lib/types";
import { Artwork } from "./Artwork";
import { usePrompt } from "./Prompt";
import { RoomAvatar } from "./RoomAvatar";
import {
  IconCheckCircle,
  IconClose,
  IconPlay,
  IconPlus,
  IconQueue,
  IconRadio,
  IconSearch,
} from "./Icon";

function EntryRow({
  entry,
  index,
  room,
  member,
  control,
  canAdd,
  history = false,
}: {
  entry: Entry;
  index: number;
  room: RoomState;
  member: string;
  control: boolean;
  canAdd: boolean;
  history?: boolean;
}) {
  const requesting = roomRequesting();
  return (
    <li
      className={`room-track ${entry.id === room.current && !history ? "room-track--current" : ""}`}
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
        <RoomAvatar member={entry.addedBy} small />
      </span>
      <span className="room-track__duration">
        {formatDuration(entry.track.durationMs)}
      </span>
      {history ? (
        canAdd && (
          <button
            className="iconbtn"
            title={requesting ? "Request" : "Add to queue"}
            aria-label={
              requesting
                ? `Request ${entry.track.title}`
                : `Add ${entry.track.title} to queue`
            }
            onClick={() => void roomAddTracks([entry.track])}
          >
            <IconPlus />
          </button>
        )
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
          {entry.id !== room.current &&
            (control ||
              (room.mode === "contributions" &&
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
}

/**
 * Songs waiting for approval. The leader and DJs answer them; a guest sees
 * their own, and may withdraw them.
 */
function RoomRequests({
  room,
  member,
  answers,
}: {
  room: RoomState;
  member: string;
  answers: boolean;
}) {
  const requests = (room.requests ?? []).filter(
    (r) => answers || r.by.id === member,
  );
  if (!requests.length) return null;
  const answer = (kind: string, ids: string[], placement?: string) =>
    void roomCommand({ kind, requests: ids, placement });
  const row = (r: SongRequest) => (
    <li key={r.id} className="room-track room-request">
      <Artwork
        src={artworkAtLeast(r.track.artwork, 80)}
        className="room-track__art"
        alt=""
      />
      <span className="room-track__meta">
        <strong>{r.track.title}</strong>
        <span>
          {answers
            ? `${artistNames(r.track.artists)} · from ${r.by.name}`
            : artistNames(r.track.artists)}
        </span>
      </span>
      {answers ? (
        <>
          <span className="room-track__by" title={`Requested by ${r.by.name}`}>
            <RoomAvatar member={r.by} small />
          </span>
          <button
            className="room-textbtn"
            onClick={() => answer("acceptRequest", [r.id], "next")}
          >
            Play next
          </button>
          <button
            className="room-textbtn"
            onClick={() => answer("acceptRequest", [r.id], "end")}
          >
            Add to queue
          </button>
          <button
            className="iconbtn"
            title="Decline"
            aria-label={`Decline ${r.track.title} from ${r.by.name}`}
            onClick={() => answer("declineRequest", [r.id])}
          >
            <IconClose size={18} />
          </button>
        </>
      ) : (
        <>
          <span className="room-request__status">Pending</span>
          <button
            className="room-textbtn"
            aria-label={`Cancel your request for ${r.track.title}`}
            onClick={() => void cancelRoomRequest(r.id)}
          >
            Cancel
          </button>
        </>
      )}
    </li>
  );
  return (
    <section className="room-requests" aria-label="Song requests">
      <header>
        <h3>
          {answers ? "Requests" : "Your requests"}{" "}
          <span>{requests.length}</span>
        </h3>
        {answers && requests.length > 1 && (
          <button
            className="room-textbtn"
            onClick={() =>
              answer(
                "acceptRequest",
                requests.map((r) => r.id),
                "end",
              )
            }
          >
            <IconCheckCircle size={16} />
            Accept all
          </button>
        )}
      </header>
      <ul className="room-tracklist">{requests.map(row)}</ul>
    </section>
  );
}

function useSongSearch(query: string, onError: (message: string) => void) {
  const [results, setResults] = useState<Track[]>([]),
    [searching, setSearching] = useState(false);
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
          if (!abort.signal.aborted) onError(e.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearching(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
    // onError only reports; a new one must not restart the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  return { results, searching };
}

/** The room's upcoming queue with song search, its history and activity. */
export function RoomQueue({
  room,
  member,
  control,
  onError,
}: {
  room: RoomState;
  member: string;
  control: boolean;
  onError: (message: string) => void;
}) {
  const [tab, setTab] = useState<"queue" | "history" | "activity">("queue");
  const [query, setQuery] = useState("");
  const { results, searching } = useSongSearch(query, onError);
  const prompt = usePrompt(),
    createPlaylist = useCreatePlaylist();
  const activeIndex = Math.max(
    0,
    room.queue.findIndex((e) => e.id === room.current),
  );
  // Same rule as the relay: in a listen-only room only controllers add.
  const canAdd = control || room.mode === "contributions";
  const requesting = roomRequesting();
  const answers =
    room.owner === member ||
    room.members.find((m) => m.id === member)?.role === "dj";
  const waiting = answers ? (room.requests ?? []).length : 0;
  // The relay lets the person who made an edit, or the leader, undo it for
  // ten seconds; the offer disappears when it would be refused.
  const undo = room.undo;
  const [, setClock] = useState(0);
  const canUndo =
    !!undo &&
    undo.revision === room.revision &&
    (undo.by === member || room.owner === member) &&
    roomNow() < undo.expires;
  useEffect(() => {
    if (!canUndo || !undo) return;
    const timer = setTimeout(
      () => setClock((n) => n + 1),
      Math.max(0, undo.expires - roomNow()) + 50,
    );
    return () => clearTimeout(timer);
  }, [canUndo, undo]);
  const row = (entry: Entry, index: number, history = false) => (
    <EntryRow
      key={`${entry.id}:${index}`}
      entry={entry}
      index={index}
      room={room}
      member={member}
      control={control}
      canAdd={canAdd}
      history={history}
    />
  );
  const saveHistory = async () => {
    if (!room.history.length) return;
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
            onError(
              "Could not save the playlist. Check your sign-in and try again.",
            ),
        },
      );
  };
  return (
    <>
      <div className="room-queuetop">
        <nav aria-label="Room content">
          {(["queue", "history", "activity"] as const).map((t) => (
            <button
              key={t}
              className={tab === t ? "is-selected" : ""}
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
            >
              {t === "queue"
                ? `Queue · ${room.queue.length - activeIndex}`
                : t === "history"
                  ? "History"
                  : "Activity"}
              {t === "queue" && waiting > 0 && (
                <span
                  className="room-badge"
                  aria-label={`${waiting} waiting ${waiting === 1 ? "request" : "requests"}`}
                >
                  {waiting}
                </span>
              )}
            </button>
          ))}
        </nav>
        {canUndo && (
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
          {canAdd && (
            <label className="room-search">
              <IconSearch size={20} />
              <input
                aria-label={
                  requesting ? "Find songs to request" : "Find songs to add"
                }
                placeholder={
                  requesting
                    ? "Find a song to request from the leader"
                    : "Find a song to add to the room"
                }
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
          )}
          {query && canAdd ? (
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
                  {control && (
                    <button
                      className="room-secondary"
                      aria-label={`Play ${t.title} radio`}
                      title="Play now, then its radio"
                      onClick={() => {
                        setQuery("");
                        void startRoomRadio(t);
                      }}
                    >
                      <IconRadio size={18} />
                      Radio
                    </button>
                  )}
                  <button
                    className="room-secondary"
                    onClick={() => void roomAddTracks([t])}
                  >
                    <IconPlus size={18} />
                    {requesting ? "Request" : "Add"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <RoomRequests room={room} member={member} answers={answers} />
              <ul className="room-tracklist">
              {room.queue
                .slice(activeIndex)
                .map((e, i) => row(e, activeIndex + i))}
              {room.queue.length === 0 && (
                <li className="room-empty">
                  <IconQueue size={32} />
                  <p>Good music starts with one song.</p>
                </li>
              )}
              </ul>
            </>
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
    </>
  );
}
