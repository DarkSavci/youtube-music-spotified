import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { withReleases, byAlbum, byPlays, missingAlbums, newestFirst, yearsByAlbum, type SongOrder } from "../lib/artistsongs";

const ORDERS: { id: SongOrder; label: string }[] = [
  { id: "popular", label: "Popular" },
  { id: "newest", label: "Newest" },
  { id: "album", label: "By album" },
];

// How many releases are opened for their songs and years. Past it, the rest
// of a very long discography is left out rather than spending more requests.
const RELEASE_LIMIT = 120;

/**
 * Opens releases for their songs, four at a time, reporting as they arrive
 * so the page fills in rather than waiting on the slowest. Each shares its
 * cache with the album page.
 */
function useReleases(ids: string[]): { albums: Album[]; loading: boolean; done: number; failed: number } {
  const qc = useQueryClient();
  const key = ids.join(",");
  const [state, setState] = useState<{ key: string; albums: Album[]; done: number; failed: number }>({ key: "", albums: [], done: 0, failed: 0 });
  useEffect(() => {
    if (ids.length === 0) return;
    const abort = new AbortController();
    const queue = [...ids];
    setState({ key, albums: [], done: 0, failed: 0 });
    const work = async () => {
      for (let id = queue.shift(); id && !abort.signal.aborted; id = queue.shift()) {
        const albumId = id;
        try {
          const album = await qc.fetchQuery({
            queryKey: ["album", albumId],
            queryFn: ({ signal }) => api.album(albumId, signal),
            staleTime: 10 * 60_000,
          });
          if (!abort.signal.aborted)
            setState((s) => (s.key === key ? { ...s, albums: [...s.albums, album], done: s.done + 1 } : s));
        } catch {
          if (!abort.signal.aborted)
            setState((s) => (s.key === key ? { ...s, done: s.done + 1, failed: s.failed + 1 } : s));
        }
      }
    };
    for (let i = 0; i < 4; i++) void work();
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const current = state.key === key;
  return {
    albums: current ? state.albums : [],
    loading: ids.length > 0 && (!current || state.done < ids.length),
    done: current ? state.done : 0,
    failed: current ? state.failed : 0,
  };
}

/**
 * An artist's songs (#48): YouTube's most played, newest first, or album by
 * album.
 *
 * The most-played list is the playlist the artist page's Top songs heading
 * links to, and YouTube stops it at about 150. The dated orders complete it
 * from the artist's releases, which are opened only once one of them is
 * chosen, so those orders really are every song.
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

  // Every release: those the listed songs are on, the artist page's shelves
  // and the discography behind them.
  const releaseIds = useMemo(() => {
    if (!dated || !complete || discography.isPending) return [];
    const ids = [...(artist.data?.albums ?? []), ...(artist.data?.singles ?? []), ...(discography.data ?? [])].map((a) => a.id);
    // The list's own releases first: past the limit, a missing year on a
    // listed song costs more than a missing rarity.
    return [...new Set([...missingAlbums(tracks, new Map()), ...ids])].filter(Boolean).slice(0, RELEASE_LIMIT);
  }, [dated, complete, discography.isPending, discography.data, artist.data, tracks]);
  const releases = useReleases(releaseIds);

  const years = useMemo(
    () => yearsByAlbum(artist.data?.albums, artist.data?.singles, discography.data, releases.albums),
    [artist.data, discography.data, releases.albums],
  );
  const albums = useMemo(() => {
    const out = new Map<string, Album>();
    for (const a of [...releases.albums, ...(artist.data?.albums ?? []), ...(artist.data?.singles ?? []), ...(discography.data ?? [])])
      if (!out.has(a.id)) out.set(a.id, a);
    return out;
  }, [artist.data, discography.data, releases.albums]);

  // Dated orders show the whole discography; Popular is YouTube's list of
  // the most played, which is where it stops.
  const all = useMemo(() => {
    if (!dated) return tracks;
    const merged = withReleases(tracks, releases.albums);
    return showVideos ? merged : merged.filter((t) => !t.isVideo);
  }, [dated, tracks, releases.albums, showVideos]);

  const ordered = useMemo(() => (order === "newest" ? newestFirst(all, years) : all), [order, all, years]);
  const groups = useMemo(() => (order === "album" ? byAlbum(all, years) : []), [order, all, years]);
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
  const resolving = dated && (!complete || discography.isFetching || releases.loading);
  const undated = dated && complete && !resolving ? all.filter((t) => !(t.album?.id && years.has(t.album.id))).length : 0;
  const status = !complete
    ? `Loading songs… ${tracks.length} so far`
    : !dated
      ? `The ${tracks.length} most played · Newest and By album add the rest of the discography`
      : resolving
        ? `${all.length} songs · opening releases ${releases.done} of ${releaseIds.length}…`
        : [
            `${all.length} songs from ${releaseIds.length} releases`,
            releaseIds.length >= RELEASE_LIMIT ? `the first ${RELEASE_LIMIT} releases only` : "",
            releases.failed > 0 ? `${releases.failed} could not be opened` : "",
            undated > 0 ? `${undated} without a known release date, shown last` : "",
          ].filter(Boolean).join(" · ");

  return (
    <>
      <div className="artistsongs__head">
        <Link className="artistsongs__artist" to={`/artist/${encodeURIComponent(id)}`}>{name}</Link>
        <h1 className="artistsongs__title">Songs</h1>
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
          {status}
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
        : all.length > 0 ? (
            <TrackTable tracks={ordered} origin={origin} keepVideos onPlayTrack={(i) => play(ordered, i)} />
          ) : null}
    </>
  );
}
