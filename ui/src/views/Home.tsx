import { useQuery } from "@tanstack/react-query";
import { useMixes, type Mix } from "../lib/mixes";
import { transport } from "../lib/playback";
import { artworkAtLeast } from "../lib/types";
import { IconPlay } from "../components/Icon";
import { Link } from "react-router-dom";
import { api, ApiError, browsePath } from "../lib/api";
import { Shelf } from "../components/Shelf";
import { PageState, ShelfSkeleton } from "../components/States";
import type { BrowsePage } from "../lib/types";

/**
 * Home.
 *
 * The chip row re-seeds the page by mood rather than filtering it by content
 * type: YouTube Music supplies mood-and-genre grids and no meaningful type
 * split, so the chips do the more useful of the two jobs.
 */

export function Home() {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["home"],
    queryFn: ({ signal }) => api.home(signal),
  });

  /**
   * Mixes built from this machine's listening history. They are absent until
   * there is enough history to seed them, which is a normal early state rather
   * than a failure — so a miss renders nothing instead of an error.
   */
  const mixes = useMixes();

  if (isPending) return <HomeSkeleton />;
  if (error) return <PageError error={error} onRetry={() => void refetch()} />;
  if (!data || (data.shelves.length === 0 && !data.moods?.length)) {
    return (
      <PageState
        title="Nothing to show yet"
        body="Listen to a few things and recommendations will appear here."
      />
    );
  }

  return (
    <>
      <MadeForYou mixes={mixes.data ?? []} />
      <BrowseContent page={data} />
    </>
  );
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
