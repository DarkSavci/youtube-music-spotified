/*
 * Mirrors internal/domain. Hand-written for now; generated from the Go structs
 * in a later step so drift becomes a CI failure rather than a runtime surprise.
 */

export interface Artwork { url: string; width: number; height: number }
export interface ArtistRef { id?: string; name: string }
export interface AlbumRef { id?: string; name: string }

export interface Track {
  id: string;
  title: string;
  artists: ArtistRef[];
  album?: AlbumRef;
  durationMs: number;
  artwork: Artwork[];
  explicit: boolean;
  isVideo: boolean;
  playable: boolean;
  playCount?: string;
  /** Time spent listening to this track, from the local play log. Only the
   *  listening page sets it; a table shows the column when a row has it. */
  listenedMs?: number;
  playlistItemId?: string;
  addedAt?: string;
}

export interface Album {
  id: string; title: string; artists: ArtistRef[];
  year?: string; trackCount: number; durationMs?: number;
  artwork: Artwork[]; dominantColor?: string;
  description?: string; explicit: boolean; tracks?: Track[];
}

export interface Artist {
  id: string; name: string; artwork: Artwork[]; dominantColor?: string;
  description?: string; descriptionUrl?: string;
  subscribers?: string;
  /** Whether the signed-in account already follows this artist. */
  following?: boolean; monthlyListeners?: string;
  radioId?: string; shuffleId?: string;
  topTracks?: Track[]; albums?: Album[]; singles?: Album[]; related?: Artist[];
}

export interface Playlist {
  id: string; title: string; description?: string;
  owner?: string; ownerId?: string;
  trackCount: number; durationMs?: number;
  artwork: Artwork[]; dominantColor?: string;
  collaborative: boolean; editable: boolean; tracks?: Track[];
}

export type ShelfItemKind =
  | "track" | "album" | "artist" | "playlist" | "podcast" | "episode";

export interface ShelfItem {
  kind: ShelfItemKind;
  track?: Track; album?: Album; artist?: Artist; playlist?: Playlist;
  podcast?: Podcast; episode?: Episode;
}

export interface Shelf {
  title: string; items: ShelfItem[];
  showAllId?: string; showAllParams?: string; continuation?: string;
}

export interface MoodChip { id: string; params?: string; title: string; color?: string }

export interface BrowsePage {
  title?: string; shelves: Shelf[]; moods?: MoodChip[]; continuation?: string;
}

export interface SearchResults {
  query: string; topResult?: ShelfItem; shelves: Shelf[]; continuation?: string;
  /** What YouTube shows inside the top result's card. */
  topResultItems?: ShelfItem[];
}

export type LibraryItemKind = "playlist" | "album" | "artist" | "podcast";

export interface LibraryItem {
  id: string; kind: LibraryItemKind; title: string; subtitle?: string;
  artwork: Artwork[]; dominantColor?: string;
  addedAt?: string; folderId?: string; pinned: boolean; lastPlayedAt?: string;
}

export type SessionState = "signed_in" | "logged_out" | "unknown";

export interface Account { name: string; handle?: string; avatarUrl?: string }
export interface Me { state: SessionState; account?: Account }

export interface Health {
  ok: boolean; uptime: string; haveCredentials: boolean;
  unknownNodes: { surface: string; type: string; count: number }[];
}

/**
 * Smallest artwork at least `min` wide.
 *
 * When none is that big, the largest is asked for at the size wanted. A song
 * in the queue carries covers of only 60 and 120 pixels, which the full-screen
 * player then stretched across half the screen. Google's image servers resize
 * on request, by the size in the URL's suffix ("=w120-h120-l90-rj",
 * "=s88-c-k"), up to the original (1440 pixels for the covers measured), so
 * the same image is simply fetched larger. Other URLs are returned as they
 * are; the size wanted is scaled by the screen's pixel density, as an <img>
 * is drawn in device pixels.
 */
export function artworkAtLeast(set: Artwork[] | undefined, min: number): string | undefined {
  if (!set || set.length === 0) return undefined;
  for (const a of set) if (a.width >= min) return a.url;
  const largest = set[set.length - 1];
  if (!largest) return undefined;
  const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
  return resizedArtwork(largest.url, Math.min(2048, Math.ceil(min * dpr))) ?? largest.url;
}

const RESIZABLE_HOST = /^https:\/\/(?:lh\d+\.googleusercontent\.com|yt\d*\.googleusercontent\.com|yt\d*\.ggpht\.com)\//;

/** The same Google-hosted image at `size` pixels, or null for any other URL. */
export function resizedArtwork(url: string, size: number): string | null {
  if (!RESIZABLE_HOST.test(url)) return null;
  const eq = url.lastIndexOf("=");
  if (eq < 0) return null;
  const suffix = url.slice(eq + 1);
  let next = suffix.replace(/\bw\d+-h\d+\b/, `w${size}-h${size}`);
  if (next === suffix) next = suffix.replace(/^s\d+\b/, `s${size}`);
  if (next === suffix) return null;
  return url.slice(0, eq + 1) + next;
}

/** "3:45" / "1:07:10" from milliseconds. */
export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return "--:--";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "Artist A, Artist B" */
export function artistNames(artists: ArtistRef[] | undefined): string {
  return (artists ?? []).map((a) => a.name).filter(Boolean).join(", ");
}


/** A podcast show. */
export interface Podcast {
  id: string;
  title: string;
  author?: string;
  authorId?: string;
  description?: string;
  artwork: Artwork[];
  episodes: Episode[];
}

/**
 * One instalment of a show.
 *
 * An Episode is a Track with a publication date and a show attached: it plays
 * through exactly the same path, because upstream it is a video like any
 * other.
 */
export interface Episode extends Track {
  publishedText?: string;
  podcast?: { id?: string; title?: string };
}
