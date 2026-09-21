import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { apiUrl } from "./base";
import type { LibraryItem, Track } from "./types";

/**
 * Editing playlists.
 *
 * The four operations behind these calls were implemented in the core and left
 * unreachable for months — no route, no control. They are wired here rather
 * than in each component so "add to playlist" means the same thing from a
 * track row, a card and the now-playing bar.
 *
 * Every mutation invalidates the library and the affected playlist, because
 * YouTube is the source of truth and an optimistic edit that failed would
 * leave the sidebar disagreeing with the account.
 */

async function send(path: string, method: string, body?: unknown): Promise<Response> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res;
}

/** The user's own playlists, for an "add to" menu. */
export function useOwnPlaylists(): LibraryItem[] {
  const { data } = useQuery({
    queryKey: ["library", "playlists", "alphabetical"],
    queryFn: ({ signal }) => api.library("playlists", "alphabetical", signal),
    staleTime: 60_000,
    retry: false,
  });
  // Liked Music is a generated list and cannot be added to; offering it would
  // produce an error the user cannot act on.
  return (data ?? []).filter((p) => p.id !== "LM");
}

export function useCreatePlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { title: string; description?: string; tracks?: Track[] }) => {
      const res = await send("/v1/me/playlists", "POST", {
        title: v.title,
        description: v.description ?? "",
        public: false,
      });
      const { id } = (await res.json()) as { id: string };
      if (v.tracks?.length) {
        await send(`/v1/me/playlists/${encodeURIComponent(id)}/tracks`, "POST", {
          trackIds: v.tracks.map((t) => t.id),
        });
      }
      return id;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["library"] }),
  });
}

export function useAddToPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { playlistId: string; trackIds: string[] }) =>
      send(`/v1/me/playlists/${encodeURIComponent(v.playlistId)}/tracks`, "POST", {
        trackIds: v.trackIds,
      }),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: ["playlist", v.playlistId] });
      void qc.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

export function useRemoveFromPlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { playlistId: string; items: { trackId: string; itemId: string }[] }) =>
      send(`/v1/me/playlists/${encodeURIComponent(v.playlistId)}/tracks`, "DELETE", {
        items: v.items,
      }),
    onSettled: (_d, _e, v) => qc.invalidateQueries({ queryKey: ["playlist", v.playlistId] }),
  });
}

export function useDeletePlaylist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (playlistId: string) =>
      send(`/v1/me/playlists/${encodeURIComponent(playlistId)}`, "DELETE"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["library"] }),
  });
}

/* ---------- organising: pins and folders ---------- */

export function useFolders() {
  const { data } = useQuery({
    queryKey: ["folders"],
    queryFn: async ({ signal }) => {
      const res = await fetch(apiUrl("/v1/me/folders"), { signal });
      if (!res.ok) return [];
      return (await res.json()) as { id: string; name: string }[];
    },
    staleTime: 60_000,
    retry: false,
  });
  return data ?? [];
}

export function useOrganise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      kind: string;
      itemId: string;
      pinned?: boolean;
      folderId?: string;
    }) => send("/v1/me/library/organise", "POST", v),
    onSettled: () => qc.invalidateQueries({ queryKey: ["library"] }),
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await send("/v1/me/folders", "POST", { name });
      return ((await res.json()) as { id: string }).id;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["folders"] });
      void qc.invalidateQueries({ queryKey: ["library"] });
    },
  });
}


export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (folderId: string) =>
      send(`/v1/me/folders/${encodeURIComponent(folderId)}`, "DELETE"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["folders"] });
      void qc.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

/** Follows or unfollows an artist. Upstream models it as a subscription. */
export function useFollowArtist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { artistId: string; follow: boolean }) =>
      send(`/v1/me/artists/${encodeURIComponent(v.artistId)}/follow`, "POST", {
        follow: v.follow,
      }),
    // The artist page carries the follow state now, so it is stale after this
    // too — invalidating only the library left the button showing whatever
    // the page had been loaded with.
    onSettled: (_data, _err, v) => {
      void qc.invalidateQueries({ queryKey: ["library"] });
      void qc.invalidateQueries({ queryKey: ["artist", v.artistId] });
    },
  });
}
