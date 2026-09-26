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
  // "0 plays" is a count; only a row with no count leaves the order alone.
  if (tracks.some((t) => !/^\s*\d/.test(t.playCount ?? ""))) return tracks;
  const counts = tracks.map((t) => playCount(t.playCount));
  return tracks
    .map((t, i) => ({ t, i, c: counts[i] ?? 0 }))
    .sort((a, b) => b.c - a.c || a.i - b.i)
    .map((x) => x.t);
}

/** A shuffled copy (Fisher–Yates). `random` is injectable for tests. */
export function shuffled<T>(items: T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const norm = (t: string) => t.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

export interface ArtistIdentity { id: string; name: string }

/** Whether a credit list names the artist: by id, or by name when it has none. */
export function credits(artists: { id?: string; name: string }[] | undefined, who: ArtistIdentity): boolean {
  return (artists ?? []).some((a) => (a.id && who.id ? a.id === who.id : norm(a.name) === norm(who.name)));
}

/*
 * One song across editions, videos and releases: its title. Every song here
 * credits the artist already, and the lead credit is not a safe second key —
 * a single and its album can list the same song's artists differently.
 */
const songKey = (t: Track) => norm(t.title);

/**
 * The songs list completed from the artist's releases.
 *
 * YouTube's list of an artist's songs stops at their most played 150 or so.
 * The rest are on the releases themselves, so their tracks are added after
 * it — only those that credit the artist, since a compilation, soundtrack or
 * someone else's album they feature on is mostly other people's songs.
 *
 * Each song appears once: a second video of it, or its copy on another
 * edition, single or compilation, is dropped — from the list too, which
 * carries a song once per release it is on. The first, most played, stays.
 */
export function withReleases(tracks: Track[], releases: Album[], who: ArtistIdentity): Track[] {
  const ids = new Set<string>();
  const songs = new Map<string, number>();
  const out: Track[] = [];
  const onCompilation = (t: Track) => isCompilation(t.album?.name ?? "");
  for (const t of tracks) {
    const key = songKey(t);
    const at = songs.get(key);
    if (at !== undefined) {
      // The copy on the album it came from, not on a greatest-hits, is the
      // one the album view should place — in the better-played one's slot.
      if (onCompilation(out[at]!) && !onCompilation(t)) out[at] = t;
      continue;
    }
    if (ids.has(t.id)) continue;
    ids.add(t.id);
    songs.set(key, out.length);
    out.push(t);
  }
  for (const release of releases) {
    for (const t of release.tracks ?? []) {
      const artists = t.artists?.length ? t.artists : release.artists;
      if (!credits(artists, who)) continue;
      const song = { ...t, artists, album: t.album?.id ? t.album : { id: release.id, name: release.title } };
      const key = songKey(song);
      if (ids.has(t.id) || songs.has(key)) continue;
      ids.add(t.id);
      songs.set(key, out.length);
      out.push(song);
    }
  }
  return out;
}

// What editions add to a release's name: "(Deluxe)", "[Remastered 2011]",
// "(10th Anniversary Edition)", "- Expanded Edition".
const EDITION =
  /\s*(?:[([][^)\]]*\b(?:deluxe|edition|expanded|remaster(?:ed)?|anniversary|bonus|complete|special|super|version|alternate|original motion picture)\b[^)\]]*[)\]]|-\s*(?:deluxe|expanded|remastered|special)\b.*)\s*$/i;

/** A release's name without its edition, for putting editions together. */
export function editionTitle(title: string): string {
  let t = title;
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(EDITION, "");
  }
  return t.trim() || title.trim();
}

export interface Release { id: string; title: string; year?: number }

/**
 * Every edition mapped to the one that stands for it: the earliest, or the
 * plainest-named of those from the same year. The deluxe edition's bonus
 * songs then sit with the album they extend, under its name and year.
 */
export function editions(albums: Album[]): Map<string, Release> {
  const byKey = new Map<string, Album[]>();
  for (const a of albums) {
    if (!a.id) continue;
    const key = norm(editionTitle(a.title));
    byKey.set(key, [...(byKey.get(key) ?? []), a]);
  }
  const out = new Map<string, Release>();
  for (const list of byKey.values()) {
    const year = (a: Album) => Number(a.year) || Infinity;
    const main = [...list].sort((a, b) => year(a) - year(b) || a.title.length - b.title.length)[0]!;
    const release = { id: main.id, title: editionTitle(main.title), year: Number(main.year) || undefined };
    for (const a of list) out.set(a.id, release);
  }
  return out;
}

// Releases that are mostly other people's songs, or the artist's again.
const COMPILATION = /\b(greatest hits|best of|the best|the highlights|collection|anthology|essentials|en iyileri|karaoke|tribute|various artists|compilation)\b/i;

/** Whether a release's title says it gathers songs rather than releasing them. */
export function isCompilation(title: string): boolean {
  // Without accents, so "En İyileri" reads as "en iyileri".
  return COMPILATION.test(title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
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

/** The year a song counts as from, through the release that stands for its edition. */
function yearOf(t: Track, years: Map<string, number>, canon?: Map<string, Release>): number {
  const id = t.album?.id;
  if (!id) return 0;
  return canon?.get(id)?.year ?? years.get(id) ?? 0;
}

/**
 * Newest first. Songs from the same year keep their order (the most played
 * first); songs with no known year go last, also in their order.
 */
export function newestFirst(tracks: Track[], years: Map<string, number>, canon?: Map<string, Release>): Track[] {
  return tracks
    .map((t, i) => ({ t, i, y: yearOf(t, years, canon) }))
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
 * The songs grouped album by album, newest album first, the editions of one
 * release together under it.
 *
 * Albums of unknown year follow the dated ones, and songs on no album at all
 * come last under one heading. Within an album the songs keep their order.
 */
export function byAlbum(tracks: Track[], years: Map<string, number>, canon?: Map<string, Release>): AlbumGroup[] {
  const groups = new Map<string, AlbumGroup & { first: number }>();
  tracks.forEach((t, i) => {
    const release = t.album?.id ? canon?.get(t.album.id) : undefined;
    const id = release?.id ?? t.album?.id ?? "";
    let g = groups.get(id);
    if (!g) {
      const year = id ? yearOf(t, years, canon) || undefined : undefined;
      g = { id, title: id ? release?.title || t.album?.name || "Unknown album" : "Other songs", year, tracks: [], first: i };
      groups.set(id, g);
    }
    g.tracks.push(t);
  });
  const rank = (g: AlbumGroup & { first: number }) => (g.id === "" ? 2 : g.year ? 0 : 1);
  return [...groups.values()]
    .sort((a, b) => rank(a) - rank(b) || (b.year ?? 0) - (a.year ?? 0) || a.first - b.first)
    .map(({ first: _first, ...g }) => g);
}

export interface ReleasePlan {
  /** Every release worth opening, most useful first. */
  order: string[];
  /** Of those, singles whose song is already known: opened last, if at all. */
  covered: Set<string>;
}

/**
 * The order to open an artist's releases in, for the dated orders.
 *
 * First the releases listed songs are on whose year nothing else gives, so
 * the list itself can be placed. Then the artist's albums and EPs, which hold
 * most of the songs the list lacks. Then singles, except those whose song is
 * already known — from the list or an opened album — which go last: a single
 * is usually one song, and opening it would only repeat what is there.
 * Compilations are left out; their songs are on the releases they came from.
 *
 * `known` is the songs found so far, so the plan sharpens as albums open.
 */
export function releasePlan(
  undatedListed: string[],
  albums: Album[],
  singles: Album[],
  known: Track[],
): ReleasePlan {
  const songs = new Set(known.map(songKey));
  const own = (list: Album[]) => list.filter((a) => a.id && !isCompilation(a.title));
  const open: string[] = [];
  const last: string[] = [];
  for (const s of own(singles)) (songs.has(norm(s.title)) ? last : open).push(s.id);
  const order = [...new Set([...undatedListed, ...own(albums).map((a) => a.id), ...open, ...last])];
  const early = new Set([...undatedListed, ...own(albums).map((a) => a.id), ...open]);
  return { order, covered: new Set(last.filter((id) => !early.has(id))) };
}
