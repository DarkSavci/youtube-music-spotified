import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { api, ApiError } from "./api";
import { apiUrl } from "./base";
import { toast } from "./toast";
import { libraryFailure } from "./signin";
import type { LibraryItem, Track } from "./types";

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
  const query = useQuery({
    queryKey: ["liked"],
    queryFn: ({ signal }) => api.liked(signal),
    // Fetched once. Likes made here change the cached list directly (see
    // setLiked), so it never needs refetching to stay right; a like made on a
    // phone shows after the next launch. Reading the whole list is up to 61
    // requests to YouTube, which is what refetching it every five minutes
    // and after every like used to cost.
    staleTime: Infinity,
    refetchOnMount: false,
    // A failed read is retried a few times with a growing wait — after a 429,
    // no sooner than YouTube asked — rather than at once, and not by every
    // component that mounts: see the effect below.
    retry: (count, err) => !(err instanceof ApiError && err.reauth) && count < 3,
    retryDelay: likedRetryDelay,
    retryOnMount: false,
  });
  // Something that shows hearts mounting after the read gave up tries again,
  // at most once a minute (or once YouTube's wait is over), so one bad
  // moment does not leave likes broken for the whole session.
  // That re-read is a single attempt: the retry chain above is for the first
  // load only, or a lasting 429 would bring a fresh chain every minute.
  const qc = useQueryClient();
  const { isError, errorUpdatedAt, error } = query;
  useEffect(() => {
    if (!isError || (error instanceof ApiError && error.reauth)) return;
    const wait = Math.max(60_000, error instanceof ApiError && error.rateLimited ? error.retryAfter * 1000 : 0);
    if (Date.now() - errorUpdatedAt < wait) return;
    void qc
      .fetchQuery({ queryKey: ["liked"], queryFn: ({ signal }) => api.liked(signal), retry: false, staleTime: 0 })
      .catch(() => {});
  }, [isError, errorUpdatedAt, error, qc]);
  return new Set((query.data?.tracks ?? []).map((t) => t.id));
}

/** 2 s, 4 s, 8 s…; after a 429, whatever YouTube asked for, at least 30 s. */
export function likedRetryDelay(count: number, err: unknown): number {
  if (err instanceof ApiError && err.rateLimited) return Math.max(30_000, err.retryAfter * 1000);
  return Math.min(2_000 * 2 ** count, 30_000);
}

/**
 * Whether liking can be offered at all: everywhere except a confirmed signed
 * out session. It does not wait for the list — a like works without it.
 */
export function useCanLike(): boolean {
  const qc = useQueryClient();
  const signedOut = useSyncExternalStore(
    (listener) => qc.getQueryCache().subscribe(listener),
    () => {
      const error = qc.getQueryState(["liked"])?.error;
      return error instanceof ApiError && error.reauth;
    },
  );
  return !signedOut;
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
    if (!res.ok) throw new ApiError(`status ${res.status}`, res.status, res.status === 401);
  } catch (err) {
    if (before) qc.setQueryData(["liked"], before);
    throw err;
  }
  if (!before) void qc.invalidateQueries({ queryKey: ["liked"] });
  // An open Liked Music page catches up now; closed, the next time it opens.
  void qc.invalidateQueries({ queryKey: ["playlist", "LM"], refetchType: "active" });
  // The sidebar's Liked Music entry carries the count; it is changed in
  // place rather than by reading the library (three requests) again.
  adjustLikedCount(qc, liked ? 1 : -1);
}

export function useToggleLike() {
  const qc = useQueryClient();
  return useMutation({
    // `liked` is whether it is liked now; the click flips it.
    mutationFn: ({ trackId, liked, track }: { trackId: string; liked: boolean; track?: Track }) =>
      setLiked(qc, track ?? { id: trackId }, !liked),
    // The heart has already sprung back; say why rather than fail silently.
    onError: (err) => toast(libraryFailure(err, "Couldn't update your library. Try again.")),
  });
}

/** Moves the song count in the library's Liked Music entry by `delta`. */
function adjustLikedCount(qc: QueryClient, delta: number) {
  qc.setQueriesData<LibraryItem[]>({ queryKey: ["library"] }, (items) =>
    Array.isArray(items)
      ? items.map((item) => {
          if (item.id !== "LM" || item.subtitle === undefined) return item;
          const count = likedCount(item.subtitle);
          return count === null ? item : { ...item, subtitle: songCount(Math.max(0, count + delta)) };
        })
      : items,
  );
}

/*
 * The core writes the count as "N songs", "1 song", or "Auto playlist" when
 * nothing is liked yet; songCount writes it back the same way, so the entry
 * reads the same whether the core or a like set it.
 */
function likedCount(subtitle: string): number | null {
  if (subtitle === "Auto playlist") return 0;
  const m = /^(\d[\d,.]*)\s+songs?$/i.exec(subtitle.trim());
  return m?.[1] ? Number(m[1].replace(/[,.]/g, "")) : null;
}

export function songCount(n: number): string {
  if (n === 0) return "Auto playlist";
  return n === 1 ? "1 song" : `${n} songs`;
}
