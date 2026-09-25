import { useEffect, useRef, useState } from "react";
import { ArtistLinks } from "../components/EntityLinks";
import { warmFirst } from "../lib/warm";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, browsePath } from "../lib/api";
import { EntityHeader } from "../components/EntityHeader";
import { TrackTable } from "../components/TrackTable";
import { Shelf, Card } from "../components/Shelf";
import { PageState, TrackListSkeleton } from "../components/States";
import { PageError } from "./Home";
import { IconPlay } from "../components/Icon";
import { transport } from "../lib/playback";
import { formatDuration } from "../lib/types";
import type { Album, ShelfItem, Track } from "../lib/types";
import { toast } from "../lib/toast";
import { apiUrl } from "../lib/base";
import { useFollowArtist } from "../lib/playlists";
import { EntityActions } from "../components/EntityActions";

/* ---------- album ---------- */

/**
 * Resolves the track a page's play button would start.
 *
 * Opening an album is the strongest signal short of a click that something on
 * it is about to play, and the big play button always starts the first track.
 * Resolution takes about three seconds of upstream round trips, and reading
 * the page takes longer than that — so by the time the button is pressed the
 * answer is usually already waiting.
 */
function useWarmFirstTrack(tracks: Track[] | undefined) {
  // Keyed on the ids, not the array, so a refetch does not ask again.
  const key = (tracks ?? []).slice(0, 3).map((t) => t.id).join(",");
  useEffect(() => {
    warmFirst(tracks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export function AlbumView() {
  const { id = "" } = useParams();
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["album", id],
    queryFn: ({ signal }) => api.album(id, signal),
  });
  // Above the early returns: a hook has to run on every render.
  useWarmFirstTrack(data?.tracks);

  if (isPending) return <TrackListSkeleton />;
  if (error) return <PageError error={error} onRetry={() => void refetch()} />;
  if (!data) return <PageState title="Album not found" />;

  const tracks = data.tracks ?? [];
  return (
    <>
      <EntityHeader
        kind="Album"
        title={data.title}
        artwork={data.artwork}
        dominantColor={data.dominantColor}
        meta={
          <>
            <strong><ArtistLinks artists={data.artists} /></strong>
            {data.year ? <span>{`· ${data.year}`}</span> : null}
            <span>{`· ${data.trackCount} songs`}</span>
            {data.durationMs ? <span>{`· ${formatDuration(data.durationMs)}`}</span> : null}
          </>
        }
      />
      <div className="entityactions entityactions--sticky">
        <button
          className="playbtn playbtn--accent playbtn--lg"
          aria-label={`Play ${data.title}`}
          disabled={tracks.length === 0}
          onClick={() => transport.play(tracks, 0, data.title)}
        >
          <IconPlay size={24} />
        </button>
        <strong className="entityactions__title">{data.title}</strong>
        <EntityActions kind="album" id={data.id} title={data.title} tracks={tracks} />
      </div>
      {tracks.length > 0 ? (
        <TrackTable tracks={tracks} origin={data.title} variant="album" />
      ) : (
        <PageState title="No tracks" body="This album returned no playable tracks." />
      )}
    </>
  );
}

/* ---------- playlist ---------- */

export function PlaylistView() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const moreRef = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const [preparing, setPreparing] = useState(false);
  const { data: pages, isPending, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = useInfiniteQuery({
    queryKey: ["playlist", id, "pages"],
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) => api.playlistPage(id, pageParam, signal),
    getNextPageParam: (last, all) => last.next && !all.slice(0, -1).some((p) => p.next === last.next) ? last.next : undefined,
  });
  const data = pages?.pages[0]?.playlist;
  const hasUnloadedTracks = Boolean(pages?.pages.at(-1)?.next);
  const tracks = pages?.pages.flatMap((page) => page.playlist.tracks ?? []) ?? [];
  useWarmFirstTrack(data?.tracks);
  useEffect(() => { setPreparing(false); return () => { request.current++; }; }, [id]);
  useEffect(() => {
    const sentinel = moreRef.current;
    if (!sentinel || !hasNextPage || isFetchingNextPage || isFetchNextPageError) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) void fetchNextPage();
    }, { root: sentinel.closest(".main__scroll"), rootMargin: "0px 0px 600px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, tracks.length]);

  // Browsing is incremental. Actions promising the whole playlist explicitly
  // fetch it, never silently queue or copy only the visible prefix.
  const completeTracks = async () => {
    if (!hasUnloadedTracks) return tracks;
    const full = await qc.fetchQuery({ queryKey: ["playlist", id, "complete"], queryFn: ({ signal }) => api.playlist(id, signal), staleTime: 60_000 });
    return full.tracks ?? [];
  };
  const play = async (index: number) => {
    const generation = ++request.current;
    setPreparing(true);
    try {
      const full = await completeTracks();
      if (generation !== request.current) return;
      const selected = tracks[index];
      const at = selected?.playlistItemId
        ? full.findIndex((track) => track.playlistItemId === selected.playlistItemId)
        : full[index]?.id === selected?.id ? index : full.findIndex((track) => track.id === selected?.id);
      if (at < 0) { toast("This song is no longer in the playlist. Please refresh the page."); return; }
      transport.play(full, at, data?.title ?? "");
    } catch { if (generation === request.current) toast("Could not load the complete playlist. Please try again."); }
    finally { if (generation === request.current) setPreparing(false); }
  };

  if (isPending) return <TrackListSkeleton />;
  if (!data && error) return <PageError error={error} onRetry={() => void refetch()} />;
  if (!data) return <PageState title="Playlist not found" />;

  return (
    <>
      <EntityHeader
        kind={data.collaborative ? "Collaborative playlist" : "Playlist"}
        title={data.title}
        artwork={data.artwork}
        dominantColor={data.dominantColor}
        meta={
          <>
            {/* Owner is shown only when upstream supplies it, rather than
                printing an empty byline. */}
            {data.owner ? <strong>{data.owner}</strong> : null}
            <span title={data.trackCount === 5000 ? "YouTube reports this playlist’s total. Some playlists are limited to 5,000 songs; this is not the number loaded so far." : undefined}>{`${data.owner ? "· " : ""}${Math.max(data.trackCount, tracks.length).toLocaleString()}${hasUnloadedTracks && data.trackCount <= tracks.length ? "+" : ""} songs`}</span>
            {/* Exactly 5,000 is YouTube's cap; a larger total is not capped. The
                explanation is also in text, since a title reaches neither
                keyboard nor touch users. */}
            {data.trackCount === 5000 && <span className="playlist-limit-note">YouTube-reported count · <span title="YouTube may cap playlists at 5,000 songs. Additional songs are shown only when the service returns them.">Playlist limit may apply</span><span className="sr-only"> YouTube may cap playlists at 5,000 songs. Additional songs are shown only when the service returns them.</span></span>}
            {data.durationMs ? <span>{`· ${formatDuration(data.durationMs)}`}</span> : null}
          </>
        }
      />
      <div className="entityactions entityactions--sticky">
        <button
          className="playbtn playbtn--accent playbtn--lg"
          aria-label={`Play ${data.title}`}
          disabled={tracks.length === 0}
          // Stays focusable while preparing, so focus is not lost mid-load.
          aria-disabled={preparing}
          aria-busy={preparing}
          onClick={() => { if (!preparing) void play(0); }}
        >
          <IconPlay size={24} />
        </button>
        <strong className="entityactions__title">{data.title}</strong>
        <EntityActions kind="playlist" id={data.id} title={data.title} tracks={tracks} loadTracks={completeTracks} />
      </div>
      {tracks.length > 0 ? (
        <TrackTable tracks={tracks} origin={data.title} playlistId={data.id} keepVideos onPlayTrack={(index) => void play(index)} />
      ) : (
        <PageState
          title="This playlist is empty"
          body="Find something to add to it."
        />
      )}
      {hasUnloadedTracks && !hasNextPage ? <p role="status">
        More songs could not be loaded. <button className="btn" onClick={() => void refetch()}>Reload playlist</button>
      </p> : null}
      {preparing ? <p role="status">Preparing the full playlist…</p> : null}
      {hasNextPage ? <div ref={moreRef} className="playlist-more">
        <button className="btn" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
          {isFetchingNextPage ? "Loading more songs…" : isFetchNextPageError ? "Could not load more songs — retry" : "Load more songs"}
        </button>
        <span role="status">{tracks.length} songs loaded</span>
      </div> : null}
    </>
  );
}

/* ---------- artist ---------- */

interface Affinity {
  plays30d: number;
  playsAllTime: number;
  rankAmongYourArtists: number;
  firstListenedAt?: string;
  totalMs: number;
}

export function ArtistView() {
  const follow = useFollowArtist();
  const { id = "" } = useParams();
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["artist", id],
    queryFn: ({ signal }) => api.artist(id, signal),
  });

  /*
   * The artist page states whether the account already follows.
   *
   * This used to start at "not following" and only track what this session
   * had clicked, because the state was assumed not to be reported. It is —
   * the subscribe button in the header carries it — so the button now shows
   * the truth on arrival and only overrides it once the person clicks.
   *
   * `pending` holds that override: null means "show what the server said",
   * which is also what a click reverts to once the refetch lands.
   */
  const [pending, setPending] = useState<boolean | null>(null);
  useWarmFirstTrack(data?.topTracks);
  const followed = pending ?? data?.following ?? false;

  // A different artist is a different answer, so a click on one must not
  // colour the next page.
  useEffect(() => {
    setPending(null);
  }, [id]);

  // Hold the override until upstream agrees, rather than for a fixed moment:
  // dropping it as soon as the request returned showed the pre-click value
  // again until the refetch landed, so the button flicked back and forth.
  useEffect(() => {
    if (pending !== null && data?.following === pending) setPending(null);
  }, [data?.following, pending]);

  /**
   * The listener's own history with this artist, shown where a global
   * popularity metric would otherwise go. YouTube Music exposes no monthly
   * listener figure, and this is the better substitute rather than a fallback:
   * a global count describes strangers, this describes the reader.
   *
   * Failure is silent by design — an artist page must still render when there
   * is no history to show.
   */
  const affinity = useQuery({
    queryKey: ["affinity", id],
    queryFn: async ({ signal }) => {
      const res = await fetch(apiUrl(`/v1/artists/${encodeURIComponent(id)}/affinity`), { signal });
      if (!res.ok) return null;
      return (await res.json()) as Affinity;
    },
    retry: false,
  });


  if (isPending) return <TrackListSkeleton />;
  if (error) return <PageError error={error} onRetry={() => void refetch()} />;
  if (!data) return <PageState title="Artist not found" />;

  const top = data.topTracks ?? [];

  return (
    <>
      <EntityHeader
        kind="Artist"
        title={data.name}
        artwork={data.artwork}
        dominantColor={data.dominantColor}
        round
        meta={
          <span className="affinity">
            {/* YouTube publishes a monthly audience figure — the same metric
                other clients call monthly listeners — alongside subscribers.
                Both are shown, because they say different things and the text
                arrives already labelled. */}
            {data.monthlyListeners ? <strong>{data.monthlyListeners}</strong> : null}
            {data.monthlyListeners && data.subscribers ? <span>{"·"}</span> : null}
            {data.subscribers ? <span>{`${data.subscribers} subscribers`}</span> : null}
            {affinity.data && affinity.data.playsAllTime > 0 ? (
              <>
                {data.subscribers || data.monthlyListeners ? <span>{"·"}</span> : null}
                <span>
                  You&apos;ve played{" "}
                  <span className="affinity__strong">
                    {affinity.data.plays30d > 0
                      ? `${affinity.data.plays30d} ${affinity.data.plays30d === 1 ? "track" : "tracks"} in the last 30 days`
                      : `${affinity.data.playsAllTime} ${affinity.data.playsAllTime === 1 ? "track" : "tracks"}`}
                  </span>
                </span>
                {affinity.data.rankAmongYourArtists > 0 ? (
                  <>
                    <span>{"·"}</span>
                    <span>
                      <span className="affinity__strong">
                        #{affinity.data.rankAmongYourArtists}
                      </span>{" "}
                      in your top artists
                    </span>
                  </>
                ) : null}
              </>
            ) : null}
          </span>
        }
      />
      <div className="entityactions">
        <button
          className="playbtn playbtn--accent playbtn--lg"
          aria-label={`Play ${data.name}`}
          disabled={top.length === 0}
          onClick={() => transport.play(top, 0, data.name)}
        >
          <IconPlay size={24} />
        </button>
        <EntityActions kind="artist" id={data.id} title={data.name} tracks={top} />
        {/* Following is a channel subscription upstream, not a library
            addition, which is why it is keyed by the artist's id. */}
        <button
          className="chip"
          aria-pressed={followed}
          disabled={follow.isPending}
          onClick={() => {
            const next = !followed;
            setPending(next);
            follow.mutate(
              { artistId: data.id, follow: next },
              // A refused follow must not keep showing as one.
              { onError: () => setPending(null) },
            );
          }}
        >
          {followed ? "Following" : "Follow"}
        </button>
      </div>

      {/* Sections render only when the data exists. An artist with no albums
          must not leave an empty region behind. */}
      {top.length > 0 ? (
        <>
          <h2 className="shelf__title" style={{ marginTop: "var(--space-5)" }}>
            Popular
          </h2>
          <TrackTable tracks={top} origin={data.name} showArtwork={false} />
        </>
      ) : null}

      {data.albums && data.albums.length > 0 ? (
        <Shelf shelf={{ title: "Albums", items: albumItems(data.albums) }} />
      ) : null}
      {data.singles && data.singles.length > 0 ? (
        <Shelf shelf={{ title: "Singles and EPs", items: albumItems(data.singles) }} />
      ) : null}
      {data.related && data.related.length > 0 ? (
        <section className="shelf">
          <div className="shelf__header">
            <h2 className="shelf__title">Fans also like</h2>
          </div>
          <div className="shelf__row" style={{ "--card-count": 5 } as React.CSSProperties}>
            {data.related.slice(0, 5).map((ref) => (
              // The whole artist, so the card has artwork to draw. These used
              // to be narrowed to a name and an identifier, which is why the
              // row showed five empty circles.
              <Card key={ref.id || ref.name} item={{ kind: "artist", artist: ref }} />
            ))}
          </div>
        </section>
      ) : null}

      {data.description ? <About text={data.description} source={data.descriptionUrl} /> : null}
    </>
  );
}

/**
 * An artist's biography.
 *
 * Clipped to a few lines with a control to read the rest: these run to well
 * over a thousand characters, and a wall of prose between the music and the
 * rest of the page buries both.
 *
 * The source link is kept because the text is not ours — it arrives with a
 * link in its runs, and flattening that away left prose with no provenance.
 */
function About({ text, source }: { text: string; source?: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 400;

  return (
    <section className="shelf about">
      <div className="shelf__header">
        <h2 className="shelf__title">About</h2>
        {long ? (
          <button className="shelf__showall" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show less" : "Show all"}
          </button>
        ) : null}
      </div>
      <p className="about__text" data-clamped={(!expanded && long) || undefined}>
        {text}
      </p>
      {source ? (
        <p className="about__source">
          Source:{" "}
          <a href={source} target="_blank" rel="noreferrer noopener">
            {new URL(source).hostname.replace(/^www\./, "")}
          </a>
        </p>
      ) : null}
    </section>
  );
}

function albumItems(albums: Album[]): ShelfItem[] {
  return albums.map((album) => ({ kind: "album" as const, album }));
}

/* ---------- generic browse ---------- */

export function Browse() {
  const { surface = "" } = useParams();
  const [search] = useSearchParams();
  const params = search.get("params") ?? "";
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["browse", surface, params],
    queryFn: ({ signal }) => api.browse(surface, signal, params || undefined),
  });

  if (isPending) return <TrackListSkeleton rows={4} />;
  if (error) return <PageError error={error} onRetry={() => void refetch()} />;
  if (!data) return <PageState title="Nothing here" />;

  // A surface with a single shelf is a destination, not a landing page: it is
  // what "Show all" opens.
  const showAll = (data.shelves ?? []).length === 1;

  return (
    <>
      <h1 className="shelf__title" style={{ marginTop: "var(--space-5)" }}>
        {data.title || "Browse"}
      </h1>
      {data.moods && data.moods.length > 0 ? (
        <div className="moods">
          {data.moods.map((mood) => (
            <Link
              key={`${mood.id}:${mood.title}`}
              className="mood"
              to={browsePath(mood.id, mood.params)}
              style={{ "--tile-color": mood.color } as React.CSSProperties}
            >
              <span>{mood.title}</span>
            </Link>
          ))}
        </div>
      ) : null}
      {(data.shelves ?? []).map((shelf, i) => (
        <Shelf
          key={`${shelf.title}:${i}`}
          shelf={shelf}
          /*
           * A "Show all" surface is one shelf named after the page it is on,
           * so the heading appeared twice — once from the page, once from the
           * shelf. It is also the page that exists to show everything, so it
           * wraps rather than clipping to a single row.
           */
          layout={showAll ? "grid" : "row"}
          heading={!(showAll && sameTitle(shelf.title, data.title))}
        />
      ))}
    </>
  );
}

/** Titles match once case and the spacing YouTube pads them with are ignored. */
function sameTitle(a: string | undefined, b: string | undefined) {
  const norm = (s?: string) => (s || "").trim().toLowerCase();
  return norm(a) !== "" && norm(a) === norm(b);
}


/* ---------- podcast ---------- */

/**
 * A show and its episodes.
 *
 * Episodes are rendered by the same track table as music: they are Tracks with
 * a publication date, and the queue, the engine and the play log need no
 * knowledge that podcasts exist.
 */
export function PodcastView() {
  const { id = "" } = useParams();
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["podcast", id],
    queryFn: ({ signal }) => api.podcast(id, signal),
  });

  if (isPending) return <TrackListSkeleton rows={6} />;
  if (error) return <PageError error={error} onRetry={() => void refetch()} />;
  if (!data) return <PageState title="Nothing here" />;

  const episodes = data.episodes ?? [];

  return (
    <>
      <EntityHeader
        kind="Podcast"
        title={data.title}
        artwork={data.artwork}
        meta={
          <span className="affinity">
            {data.author ? <strong>{data.author}</strong> : null}
            {data.author && episodes.length > 0 ? <span>{"·"}</span> : null}
            {episodes.length > 0 ? (
              <span>{`${episodes.length} ${episodes.length === 1 ? "episode" : "episodes"}`}</span>
            ) : null}
          </span>
        }
      />
      <div className="entityactions">
        <button
          className="playbtn playbtn--accent playbtn--lg"
          aria-label={`Play ${data.title}`}
          disabled={episodes.length === 0}
          onClick={() => transport.play(episodes, 0, data.title)}
        >
          <IconPlay size={24} />
        </button>
        <EntityActions kind="podcast" id={data.id} title={data.title} tracks={episodes} />
      </div>

      {data.description ? (
        <p className="podcast__about">{data.description}</p>
      ) : null}

      {episodes.length > 0 ? (
        <TrackTable tracks={episodes} origin={data.title} variant="playlist" />
      ) : (
        <PageState
          title="No episodes"
          body="This show has no episodes we can read."
        />
      )}
    </>
  );
}
