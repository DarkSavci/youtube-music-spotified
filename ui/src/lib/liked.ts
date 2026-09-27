import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, shouldRetry } from "./api";
import { apiUrl } from "./base";
import type { Track } from "./types";

/**
 * Whether a Track is in Liked Music, and how to change that.
 *
 * Membership comes from the Liked Music playlist rather than from a flag on
 * the Track, because YouTube does not put one there. That makes the answer
 * true rather than remembered: a like made on a phone shows up here, and a
 * like made here survives a reload.
 *
 * The playlist is fetched once and cached for the session. It is a few hundred
 * rows, which is far cheaper than being wrong about whether a heart is filled.
 */
export function useLikedIds(): Set<string> {
  const { data } = useQuery({
    queryKey: ["liked"],
    queryFn: ({ signal }) => api.liked(signal),
    // Fetched once. Likes made here change the cached list directly (see
    // setLiked), so it never needs refetching to stay right; a like made on a
    // phone shows after the next launch. Reading the whole list is up to 61
    // requests to YouTube, which is what refetching it every five minutes
    // and after every like used to cost.
    staleTime: Infinity,
    refetchOnMount: false,
    // Nor is a failed read tried again each time something that shows hearts
    // mounts: with a list that fails every time (YouTube's Liked Music page
    // not parsing, a rate limit), that was a burst of requests per page view.
    // The next launch, or a like, tries again.
    retryOnMount: false,
    // A failure YouTube caused (a 429, a response that did not parse) is not
    // retried: it fails the same way again, one request per page each time.
    retry: (count, err) => shouldRetry(count, err),
  });
  return new Set((data?.tracks ?? []).map((t) => t.id));
}

/*
 * Liking a track shows at once.
 *
 * The heart used to wait for the round trip — and was disabled meanwhile —
 * so a click looked ignored for a second. The cached Liked Music list is
 * changed straight away and put back if the request fails; the refetch
 * afterwards makes the playlist the source of truth again either way.
 */
type LikedList = { tracks?: Track[] } | undefined;

/**
 * Likes or unlikes a track, changing the cached Liked Music list at once and
 * putting it back if YouTube refuses. Nothing is refetched: the cached list
 * is right either way, and refetching it is up to 61 requests. Pages already
 * showing Liked Music, and the library's count, are marked stale so they
 * catch up the next time they are opened rather than now.
 */
export async function setLiked(qc: QueryClient, track: Track | { id: string }, liked: boolean): Promise<void> {
  await qc.cancelQueries({ queryKey: ["liked"] });
  const before = qc.getQueryData<LikedList>(["liked"]);
  // With no list loaded (it failed to), there is nothing to change: a list of
  // just this track would pass for the whole of Liked Music. It is read again
  // after the like instead.
  if (before) {
    qc.setQueryData<LikedList>(["liked"], (old) => {
      const tracks = (old?.tracks ?? []).filter((t) => t.id !== track.id);
      return { ...(old ?? {}), tracks: liked ? [track as Track, ...tracks] : tracks };
    });
  }
  try {
    const res = await fetch(apiUrl(`/v1/me/tracks/${encodeURIComponent(track.id)}/rating`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // "none" clears a like; there is no separate unlike.
      body: JSON.stringify({ rating: liked ? "like" : "none" }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    if (before) qc.setQueryData(["liked"], before);
    throw err;
  }
  if (!before) void qc.invalidateQueries({ queryKey: ["liked"] });
  void qc.invalidateQueries({ queryKey: ["playlist", "LM"], refetchType: "none" });
  void qc.invalidateQueries({ queryKey: ["library"], refetchType: "none" });
}

export function useToggleLike() {
  const qc = useQueryClient();
  return useMutation({
    // `liked` is whether it is liked now; the click flips it.
    mutationFn: ({ trackId, liked, track }: { trackId: string; liked: boolean; track?: Track }) =>
      setLiked(qc, track ?? { id: trackId }, !liked),
  });
}
