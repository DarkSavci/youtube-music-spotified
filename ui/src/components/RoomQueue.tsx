import { useEffect, useState } from "react";
import type { Entry, RoomState } from "../../../listen-together/client-v2.mjs";
import { api } from "../lib/api";
import { useCreatePlaylist } from "../lib/playlists";
import { roomCommand, roomNow } from "../lib/together";
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
import { IconClose, IconPlay, IconPlus, IconQueue, IconSearch } from "./Icon";

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
            title="Add to queue"
            aria-label={`Add ${entry.track.title} to queue`}
            onClick={() =>
              void roomCommand({ kind: "enqueue", tracks: [entry.track] })
            }
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
                .slice(activeIndex)
                .map((e, i) => row(e, activeIndex + i))}
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
    </>
  );
}
