import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, browsePath } from "../lib/api";
import { Card, Shelf } from "../components/Shelf";
import { TrackTable } from "../components/TrackTable";
import { PageState, ShelfSkeleton } from "../components/States";
import { PageError } from "./Home";
import type { ShelfItem } from "../lib/types";
import { IconClose, IconSearch } from "../components/Icon";
import { useRecentSearches } from "../lib/searches";
import { warmFirst, warmTrack } from "../lib/warm";

const FILTERS = [
  { id: "", label: "All" },
  { id: "songs", label: "Songs" },
  { id: "albums", label: "Albums" },
  { id: "artists", label: "Artists" },
  { id: "playlists", label: "Playlists" },
  { id: "videos", label: "Videos" },
  // YouTube Music carries podcasts as a first-class kind, with its own filter
  // chips; these were missing because the parser used to discard them.
  { id: "podcasts", label: "Podcasts" },
  { id: "episodes", label: "Episodes" },
];

/** Debounce so typing does not fire a request per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function Search() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const filter = params.get("filter") ?? "";
  const debounced = useDebounced(query, 250);
  const { recent, remember, forget, clear } = useRecentSearches();

  /*
   * A search is remembered once it has produced results, not as it is typed.
   *
   * Remembering every keystroke would fill the list with the prefixes of one
   * query, which is the opposite of useful.
   */
  useEffect(() => {
    if (debounced.trim().length >= 2) remember(debounced);
  }, [debounced, remember]);

  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: ["search", debounced, filter],
    queryFn: ({ signal }) => api.search(debounced, filter, signal),
    enabled: debounced.trim().length > 0,
  });

  // With no query, offer the mood grid as somewhere to go rather than a blank
  // page — the same role Spotify's browse-all tiles play.
  const browse = useQuery({
    queryKey: ["browse", "FEmusic_moods_and_genres"],
    queryFn: ({ signal }) => api.browse("FEmusic_moods_and_genres", signal),
    enabled: debounced.trim().length === 0,
  });

  const setFilter = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("filter", id);
    else next.delete("filter");
    setParams(next, { replace: true });
  };

  const songs = useMemo(() => tracksOf(data?.shelves ?? []), [data]);
  const topItems = data?.topResultItems ?? [];
  const topSongs = useMemo(() => tracksOf([{ items: data?.topResultItems ?? [] }]), [data]);
  const topOthers = topItems.filter((i) => i.kind !== "track");
  // The top result and the first songs are what a search gets clicked for.
  useEffect(() => {
    if (data?.topResult?.kind === "track") warmTrack(data.topResult.track?.id);
    warmFirst(songs, 2);
  }, [data, songs]);

  if (!debounced.trim()) {
    return (
      <>
        {/* Recent searches sit above browse-all, because someone opening
            search with nothing typed is more often returning to a search than
            starting a new one. */}
        {recent.length > 0 ? (
          <section className="recents">
            <div className="shelf__header">
              <h2 className="shelf__title">Recent searches</h2>
              <button className="shelf__showall" onClick={clear}>
                Clear
              </button>
            </div>
            <ul className="recents__list">
              {recent.map((q) => (
                <li key={q}>
                  <button
                    className="recents__item"
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.set("q", q);
                      setParams(next, { replace: true });
                    }}
                  >
                    <IconSearch size={16} />
                    <span className="truncate">{q}</span>
                  </button>
                  <button
                    className="iconbtn recents__remove"
                    aria-label={`Remove ${q} from recent searches`}
                    onClick={() => forget(q)}
                  >
                    <IconClose size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <h1 className="shelf__title" style={{ marginTop: "var(--space-5)" }}>
          Browse all
        </h1>
        {browse.isPending ? (
          <ShelfSkeleton />
        ) : browse.data?.moods?.length ? (
          <div className="moods">
            {browse.data.moods.map((mood) => (
              <a
                key={`${mood.id}:${mood.title}`}
                className="mood"
                href={`#${browsePath(mood.id, mood.params)}`}
                style={{ "--tile-color": mood.color } as React.CSSProperties}
              >
                <span>{mood.title}</span>
              </a>
            ))}
          </div>
        ) : (
          <PageState title="Search" body="Find songs, albums, artists and playlists." />
        )}
      </>
    );
  }

  return (
    <>
      <div className="sidebar__chips" style={{ padding: "var(--space-4) 0" }} role="group" aria-label="Filter results">
        {FILTERS.map((f) => (
          <button
            key={f.id || "all"}
            className="chip"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isPending || isFetching ? (
        <ShelfSkeleton />
      ) : error ? (
        <PageError error={error} onRetry={() => void refetch()} />
      ) : !data || (data.shelves.length === 0 && !data.topResult) ? (
        <PageState
          title={`No results for "${debounced}"`}
          body="Check the spelling, or try a different term."
        />
      ) : (
        <>
          {/* Top result beside the first songs, which is the arrangement that
              makes an unfiltered search scannable. */}
          {data.topResult ? (
            <section style={{ marginTop: "var(--space-5)" }}>
              <h2 className="shelf__title">Top result</h2>
              <div className="topresult">
                <div
                  className="shelf__row topresult__card"
                  style={{ "--card-count": 1 } as React.CSSProperties}
                >
                  <Card item={data.topResult} />
                </div>
                {/* What YouTube puts inside the card: the album's songs, the
                    artist's top songs, other versions of the song. */}
                {topSongs.length > 0 ? (
                  <div className="topresult__items">
                    <TrackTable tracks={topSongs} origin={`Search: ${debounced}`} playMode="radio" />
                  </div>
                ) : null}
              </div>
              {topOthers.length > 0 ? (
                <Shelf shelf={{ title: "", items: topOthers }} heading={false} />
              ) : null}
            </section>
          ) : null}

          {songs.length > 0 ? (
            <section style={{ marginTop: "var(--space-5)" }}>
              <h2 className="shelf__title">Songs</h2>
              <TrackTable tracks={songs} origin={`Search: ${debounced}`} playMode="radio" />
            </section>
          ) : null}

          {data.shelves
            .filter((s) => !isAllTracks(s.items))
            .map((shelf, i) => (
              <Shelf key={`${shelf.title}:${i}`} shelf={shelf} />
            ))}
        </>
      )}
    </>
  );
}

function tracksOf(shelves: { items: ShelfItem[] }[]) {
  const out = [];
  for (const shelf of shelves) {
    for (const item of shelf.items) {
      if (item.kind === "track" && item.track) out.push(item.track);
    }
  }
  return out;
}

function isAllTracks(items: ShelfItem[]): boolean {
  return items.length > 0 && items.every((i) => i.kind === "track");
}
