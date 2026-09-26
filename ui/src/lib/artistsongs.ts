/*
 * Ordering an artist's songs by release.
 *
 * The all-songs list YouTube gives an artist is ordered by plays and its rows
 * carry no year, only the album each song is on. So the year is looked up by
 * album: the artist page's own shelves supply most of them, and whatever is
 * left is filled in lazily as the discography loads. A song whose year is
 * still unknown is not guessed at — it goes last, where it is honest about
 * being unplaced.
 */
import type { Album, Track } from "./types";

export type SongOrder = "popular" | "newest" | "album";

/** "1.9B plays" → 1900000000; 0 when the text is not a count. */
export function playCount(text: string | undefined): number {
  const m = /^([\d.,]+)\s*([KMB]?)/.exec((text ?? "").trim());
  if (!m?.[1]) return 0;
  const n = Number(m[1].replace(/,/g, ""));
  const mult = m[2] === "B" ? 1e9 : m[2] === "M" ? 1e6 : m[2] === "K" ? 1e3 : 1;
  return Number.isFinite(n) ? n * mult : 0;
}

/**
 * Most played first, by the counts the rows show. YouTube's own order is not
 * quite that (#48), and a list labelled with counts reads as wrong when it
 * disagrees with them. Left alone when any count is missing.
 */
export function byPlays(tracks: Track[]): Track[] {
  const counts = tracks.map((t) => playCount(t.playCount));
  if (counts.some((c) => c <= 0)) return tracks;
  return tracks
    .map((t, i) => ({ t, i, c: counts[i] ?? 0 }))
    .sort((a, b) => b.c - a.c || a.i - b.i)
    .map((x) => x.t);
}

/** Album id → release year, from every album list at hand. */
export function yearsByAlbum(...lists: (Album[] | undefined)[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of lists) {
    for (const album of list ?? []) {
      const year = Number(album.year);
      if (album.id && Number.isInteger(year) && year > 0 && !out.has(album.id)) out.set(album.id, year);
    }
  }
  return out;
}

/** Albums the songs are on whose year is not known yet, first appearance first. */
export function missingAlbums(tracks: Track[], years: Map<string, number>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tracks) {
    const id = t.album?.id;
    if (id && !years.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Newest first. Songs from the same year keep their order (the most played
 * first); songs with no known year go last, also in their order.
 */
export function newestFirst(tracks: Track[], years: Map<string, number>): Track[] {
  const year = (t: Track) => (t.album?.id ? years.get(t.album.id) ?? 0 : 0);
  return tracks
    .map((t, i) => ({ t, i, y: year(t) }))
    .sort((a, b) => b.y - a.y || a.i - b.i)
    .map((x) => x.t);
}

export interface AlbumGroup {
  /** The album's id; empty for songs on no album. */
  id: string;
  title: string;
  year?: number;
  tracks: Track[];
}

/**
 * The songs grouped album by album, newest album first.
 *
 * Albums of unknown year follow the dated ones, and songs on no album at all
 * come last under one heading. Within an album the songs keep their order.
 */
export function byAlbum(tracks: Track[], years: Map<string, number>): AlbumGroup[] {
  const groups = new Map<string, AlbumGroup & { first: number }>();
  tracks.forEach((t, i) => {
    const id = t.album?.id ?? "";
    let g = groups.get(id);
    if (!g) {
      g = { id, title: id ? t.album?.name || "Unknown album" : "Other songs", year: id ? years.get(id) : undefined, tracks: [], first: i };
      groups.set(id, g);
    }
    g.tracks.push(t);
  });
  const rank = (g: AlbumGroup & { first: number }) => (g.id === "" ? 2 : g.year ? 0 : 1);
  return [...groups.values()]
    .sort((a, b) => rank(a) - rank(b) || (b.year ?? 0) - (a.year ?? 0) || a.first - b.first)
    .map(({ first: _first, ...g }) => g);
}
