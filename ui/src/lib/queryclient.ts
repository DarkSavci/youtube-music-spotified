import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { api, shouldRetry } from "./api";
import type { Playlist, Track } from "./types";

/*
 * The app's one query cache, shared by the views and by code outside React
 * (playing a card, playing an artist) so both read the same data instead of
 * each asking YouTube for it.
 *
 * Every query is, one way or another, a request to YouTube, and YouTube
 * answers too many of them with 429s. So data is trusted for five minutes and
 * kept for an hour after its last viewer goes, a returning connection does not
 * refetch everything on screen, and failures YouTube caused are not retried
 * (see shouldRetry).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      gcTime: 60 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: (count, err) => shouldRetry(count, err),
    },
  },
});

type PlaylistPage = { playlist: Playlist; next?: string };

/** The key the playlist page and the artist Songs page page through. */
export const playlistPagesKey = (id: string) => ["playlist", id, "pages"] as const;

/*
 * A whole playlist, continuing from the pages already loaded.
 *
 * The playlist page loads a hundred songs at a time as it scrolls; playing it
 * needs all of them. Rather than reading the whole list again from the first
 * page, this picks up where the loaded pages stop and adds what it fetches to
 * the same cache, so the page shows them too.
 */
export async function completePlaylist(id: string, signal?: AbortSignal): Promise<Track[]> {
  const key = playlistPagesKey(id);
  const cached = queryClient.getQueryData<InfiniteData<PlaylistPage, string>>(key);
  const pages = cached ? [...cached.pages] : [await api.playlistPage(id, "", signal)];
  const params = cached ? [...cached.pageParams] : [""];
  const seen = new Set(pages.map((p) => p.next).filter(Boolean));
  // The same bound the core uses for a whole playlist.
  for (let guard = 0; guard < 60; guard++) {
    const cursor = pages.at(-1)?.next;
    if (!cursor) break;
    const page = await api.playlistPage(id, cursor, signal);
    // A repeated cursor would loop forever; the list ends there.
    const next = page.next && !seen.has(page.next) ? page.next : undefined;
    if (next) seen.add(next);
    pages.push({ ...page, next });
    params.push(cursor);
  }
  queryClient.setQueryData<InfiniteData<PlaylistPage, string>>(key, { pages, pageParams: params });
  return pages.flatMap((p) => p.playlist.tracks ?? []);
}
