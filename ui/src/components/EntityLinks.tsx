import { Fragment } from "react";
import { Link } from "react-router-dom";
import type { AlbumRef, ArtistRef } from "../lib/types";

/*
 * Artist and album names that go somewhere.
 *
 * These sit inside rows that play on double-click and open menus on right
 * click, so a click on a name stops there: following a link must not also
 * start the row's track.
 */

/** A library artist arrives wrapped (MPLAUC…); the artist page wants the channel. */
export function artistPath(id: string): string {
  return `/artist/${encodeURIComponent(id.replace(/^MPLA(?=UC)/, ""))}`;
}

export function albumPath(id: string): string {
  return `/album/${encodeURIComponent(id)}`;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function ArtistLinks({
  artists,
  onNavigate,
}: {
  artists: ArtistRef[] | undefined;
  onNavigate?: () => void;
}) {
  const named = (artists ?? []).filter((a) => a.name);
  return (
    <>
      {named.map((a, i) => (
        <Fragment key={`${a.id ?? a.name}-${i}`}>
          {i > 0 ? ", " : null}
          {a.id ? (
            <Link
              className="entitylink"
              to={artistPath(a.id)}
              onClick={(e) => { stop(e); onNavigate?.(); }}
              onDoubleClick={stop}
            >
              {a.name}
            </Link>
          ) : (
            a.name
          )}
        </Fragment>
      ))}
    </>
  );
}

export function AlbumLink({ album, onNavigate }: { album: AlbumRef | undefined; onNavigate?: () => void }) {
  if (!album?.name) return null;
  if (!album.id) return <>{album.name}</>;
  return (
    <Link
      className="entitylink"
      to={albumPath(album.id)}
      onClick={(e) => { stop(e); onNavigate?.(); }}
      onDoubleClick={stop}
    >
      {album.name}
    </Link>
  );
}
