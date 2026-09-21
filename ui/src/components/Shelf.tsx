import { useEffect, useRef, useState } from "react";
import { warmOnHover } from "../lib/warm";
import { Link } from "react-router-dom";
import type { Shelf as ShelfData, ShelfItem } from "../lib/types";
import { artistNames, artworkAtLeast } from "../lib/types";
import { playEntity, transport } from "../lib/playback";
import { useShelfItemFilter } from "../lib/videos";
import { useMenu } from "./ContextMenu";
import { useCardMenu } from "../lib/cardmenu";
import { IconPlay } from "./Icon";

const CARD_MIN = 168;
const GAP = 16;

/**
 * Measures its own width and shows a whole number of cards.
 *
 * A partial card at the edge reads as broken layout rather than as "there is
 * more". Measuring the container rather than the viewport matters because the
 * sidebar is user-resizable, so the available width changes without the window
 * changing.
 */
function useCardCount(ref: React.RefObject<HTMLElement>): number {
  const [count, setCount] = useState(5);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width <= 0) return;
      const fits = Math.floor((width + GAP) / (CARD_MIN + GAP));
      setCount(Math.min(8, Math.max(2, fits)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return count;
}

/**
 * A titled row of cards, or the whole set on the page it links to.
 *
 * A row shows a whole number of cards and hides the rest behind "Show all".
 * That page is the rest — so it wraps instead of clipping, and it does not
 * repeat a heading the page has already printed above it.
 */
export function Shelf({
  shelf,
  layout = "row",
  heading = true,
}: {
  shelf: ShelfData;
  layout?: "row" | "grid";
  heading?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const count = useCardCount(ref);
  const filterItems = useShelfItemFilter();

  const items = filterItems(shelf.items ?? []);
  if (items.length === 0) return null;

  const grid = layout === "grid";
  const shown = grid ? items : items.slice(0, count);

  return (
    <section className="shelf" aria-label={shelf.title}>
      {heading ? (
        <div className="shelf__header">
          <h2 className="shelf__title">{shelf.title}</h2>
          {shelf.showAllId ? (
            <Link className="shelf__showall" to={`/browse/${encodeURIComponent(shelf.showAllId)}`}>
              Show all
            </Link>
          ) : null}
        </div>
      ) : null}
      <div
        ref={ref}
        className={grid ? "shelf__grid" : "shelf__row"}
        style={grid ? undefined : ({ "--card-count": count } as React.CSSProperties)}
      >
        {shown.map((item, i) => (
          <Card key={itemKey(item, i)} item={item} context={shelf} />
        ))}
      </div>
    </section>
  );
}

/**
 * A shelf card.
 *
 * A track card plays; an album, artist or playlist card opens. That split is
 * not cosmetic — a track has no page to open, and sending one to /track/:id
 * is how every song on Home reached the not-found screen.
 *
 * On the cards that do open, the play overlay plays rather than following the
 * link, because a control drawn as a play button that silently navigates is
 * the same bug wearing a different icon.
 */
// context is the shelf a card sits in; a song card no longer plays it (it
// starts its radio), but callers still say where the card is.
export function Card({ item }: { item: ShelfItem; context?: ShelfData }) {
  const menu = useMenu();
  const cardMenu = useCardMenu();
  const cancelWarm = useRef<(() => void) | null>(null);
  const view = describe(item);
  if (!view) return null;

  const art = (
    <img
      className={`card__art ${view.round ? "card__art--round" : ""}`}
      src={view.art}
      alt=""
      loading="lazy"
    />
  );

  // A track has no page to open, so the whole card is the play control.
  // Sending one to /track/:id is how every song on Home reached not-found.
  if (view.play) {
    const play = view.play;
    return (
      <button
        className="card"
        type="button"
        onClick={play}
        aria-label={`Play ${view.title}`}
        onContextMenu={(e) => menu.open(e, cardMenu(item))}
        // The whole card is the play control, so hovering it is as good a
        // signal as hovering a play button: resolve now rather than on click.
        onMouseEnter={() => { cancelWarm.current = warmOnHover(item.track?.id); }}
        onMouseLeave={() => { cancelWarm.current?.(); }}
      >
        <div className="card__artwrap">
          {art}
          <span className="card__play" aria-hidden="true">
            <span className="playbtn playbtn--accent">
              <IconPlay size={18} />
            </span>
          </span>
        </div>
        <div className="card__meta">
          <div className="card__title truncate">{view.title}</div>
          {view.subtitle ? <div className="card__sub truncate">{view.subtitle}</div> : null}
        </div>
      </button>
    );
  }

  // Everything else opens, and its overlay plays. The link is stretched over
  // the card rather than wrapping it, so the play button can sit above the
  // link instead of nested inside it — a button inside an anchor is invalid
  // markup and gives the keyboard two conflicting targets.
  const open = view.playEntity;
  return (
    <div className="card" onContextMenu={(e) => menu.open(e, cardMenu(item))}>
      <div className="card__artwrap">
        {art}
        {open ? (
          <button
            className="card__play"
            type="button"
            aria-label={`Play ${view.title}`}
            onClick={() => void open()}
          >
            <span className="playbtn playbtn--accent" aria-hidden="true">
              <IconPlay size={18} />
            </span>
          </button>
        ) : null}
      </div>
      <div className="card__meta">
        <Link className="card__link truncate" to={view.href}>
          {view.title}
        </Link>
        {view.subtitle ? <div className="card__sub truncate">{view.subtitle}</div> : null}
      </div>
    </div>
  );
}

interface CardView {
  title: string;
  subtitle: string;
  art?: string;
  href: string;
  round: boolean;
  /** Set when the card itself plays, which is the case for a track. */
  play?: () => void;
  /** Set when the card opens but its overlay button plays. */
  playEntity?: () => Promise<boolean>;
}

function describe(item: ShelfItem): CardView | null {
  switch (item.kind) {
    case "album": {
      if (!item.album) return null;
      const album = item.album;
      return {
        title: item.album.title,
        subtitle: artistNames(item.album.artists) || item.album.year || "Album",
        art: artworkAtLeast(item.album.artwork, 300),
        href: `/album/${encodeURIComponent(item.album.id)}`,
        round: false,
        playEntity: () => playEntity("album", album.id, album.title),
      };
    }
    case "artist": {
      if (!item.artist) return null;
      const artist = item.artist;
      return {
        title: item.artist.name,
        subtitle: item.artist.subscribers || "Artist",
        art: artworkAtLeast(item.artist.artwork, 300),
        href: `/artist/${encodeURIComponent(item.artist.id)}`,
        round: true,
        playEntity: () => playEntity("artist", artist.id, artist.name),
      };
    }
    case "playlist": {
      if (!item.playlist) return null;
      const playlist = item.playlist;
      return {
        title: item.playlist.title,
        subtitle: item.playlist.description || "Playlist",
        art: artworkAtLeast(item.playlist.artwork, 300),
        href: `/playlist/${encodeURIComponent(item.playlist.id)}`,
        round: false,
        playEntity: () => playEntity("playlist", playlist.id, playlist.title),
      };
    }
    case "podcast": {
      if (!item.podcast) return null;
      const show = item.podcast;
      return {
        title: show.title,
        subtitle: show.author || "Podcast",
        art: artworkAtLeast(show.artwork, 300),
        href: `/podcast/${encodeURIComponent(show.id)}`,
        round: false,
      };
    }

    case "episode": {
      if (!item.episode) return null;
      const ep = item.episode;
      // An episode plays like a track, so its card is a play control too.
      return {
        title: ep.title,
        subtitle: [ep.publishedText, ep.podcast?.title].filter(Boolean).join(" · "),
        art: artworkAtLeast(ep.artwork, 300),
        href: "",
        round: false,
        play: () => transport.play([ep], 0, ep.podcast?.title ?? ep.title),
      };
    }

    case "track": {
      if (!item.track) return null;
      const track = item.track;
      return {
        title: track.title,
        subtitle: artistNames(track.artists),
        art: artworkAtLeast(track.artwork, 300),
        href: "",
        round: false,
        // A song picked from a shelf starts its radio, as YouTube Music does.
        play: () => transport.playRadio(track),
      };
    }
    default:
      return null;
  }
}

function itemKey(item: ShelfItem, index: number): string {
  const id =
    item.track?.id ?? item.album?.id ?? item.artist?.id ?? item.playlist?.id ?? String(index);
  return `${item.kind}:${id}`;
}
