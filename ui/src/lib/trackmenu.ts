import { createElement } from "react";
import { IconLibrary } from "../components/Icon";
import { useNavigate } from "react-router-dom";
import { share } from "./share";
import { useQueryClient } from "@tanstack/react-query";
import type { MenuItem } from "../components/ContextMenu";
import type { Track } from "./types";
import { transport } from "./playback";
import { api } from "./api";
import { apiUrl } from "./base";
import { useLikedIds } from "./liked";
import {
  useAddToPlaylist, useCreatePlaylist, useOwnPlaylists, useRemoveFromPlaylist,
} from "./playlists";
import { usePrompt } from "../components/Prompt";

/**
 * What a right-click on a Track offers.
 *
 * Built here rather than in each surface so a track means the same thing
 * wherever it is shown — a menu that differs between the queue, a playlist and
 * a search result is a menu people stop trusting.
 *
 * Actions that cannot be honoured are left out rather than shown disabled:
 * "Go to album" on a track with no album is noise, not information.
 */
export function useTrackMenu(): (
  track: Track,
  context?: { origin?: string; playlistId?: string },
) => MenuItem[] {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const liked = useLikedIds();
  const playlists = useOwnPlaylists();
  const addTo = useAddToPlaylist();
  const removeFrom = useRemoveFromPlaylist();
  const createPlaylist = useCreatePlaylist();
  const prompt = usePrompt();

  return (track, context) => {
    const items: MenuItem[] = [];

    items.push({
      label: "Add to queue",
      onSelect: () => transport.enqueue([track]),
    });
    items.push({
      label: "Play next",
      onSelect: () => transport.playNext([track]),
    });

    const destinations: MenuItem[] = [];
    destinations.push({
      label: "New playlist…",
      onSelect: () => {
        void (async () => {
          const name = await prompt.text({
            title: "New playlist",
            label: "Name",
            initial: track.title,
          });
          if (name) createPlaylist.mutate({ title: name, tracks: [track] });
        })();
      },
    });
    for (const pl of playlists) {
      destinations.push({
        label: pl.title,
        icon: createElement(IconLibrary, { size: 18 }),
        onSelect: () => addTo.mutate({ playlistId: pl.id, trackIds: [track.id] }),
      });
    }

    items.push({ label: "Add to playlist", separated: true, children: destinations });

    // Only offered where the membership handle exists, which is on the
    // playlist the track was read from — the same track can appear twice, so
    // its identifier alone cannot say which row to remove.
    if (context?.playlistId && track.playlistItemId) {
      items.push({
        label: "Remove from this playlist",
        onSelect: () =>
          removeFrom.mutate({
            playlistId: context.playlistId!,
            items: [{ trackId: track.id, itemId: track.playlistItemId! }],
          }),
      });
    }

    items.push({
      label: "Go to song radio",
      separated: true,
      onSelect: () => {
        void (async () => {
          const tracks = await api.radio(track.id);
          if (tracks.length > 0) transport.play(tracks, 0, `${track.title} radio`);
        })();
      },
    });

    const artist = track.artists?.[0];
    if (artist?.id) {
      items.push({
        label: `Go to ${artist.name}`,
        onSelect: () => navigate(`/artist/${encodeURIComponent(artist.id!)}`),
      });
    }
    if (track.album?.id) {
      items.push({
        label: "Go to album",
        onSelect: () => navigate(`/album/${encodeURIComponent(track.album!.id!)}`),
      });
    }

    const isLiked = liked.has(track.id);
    items.push({
      label: isLiked ? "Remove from your library" : "Save to your library",
      separated: true,
      onSelect: () => {
        void (async () => {
          await fetch(apiUrl(`/v1/me/tracks/${encodeURIComponent(track.id)}/rating`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rating: isLiked ? "none" : "like" }),
          });
          void qc.invalidateQueries({ queryKey: ["liked"] });
          void qc.invalidateQueries({ queryKey: ["playlist", "LM"] });
        })();
      },
    });

    items.push({
      label: "Share",
      // The link opens on YouTube Music, which is what a recipient without
      // this app can actually use.
      onSelect: () => void share("track", track.id),
    });

    void context;
    return items;
  };
}
