import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useMixes, type Mix } from "../lib/mixes";
import { transport } from "../lib/playback";
import { artworkAtLeast } from "../lib/types";
import { IconPlay } from "../components/Icon";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, browsePath } from "../lib/api";
import { Shelf } from "../components/Shelf";
import { PageState, ShelfSkeleton } from "../components/States";
import type { BrowsePage, HomeChip } from "../lib/types";

/**
 * Home.
 *
 * The chip row is YouTube Music's own: "Energize", "Relax", "Workout"… Each
 * chip re-seeds the whole page by mood rather than filtering it by content
 * type, since YouTube supplies no meaningful type split. The chosen chip lives
 * in the URL (?mood=<params>), so Back undoes it; choosing it again clears it.
 *
 * Like YouTube's, the page arrives a few shelves at a time. The next few are
 * asked for only when the bottom of the page is scrolled into view, never
 * ahead of it: every page is a request to YouTube, and YouTube answers too
 * many of them with 429s.
 */

export function Home() {
  const [search, setSearch] = useSearchParams();
  const mood = search.get("mood") ?? "";

  const first = useQuery({
    queryKey: ["home", mood],
    queryFn: ({ signal }) => api.home(signal, mood),
    // The chip row stays put while another chip's page loads.
    placeholderData: keepPreviousData,
  });
  const page = first.isPlaceholderData ? undefined : first.data;

  // The last chip row seen, so a chip page that fails still offers the others.
  const lastChips = useRef<HomeChip[]>([]);
  if (first.data?.chips?.length) lastChips.current = first.data.chips;
  const chips = first.data?.chips?.length ? first.data.chips : lastChips.current;

  const more = useHomeMore(mood, page?.continuation);

  /**
   * Mixes built from this machine's listening history. They are absent until
   * there is enough history to seed them, which is a normal early state rather
   * than a failure — so a miss renders nothing instead of an error.
   */
  const mixes = useMixes();

  const choose = (params: string) => {
    // Choosing the chosen chip goes back to plain Home, as on YouTube.
    setSearch(params && params !== mood ? { mood: params } : {});
  };
  const row = chips.length > 0 ? <HomeChips chips={chips} mood={mood} onChoose={choose} /> : null;

  if (first.isPending) return <HomeSkeleton />;
  if (!page) {
    return (
      <>
        {row}
        {first.error ? <PageError error={first.error} onRetry={() => void first.refetch()} /> : <HomeSkeleton />}
      </>
    );
  }
  const loaded = more.pages.flatMap((p) => p.shelves ?? []);
  if (page.shelves.length === 0 && !page.moods?.length && loaded.length === 0 && !more.canLoad) {
    return (
      <>
        {row}
        <PageState
          title="Nothing to show yet"
          body="Listen to a few things and recommendations will appear here."
        />
      </>
    );
  }

  return (
    <>
      {row}
      {mood ? null : <MadeForYou mixes={mixes.data ?? []} />}
      <BrowseContent page={page} />
      {loaded.map((shelf, i) => (
        <Shelf key={`more:${shelf.title}:${i}`} shelf={shelf} />
      ))}
      <HomeMoreFooter more={more} />
    </>
  );
}

/** Home's mood chips: one pill per mood, the chosen one pressed. */
function HomeChips({ chips, mood, onChoose }: { chips: HomeChip[]; mood: string; onChoose: (params: string) => void }) {
  // The URL says which chip is chosen. A row that does not carry that chip's
  // params (YouTube re-encoded them) falls back to its own selected flag.
  const known = chips.some((c) => c.params === mood);
  return (
    <div className="homechips" role="group" aria-label="Moods">
      {chips.map((chip) => {
        const pressed = mood ? (known ? chip.params === mood : Boolean(chip.selected)) : false;
        return (
          <button
            key={chip.params}
            type="button"
            className="chip homechips__chip"
            aria-pressed={pressed}
            onClick={() => onChoose(pressed ? "" : chip.params)}
          >
            {chip.title}
          </button>
        );
      })}
    </div>
  );
}

type HomeMore = ReturnType<typeof useHomeMore>;

/**
 * The rest of Home, page by page, starting from the first page's token.
 *
 * The query is never enabled: nothing reads a page until the sentinel at the
 * bottom asks for it, and a stale Home revisited does not re-read every page
 * it once scrolled through. Keyed by the first page's token, so a new first
 * page starts over rather than appending to an old one.
 */
function useHomeMore(mood: string, token: string | undefined) {
  const q = useInfiniteQuery({
    queryKey: ["home", mood, "more", token ?? ""],
    initialPageParam: token ?? "",
    queryFn: ({ signal, pageParam }) => api.homeMore(pageParam, signal),
    getNextPageParam: (last, _all, _param, params) =>
      // A token seen before would page in a circle; Home ends there.
      last.continuation && last.continuation !== token && !params.includes(last.continuation)
        ? last.continuation
        : undefined,
    enabled: false,
  });
  const { fetchNextPage } = q;
  // Never restarts a page already on its way.
  const load = useCallback(() => void fetchNextPage({ cancelRefetch: false }), [fetchNextPage]);
  const pages: BrowsePage[] = q.data?.pages ?? [];
  const canLoad = Boolean(token) && (pages.length === 0 ? true : q.hasNextPage);
  return {
    pages,
    canLoad,
    loading: q.isFetching,
    error: q.isError && !q.isFetching ? q.error : null,
    load,
  };
}

function HomeMoreFooter({ more }: { more: HomeMore }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { canLoad, loading, error, load, pages } = more;

  // Asks for the next page once the bottom of Home is actually in view, with
  // no margin ahead of it: a page nobody scrolls to is never read. A failed
  // page waits for its retry button instead of asking again.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canLoad || loading || error) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) load();
    }, { root: el.closest(".main__scroll"), rootMargin: "0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [canLoad, loading, error, load, pages.length]);

  if (error) {
    const hint = error instanceof ApiError && error.rateLimited ? ` ${waitHint(error.retryAfter)}` : "";
    return (
      <div className="homemore" role="status">
        <span>{`Couldn't load more of Home.${hint}`}</span>
        <button type="button" className="chip" onClick={load}>Try again</button>
      </div>
    );
  }
  if (loading) {
    return (
      <div aria-busy="true" aria-label="Loading more">
        <ShelfSkeleton />
      </div>
    );
  }
  return canLoad ? <div ref={sentinel} className="homemore__sentinel" aria-hidden="true" /> : null;
}

/** Shared by Home and every other shelf-or-grid browse surface. */
export function BrowseContent({ page }: { page: BrowsePage }) {
  return (
    <>
      {page.moods && page.moods.length > 0 ? (
        <section aria-label="Moods and genres">
          <h2 className="shelf__title" style={{ marginTop: "var(--space-5)" }}>
            {page.title || "Browse"}
          </h2>
          <div className="moods">
            {page.moods.map((mood) => (
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
        </section>
      ) : null}

      {(page.shelves ?? []).map((shelf, i) => (
        <Shelf key={`${shelf.title}:${i}`} shelf={shelf} />
      ))}
    </>
  );
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading home">
      <ShelfSkeleton />
      <ShelfSkeleton />
      <ShelfSkeleton />
    </div>
  );
}

/** "Try again in a minute", from a 429's Retry-After when the core sent one. */
export function waitHint(retryAfter: number): string {
  if (retryAfter <= 0) return "Try again in a bit.";
  if (retryAfter < 90) return "Try again in a minute.";
  return `Try again in about ${Math.round(retryAfter / 60)} minutes.`;
}

export function PageError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof ApiError && error.status === 0) {
    return (
      <PageState
        title="Can't reach the player"
        body="The player core isn't responding. It may still be starting up."
        action={{ label: "Try again", onClick: onRetry }}
      />
    );
  }
  if (error instanceof ApiError && error.rateLimited) {
    return (
      <PageState
        title="YouTube is limiting requests"
        body={`Too many requests went to YouTube in a short time. ${waitHint(error.retryAfter)}`}
        action={{ label: "Try again", onClick: onRetry }}
      />
    );
  }
  if (error instanceof ApiError && error.reauth) {
    return (
      <PageState
        title="Signed out"
        body="Your YouTube Music session expired. Sign in again to see your library."
        action={{ label: "Retry", onClick: onRetry }}
      />
    );
  }
  return (
    <PageState
      title="Something went wrong"
      body={error instanceof Error ? error.message : String(error)}
      action={{ label: "Try again", onClick: onRetry }}
    />
  );
}

/**
 * Mixes generated from the local Play log.
 *
 * Shown above YouTube's own shelves because this is the part the app can do
 * that the service will not: it is built from a complete record of what was
 * actually played, held on this machine.
 */
function MadeForYou({ mixes }: { mixes: Mix[] }) {
  if (mixes.length === 0) return null;

  return (
    <section className="shelf" aria-label="Made for you">
      <div className="shelf__header">
        <h2 className="shelf__title">Made for you</h2>
        <span className="shelf__showall">FROM YOUR LISTENING</span>
      </div>
      <div
        className="shelf__row shelf__row--mixes"
      >
        {mixes.map((mix) => (
          // Opens the mix; only the play button plays it, as with an album.
          <div key={mix.id} className="card mixcard" title={mix.description}>
            <div className="card__artwrap">
              {/* Mosaic of the first four covers, so a generated mix reads as
                  a collection rather than borrowing one track's artwork. */}
              <div className="mixcard__mosaic">
                {mix.tracks.slice(0, 4).map((t, i) => (
                  <img
                    key={`${t.id}:${i}`}
                    src={artworkAtLeast(t.artwork, 160)}
                    alt=""
                    loading="lazy"
                    // A cover that fails leaves the tile's own background,
                    // not a broken-image icon.
                    onError={(e) => {
                      const img = e.currentTarget;
                      // Not every video has the bar-free frame; the standard
                      // thumbnail is next best.
                      if (img.src.includes("/hq720.jpg")) img.src = img.src.replace("/hq720.jpg", "/hqdefault.jpg");
                      else img.style.visibility = "hidden";
                    }}
                  />
                ))}
              </div>
              {mix.tracks.length > 0 ? (
                <button
                  className="card__play"
                  type="button"
                  aria-label={`Play ${mix.title}`}
                  onClick={() => transport.play(mix.tracks, 0, mix.title)}
                >
                  <span className="playbtn playbtn--accent" aria-hidden="true">
                    <IconPlay size={18} />
                  </span>
                </button>
              ) : null}
            </div>
            <div className="card__meta">
              <Link className="card__link truncate" to={`/mix/${encodeURIComponent(mix.id)}`}>
                {mix.title}
              </Link>
              <div className="card__sub">{mix.description}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
