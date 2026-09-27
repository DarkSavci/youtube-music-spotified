import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { TrackTable } from "../components/TrackTable";
import { PageState, TrackListSkeleton } from "../components/States";
import { PageError } from "./Home";
import { IconPlay } from "../components/Icon";
import { transport } from "../lib/playback";
import { artworkAtLeast } from "../lib/types";
import type { Album, Track } from "../lib/types";
import { useSettings } from "../lib/settings";
import { editions, releasePlan, withReleases, byAlbum, byPlays, missingAlbums, newestFirst, yearsByAlbum, type SongOrder } from "../lib/artistsongs";

const ORDERS: { id: SongOrder; label: string }[] = [
  { id: "popular", label: "Popular" },
  { id: "newest", label: "Newest" },
  { id: "album", label: "By album" },
];

// How many releases open without asking. Each is a request to YouTube, so
// the first batch covers the artist's own albums and the likeliest singles,
// and a long discography opens this many more each time the listener asks.
const RELEASE_BATCH = 20;
// Releases opened at once.
const RELEASE_PARALLEL = 2;
// Opened releases stay cached this long after the page is left, so coming
// back, or opening one of them as an album, does not ask YouTube again.
const RELEASE_GC_MS = 6 * 60 * 60_000;
// How many releases each artist's page may open, kept for the session so
// going back to it does not lose the batches already asked for.
const releaseLimits = new Map<string, number>();

/**
 * Opens releases for their songs, in the order given, until `limit` of them
 * are open. The order may change as releases arrive (it sharpens as songs
 * become known) without restarting: what is open stays open, and the next
 * one taken is whatever now comes first. Each shares its cache with the
 * album page, and nothing more is started once the page is left.
 */
function useReleases(scope: string, order: string[], limit: number) {
  const qc = useQueryClient();
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  // `limited`: YouTube answered with a 429, so nothing more is started until
  // the listener asks again.
  type Run = { scope: string; opened: Map<string, Album | null>; inflight: Set<string>; abort: AbortController; limited: boolean };
  const run = useRef<Run | null>(null);
  const latest = useRef({ order, limit });
  latest.current = { order, limit };

  const pump = useCallback(() => {
    const r = run.current;
    if (!r) return;
    while (!r.abort.signal.aborted && !r.limited && r.inflight.size < RELEASE_PARALLEL && r.opened.size + r.inflight.size < latest.current.limit) {
      const id = latest.current.order.find((x) => !r.opened.has(x) && !r.inflight.has(x));
      if (!id) break;
      r.inflight.add(id);
      qc.fetchQuery({ queryKey: ["album", id], queryFn: ({ signal }) => api.album(id, signal), staleTime: 60 * 60_000, gcTime: RELEASE_GC_MS })
        .then((album) => album, (err) => {
          if (err instanceof ApiError && err.rateLimited) r.limited = true;
          return null;
        })
        .then((album) => {
          if (run.current !== r || r.abort.signal.aborted) return;
          r.inflight.delete(id);
          r.opened.set(id, album);
          bump();
          pump();
        });
    }
  }, [qc]);

  // One run per artist. Leaving the page, or another artist, stops its
  // queue; what is in flight still fills the cache.
  useEffect(() => {
    if (!scope) return;
    const r: Run = { scope, opened: new Map(), inflight: new Set(), abort: new AbortController(), limited: false };
    run.current = r;
    bump();
    pump();
    return () => {
      r.abort.abort();
      if (run.current === r) run.current = null;
    };
  }, [scope, pump]);
  const key = order.join(",");
  useEffect(() => pump(), [pump, key, limit]);

  const r = run.current?.scope === scope ? run.current : null;
  const albums = useMemo(
    () => (r ? [...r.opened.values()].filter((a): a is Album => a !== null) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r, version],
  );
  // Failed releases are not retried on their own, or a refusing server
  // would be asked forever; asking for more tries them again.
  const retryFailed = useCallback(() => {
    const cur = run.current;
    if (!cur) return;
    for (const [id, album] of cur.opened) if (album === null) cur.opened.delete(id);
    cur.limited = false;
    bump();
    pump();
  }, [pump]);
  return {
    albums,
    retryFailed,
    opened: r?.opened ?? EMPTY,
    loading: (r?.inflight.size ?? 0) > 0,
    limited: r?.limited ?? false,
    failed: r ? [...r.opened.values()].filter((a) => a === null).length : 0,
  };
}
const EMPTY = new Map<string, Album | null>();

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
  // The albums and the singles pages are fetched apart, so a release keeps
  // what kind it is: albums are opened before singles.
  const discography = useQuery({
    queryKey: ["artist", id, "discography"],
    enabled: dated && artist.isSuccess,
    staleTime: 10 * 60_000,
    queryFn: async ({ signal }) => {
      const load = async (l?: { id: string; params?: string }) => {
        if (!l?.id) return [];
        const page = await api.browse(l.id, signal, l.params).catch(() => null);
        return (page?.shelves ?? []).flatMap((s) => s.items ?? [])
          .flatMap((it) => (it.kind === "album" && it.album ? [it.album] : []));
      };
      const [albums, singles] = await Promise.all([load(artist.data?.albumsMore), load(artist.data?.singlesMore)]);
      return { albums, singles };
    },
  });
  const discAlbums = discography.data?.albums;
  const discSingles = discography.data?.singles;

  // How many releases may open; "Open more releases" raises it.
  const [limit, setLimitState] = useState(() => releaseLimits.get(id) ?? RELEASE_BATCH);
  useEffect(() => setLimitState(releaseLimits.get(id) ?? RELEASE_BATCH), [id]);
  const setLimit = (n: number) => {
    releaseLimits.set(id, n);
    setLimitState(n);
  };
  const ready = dated && complete && !discography.isPending;
  const [known, setKnown] = useState<Track[]>([]);
  const plan = useMemo(() => {
    if (!ready) return { order: [] as string[], covered: new Set<string>() };
    const albumsAll = [...(artist.data?.albums ?? []), ...(discAlbums ?? [])];
    const singlesAll = [...(artist.data?.singles ?? []), ...(discSingles ?? [])];
    const undatedListed = missingAlbums(tracks, yearsByAlbum(albumsAll, singlesAll));
    return releasePlan(undatedListed, albumsAll, singlesAll, known);
  }, [ready, artist.data, discAlbums, discSingles, tracks, known]);
  const releases = useReleases(ready ? id : "", plan.order, limit);

  const years = useMemo(
    () => yearsByAlbum(artist.data?.albums, artist.data?.singles, discAlbums, discSingles, releases.albums),
    [artist.data, discAlbums, discSingles, releases.albums],
  );
  const albums = useMemo(() => {
    const out = new Map<string, Album>();
    for (const a of [...releases.albums, ...(artist.data?.albums ?? []), ...(artist.data?.singles ?? []), ...(discAlbums ?? []), ...(discSingles ?? [])])
      if (!out.has(a.id)) out.set(a.id, a);
    return out;
  }, [artist.data, discAlbums, discSingles, releases.albums]);

  const canon = useMemo(() => editions([...albums.values()]), [albums]);

  // Dated orders show the whole discography; Popular is YouTube's list of
  // the most played, which is where it stops.
  const who = useMemo(() => ({ id, name: artist.data?.name ?? "" }), [id, artist.data?.name]);
  const all = useMemo(() => {
    if (!dated) return tracks;
    // Tracks from the artist's releases stay even when marked as videos, as
    // on album pages: some releases are published entirely as music videos.
    return withReleases(tracks, releases.albums, who);
  }, [dated, tracks, releases.albums, who]);
  // The songs found so far tell the plan which singles are already covered.
  useEffect(() => setKnown(all), [all]);

  const ordered = useMemo(() => (order === "newest" ? newestFirst(all, years, canon) : all), [order, all, years, canon]);
  const groups = useMemo(() => (order === "album" ? byAlbum(all, years, canon) : []), [order, all, years, canon]);
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
  // Of the planned releases, those not open yet: the ones left to open, and
  // among them singles whose song is already here.
  const unopened = plan.order.filter((r) => !releases.opened.has(r));
  // A 429 stops the run, so nothing is pending until the listener asks again.
  const pending = releases.loading || (!releases.limited && unopened.length > 0 && releases.opened.size < limit);
  const resolving = dated && (!complete || discography.isFetching || pending);
  // Only releases that actually opened; failures are counted apart.
  const openedCount = plan.order.filter((r) => releases.opened.get(r)).length;
  const coveredLeft = unopened.filter((r) => plan.covered.has(r)).length;
  const undated =
    dated && complete && !resolving
      ? all.filter((t) => !(t.album?.id && (canon.get(t.album.id)?.year || years.has(t.album.id)))).length
      : 0;
  const status = !complete
    ? `Loading songs… ${tracks.length} so far`
    : !dated
      ? // YouTube's list stops at about 150; a shorter one is not cut short.
        tracks.length >= 100
        ? `The ${tracks.length} most played · Newest and By album add the rest of the discography`
        : `${tracks.length} songs · Newest and By album add any the list misses`
      : resolving
        ? `${all.length} songs · opening releases ${openedCount} of ${plan.order.length}…`
        : [
            `${all.length} songs from ${openedCount} ${openedCount === 1 ? "release" : "releases"}`,
            unopened.length > coveredLeft
              ? `${unopened.length - coveredLeft} more ${unopened.length - coveredLeft === 1 ? "release" : "releases"} not opened yet`
              : "",
            coveredLeft > 0 ? `${coveredLeft} ${coveredLeft === 1 ? "single" : "singles"} not opened, as ${coveredLeft === 1 ? "its title song is" : "their title songs are"} already here` : "",
            releases.limited
              ? "YouTube is limiting requests; try again in a bit"
              : releases.failed > 0 ? `${releases.failed} could not be opened` : "",
            undated > 0 ? `${undated} without a known release date, shown last` : "",
          ].filter(Boolean).join(" · ");
  const canOpenMore = dated && complete && !resolving && unopened.length + releases.failed > 0;
  const moreCount = Math.min(RELEASE_BATCH, unopened.length + releases.failed);
  const openMore = () => {
    // The failures are tried again first, within the new batch.
    setLimit(releases.opened.size - releases.failed + RELEASE_BATCH);
    releases.retryFailed();
  };

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
          {canOpenMore ? (
            <button className="chip artistsongs__more" onClick={openMore}>
              {unopened.length === 0
                ? "Try again"
                : `Open ${moreCount} more ${moreCount === 1 ? "release" : "releases"}`}
            </button>
          ) : null}
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
