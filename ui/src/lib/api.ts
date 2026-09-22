import type {
  Podcast,
  Track,
  Album, Artist, BrowsePage, Health, LibraryItem, Me, Playlist, SearchResults,
} from "./types";

/**
 * The Go core is reached at the same origin in the packaged app, and through
 * Vite's proxy in development, so no code path differs between the two.
 */
import { API_BASE } from "./base";

const BASE = API_BASE;

/** A failure the UI can act on, rather than a bare string. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Only a confirmed logged-out session sets this — never a network fault. */
    readonly reauth = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { signal });
  } catch (cause) {
    // Distinguish "we could not reach the core" from "the core said no": the
    // UI shows an offline state for one and an error for the other.
    throw new ApiError("offline", 0);
  }
  if (!res.ok) {
    let message = res.statusText;
    let reauth = false;
    try {
      const body = await res.json();
      message = body.error ?? message;
      reauth = Boolean(body.reauth);
    } catch {
      /* non-JSON error body; keep the status text */
    }
    throw new ApiError(message, res.status, reauth);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: (signal?: AbortSignal) => get<Health>("/health", signal),
  me: (signal?: AbortSignal) => get<Me>("/me", signal),

  home: (signal?: AbortSignal) => get<BrowsePage>("/home", signal),
  browse: (surface: string, signal?: AbortSignal, params?: string) =>
    get<BrowsePage>(
      `/browse/${encodeURIComponent(surface)}${params ? `?params=${encodeURIComponent(params)}` : ""}`,
      signal,
    ),

  search: (query: string, filter = "", signal?: AbortSignal) =>
    get<SearchResults>(
      `/search?q=${encodeURIComponent(query)}${filter ? `&filter=${filter}` : ""}`,
      signal,
    ),
  suggest: (prefix: string, signal?: AbortSignal) =>
    get<string[]>(`/suggest?q=${encodeURIComponent(prefix)}`, signal),

  album: (id: string, signal?: AbortSignal) =>
    get<Album>(`/albums/${encodeURIComponent(id)}`, signal),
  artist: (id: string, signal?: AbortSignal) =>
    get<Artist>(`/artists/${encodeURIComponent(id)}`, signal),
  playlist: (id: string, signal?: AbortSignal) =>
    get<Playlist>(`/playlists/${encodeURIComponent(id)}`, signal),

  library: (filter = "", sort = "alphabetical", signal?: AbortSignal) =>
    get<LibraryItem[]>(`/me/library?filter=${filter}&sort=${sort}`, signal),
  liked: (signal?: AbortSignal) => get<Playlist>("/me/liked", signal),

  podcast: (id: string, signal?: AbortSignal) =>
    get<Podcast>(`/podcasts/${encodeURIComponent(id)}`, signal),

  /** The endless queue YouTube generates from a seed track. */
  radio: (trackId: string, signal?: AbortSignal) =>
    get<Track[]>(`/radio/${encodeURIComponent(trackId)}`, signal),
};

/**
 * The in-app route for a browse surface.
 *
 * The mood-and-genre tiles all share one browse ID and differ only in
 * params, so a link that drops params opens the same generic page for every
 * tile. Every link to a tile goes through here for that reason.
 */
export function browsePath(id: string, params?: string): string {
  return `/browse/${encodeURIComponent(id)}${params ? `?params=${encodeURIComponent(params)}` : ""}`;
}
