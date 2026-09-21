import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
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
    staleTime: 5 * 60 * 1000,
    retry: false,
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

export function useToggleLike() {
  const qc = useQueryClient();
  return useMutation({
    onMutate: async ({ trackId, liked, track }: { trackId: string; liked: boolean; track?: Track }) => {
      await qc.cancelQueries({ queryKey: ["liked"] });
      const before = qc.getQueryData<LikedList>(["liked"]);
      qc.setQueryData<LikedList>(["liked"], (old) => {
        const tracks = old?.tracks ?? [];
        const next = liked
          ? tracks.filter((t) => t.id !== trackId)
          : [track ?? ({ id: trackId } as Track), ...tracks.filter((t) => t.id !== trackId)];
        return { ...(old ?? {}), tracks: next };
      });
      return { before };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) qc.setQueryData(["liked"], ctx.before);
    },
    mutationFn: async ({ trackId, liked }: { trackId: string; liked: boolean; track?: Track }) => {
      const res = await fetch(
        apiUrl(`/v1/me/tracks/${encodeURIComponent(trackId)}/rating`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // "none" clears a like; there is no separate unlike.
          body: JSON.stringify({ rating: liked ? "none" : "like" }),
        },
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
    },
    // Then re-read: the playlist is the source of truth.
    onSettled: () => qc.invalidateQueries({ queryKey: ["liked"] }),
  });
}
