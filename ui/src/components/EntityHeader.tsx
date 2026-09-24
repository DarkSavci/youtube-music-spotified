import { useEffect, useRef } from "react";
import type { Artwork } from "../lib/types";
import { artworkAtLeast } from "../lib/types";
import { useArtColor } from "../lib/artcolor";

interface Props {
  kind: string;
  title: string;
  artwork?: Artwork[];
  /** Extracted server-side and shipped with the entity, so the gradient is
   *  correct on first paint rather than flashing a neutral colour. */
  dominantColor?: string;
  meta?: React.ReactNode;
  round?: boolean;
}

/**
 * The large header on an entity page, with a gradient derived from the
 * artwork.
 *
 * The colour is extracted here from the artwork.
 *
 * It was meant to arrive from Go, on the belief that a cross-origin image
 * could not be read back in the browser. Nothing ever sent it, so every header
 * used the fallback grey — and the belief was wrong anyway: the artwork hosts
 * all send `Access-Control-Allow-Origin: *`, so a crossOrigin image reads back
 * from a canvas without tainting it.
 *
 * A caller may still pass `dominantColor` to override what is extracted.
 */
export function EntityHeader({ kind, title, artwork, dominantColor, meta, round }: Props) {
  const headerRef = useRef<HTMLElement>(null);
  const extracted = useArtColor(artworkAtLeast(artwork ?? [], 300));
  const color = dominantColor || extracted;

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--extracted-color", color);
    return () => {
      root.style.removeProperty("--extracted-color");
    };
  }, [color]);

  useEffect(() => {
    const header = headerRef.current;
    const scroll = header?.closest<HTMLElement>(".main__scroll");
    if (!header || !scroll) return;
    const observer = new IntersectionObserver(([entry]) => {
      scroll.dataset.entityScrolled = String(!entry?.isIntersecting);
    }, { root: scroll });
    observer.observe(header);
    return () => { observer.disconnect(); delete scroll.dataset.entityScrolled; };
  }, []);

  return (
    <header ref={headerRef} className="entityheader">
      {artwork && artwork.length > 0 ? (
        <img
          className={`entityheader__art ${round ? "entityheader__art--round" : ""}`}
          src={artworkAtLeast(artwork, 400)}
          alt=""
        />
      ) : null}
      <div className="entityheader__text">
        <span className="entityheader__kind">{kind}</span>
        <h1 className="entityheader__title">{title}</h1>
        {meta ? <div className="entityheader__meta">{meta}</div> : null}
      </div>
    </header>
  );
}
