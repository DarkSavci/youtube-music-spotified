import type {
  Podcast,
  Track,
  Album, Artist, BrowsePage, Health, LibraryItem, Me, MixSeed, Playlist, RemoteQueue,
  SearchHistoryEntry, SearchResults,
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
    /** From a 429's Retry-After, in seconds, when the core sent one. */
    readonly retryAfter = 0,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** YouTube (through the core) is limiting requests. */
  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/*
 * Whether a failed query is worth another try.
 *
 * Every retry is another request to YouTube, and the failures that matter
 * most are the ones a retry makes worse: a 429 means "slow down", and a 5xx
 * from the core is almost always YouTube refusing or failing upstream. Those,
 * and a signed-out session, are never retried; anything else gets one more go.
 */
export function shouldRetry(count: number, err: unknown, max = 1): boolean {
  if (err instanceof ApiError && (err.reauth || err.status === 429 || err.status >= 500)) return false;
  return count < max;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await request(path, { signal });
  return res.json() as Promise<T>;
}

/** Posts JSON to the core; the answer's body, if any, is not read. */
async function post(path: string, body: unknown): Promise<void> {
  await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function request(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch (cause) {
    // Distinguish "we could not reach the core" from "the core said no": the
    // UI shows an offline state for one and an error for the other.
    throw new ApiError("offline", 0);
  }
  if (!res.ok) {
    let message = res.statusText;
    let reauth = false;
    let bodyRetryAfter = 0;
    try {
      const body = await res.json();
      message = body.error ?? message;
      reauth = Boolean(body.reauth);
      bodyRetryAfter = Number(body.retryAfter) || 0;
    } catch {
      /* non-JSON error body; keep the status text */
    }
    // The header when the browser lets us read it, else the core's body field.
    const retryAfter = Number(res.headers.get("Retry-After")) || bodyRetryAfter;
    throw new ApiError(message, res.status, reauth, retryAfter);
  }
  return res;
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

  playlistPage: (id: string, continuation = "", signal?: AbortSignal) =>
    get<{ playlist: Playlist; next?: string }>(`/playlists/${encodeURIComponent(id)}?paged=1${continuation ? `&continuation=${encodeURIComponent(continuation)}` : ""}`, signal),

  library: (filter = "", sort = "alphabetical", signal?: AbortSignal) =>
    get<LibraryItem[]>(`/me/library?filter=${filter}&sort=${sort}`, signal),
  liked: (signal?: AbortSignal) => get<Playlist>("/me/liked", signal),

  /** The account's own past searches, most recent first; empty signed out. */
  searchHistory: (signal?: AbortSignal) => get<SearchHistoryEntry[]>("/me/search-history", signal),
  /** Removes past searches from the account, by the tokens they carried. */
  forgetSearches: (tokens: string[]) => post("/me/search-history/forget", { tokens }),
  /** The queue the account has on its other devices; empty signed out. */
  remoteQueue: (signal?: AbortSignal) => get<RemoteQueue>("/me/remote-queue", signal),

  podcast: (id: string, signal?: AbortSignal) =>
    get<Podcast>(`/podcasts/${encodeURIComponent(id)}`, signal),

  /** The endless queue YouTube generates from a seed track. */
  radio: (trackId: string, signal?: AbortSignal) =>
    get<Track[]>(`/radio/${encodeURIComponent(trackId)}`, signal),
  /** The first page of a named radio (an artist's mix or shuffle) starting at `seed`. */
  mix: (mix: MixSeed, signal?: AbortSignal) =>
    get<Track[]>(
      `/radio/${encodeURIComponent(mix.videoId)}?list=${encodeURIComponent(mix.playlistId)}${mix.params ? `&params=${encodeURIComponent(mix.params)}` : ""}`,
      signal,
    ),
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
