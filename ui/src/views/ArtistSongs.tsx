import { useEffect, useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { TrackTable } from "../components/TrackTable";
import { PageState, TrackListSkeleton } from "../components/States";
import { PageError } from "./Home";
import { IconPlay } from "../components/Icon";
import { transport } from "../lib/playback";
import { artworkAtLeast } from "../lib/types";
import type { Album, Track } from "../lib/types";
import { useSettings } from "../lib/settings";
import { byAlbum, byPlays, missingAlbums, newestFirst, yearsByAlbum, type SongOrder } from "../lib/artistsongs";

const ORDERS: { id: SongOrder; label: string }[] = [
  { id: "popular", label: "Popular" },
  { id: "newest", label: "Newest" },
  { id: "album", label: "By album" },
];

// How many albums of unknown year are looked up one by one. The artist's own
// shelves and discography cover most; this is for the stragglers, and past it
// the rest are shown as undated rather than spending more requests.
const LOOKUP_LIMIT = 40;

/**
 * Every song by an artist (#48), in YouTube's most-played order, newest first,
 * or album by album.
 *
 * The list is the playlist the artist page's Top songs heading links to. It
 * is loaded a page at a time; the release years that ordering by date needs
 * are fetched only once that ordering is chosen.
 */
export function ArtistSongsView() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const order = (ORDERS.find((o) => o.id === params.get("order"))?.id ?? "popular") as SongOrder;
  const dated = order !== "popular";

  const artist = useQuery({ queryKey: ["artist", id], queryFn: ({ signal }) => api.artist(id, signal) });
  const songsId = artist.data?.songsId ?? "";

  // Shares its cache with the playlist page, which shows the same list.
  const songs = useInfiniteQuery({
    queryKey: ["playlist", songsId, "pages"],
    enabled: songsId !== "",
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) => api.playlistPage(songsId, pageParam, signal),
    getNextPageParam: (last, all) =>
      last.next && !all.slice(0, -1).some((p) => p.next === last.next) ? last.next : undefined,
  });
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = songs;
  // Ordering needs the whole list, and these lists are a few hundred songs.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  // Filtered here rather than by each table, so an index a table reports is
  // one into the list that is played.
  const showVideos = useSettings((s) => s.showMusicVideos);
  const tracks = useMemo(() => {
    const all = songs.data?.pages.flatMap((p) => p.playlist.tracks ?? []) ?? [];
    return byPlays(showVideos ? all : all.filter((t) => !t.isVideo));
  }, [songs.data, showVideos]);
  const complete = songs.isSuccess && !hasNextPage;

  // The discography behind the artist page's shelves, for the years its
  // shelves do not show. Only when a dated order asks for it.
  const more = [artist.data?.albumsMore, artist.data?.singlesMore].filter((l) => l?.id);
  const discography = useQuery({
    queryKey: ["artist", id, "discography"],
    enabled: dated && artist.isSuccess,
    staleTime: 10 * 60_000,
    queryFn: async ({ signal }) => {
      const pages = await Promise.all(
        more.map((l) => api.browse(l!.id, signal, l!.params).catch(() => null)),
      );
      return pages.flatMap((p) => p?.shelves ?? []).flatMap((s) => s.items ?? [])
        .flatMap((it) => (it.kind === "album" && it.album ? [it.album] : []));
    },
  });

  const known = useMemo(
    () => yearsByAlbum(artist.data?.albums, artist.data?.singles, discography.data),
    [artist.data, discography.data],
  );
  const missing = useMemo(
    () => (dated && complete && !discography.isPending ? missingAlbums(tracks, known).slice(0, LOOKUP_LIMIT) : []),
    [dated, complete, discography.isPending, tracks, known],
  );
  const lookups = useQuery({
    queryKey: ["artist", id, "album-years", missing.join(",")],
    enabled: missing.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async ({ signal }) => {
      const found: Album[] = [];
      const queue = [...missing];
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          for (let next = queue.shift(); next; next = queue.shift()) {
            try {
              found.push(await api.album(next, signal));
            } catch {
              if (signal.aborted) return;
            }
          }
        }),
      );
      return found;
    },
  });

  const years = useMemo(() => yearsByAlbum(artist.data?.albums, artist.data?.singles, discography.data, lookups.data), [artist.data, discography.data, lookups.data]);
  const albums = useMemo(() => {
    const out = new Map<string, Album>();
    for (const a of [...(artist.data?.albums ?? []), ...(artist.data?.singles ?? []), ...(discography.data ?? []), ...(lookups.data ?? [])])
      if (!out.has(a.id)) out.set(a.id, a);
    return out;
  }, [artist.data, discography.data, lookups.data]);

  const ordered = useMemo(() => (order === "newest" ? newestFirst(tracks, years) : tracks), [order, tracks, years]);
  const groups = useMemo(() => (order === "album" ? byAlbum(tracks, years) : []), [order, tracks, years]);
  // What Play and a row click play: the list as it is shown.
  const shown = useMemo(() => (order === "album" ? groups.flatMap((g) => g.tracks) : ordered), [order, groups, ordered]);

  if (artist.isPending) return <TrackListSkeleton />;
  if (artist.error) return <PageError error={artist.error} onRetry={() => void artist.refetch()} />;
  if (!artist.data) return <PageState title="Artist not found" />;
  if (!songsId) return <PageState title="No song list for this artist" body="YouTube does not list every song for this artist." />;

  const name = artist.data.name;
  const origin = `${name}: all songs`;
  const play = (list: Track[], index: number) => {
    const playable = list.filter((t) => t.playable);
    const target = list[index];
    const at = target ? playable.indexOf(target) : 0;
    if (playable.length > 0) transport.play(playable, Math.max(0, at), origin);
  };
  const resolving = dated && (!complete || discography.isFetching || lookups.isFetching);
  const undated = dated && complete && !resolving ? tracks.filter((t) => !(t.album?.id && years.has(t.album.id))).length : 0;

  return (
    <>
      <div className="artistsongs__head">
        <Link className="artistsongs__artist" to={`/artist/${encodeURIComponent(id)}`}>{name}</Link>
        <h1 className="artistsongs__title">All songs</h1>
      </div>
      <div className="entityactions">
        <button
          className="playbtn playbtn--accent playbtn--lg"
          aria-label={`Play all songs by ${name}`}
          disabled={shown.length === 0}
          onClick={() => play(shown, 0)}
        >
          <IconPlay size={24} />
        </button>
        <div className="artistsongs__sort" role="group" aria-label="Order">
          {ORDERS.map((o) => (
            <button
              key={o.id}
              className="chip"
              aria-pressed={order === o.id}
              onClick={() => setParams(o.id === "popular" ? {} : { order: o.id }, { replace: true })}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {songs.isPending ? <TrackListSkeleton /> : null}
      {songs.error && tracks.length === 0 ? <PageError error={songs.error} onRetry={() => void songs.refetch()} /> : null}
      {tracks.length > 0 ? (
        <p className="artistsongs__status" aria-live="polite">
          {!complete
            ? `Loading songs… ${tracks.length} so far`
            : resolving
              ? `${tracks.length} songs · finding release dates…`
              : undated > 0
                ? `${tracks.length} songs · ${undated} without a known release date, shown last`
                : `${tracks.length} songs`}
          {isFetchNextPageError ? " · Some songs could not be loaded." : null}
        </p>
      ) : null}

      {order === "album"
        ? groups.map((g) => {
            const album = g.id ? albums.get(g.id) : undefined;
            const art = artworkAtLeast(album?.artwork?.length ? album.artwork : g.tracks[0]?.artwork, 96);
            const offset = g.tracks[0] ? shown.indexOf(g.tracks[0]) : 0;
            return (
              <section key={g.id || "other"} className="artistsongs__group" aria-label={g.title}>
                <div className="artistsongs__grouphead">
                  {art ? <img className="artistsongs__groupart" src={art} alt="" loading="lazy" /> : null}
                  <div className="artistsongs__groupmeta">
                    {g.id ? (
                      <Link className="artistsongs__grouptitle" to={`/album/${encodeURIComponent(g.id)}`}>{g.title}</Link>
                    ) : (
                      <span className="artistsongs__grouptitle">{g.title}</span>
                    )}
                    <span className="artistsongs__groupsub">
                      {[g.year ? String(g.year) : g.id ? "Year unknown" : "", `${g.tracks.length} ${g.tracks.length === 1 ? "song" : "songs"}`]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                </div>
                <TrackTable
                  tracks={g.tracks}
                  origin={origin}
                  variant="album"
                  keepVideos
                  onPlayTrack={(i) => play(shown, offset + i)}
                />
              </section>
            );
          })
        : tracks.length > 0 ? (
            <TrackTable tracks={ordered} origin={origin} keepVideos onPlayTrack={(i) => play(ordered, i)} />
          ) : null}
    </>
  );
}
