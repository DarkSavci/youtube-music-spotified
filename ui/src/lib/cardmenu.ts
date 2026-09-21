import { useNavigate } from "react-router-dom";
import type { MenuItem } from "../components/ContextMenu";
import type { ShelfItem } from "./types";
import { playEntity, transport } from "./playback";
import { apiUrl } from "./base";
import { useTrackMenu } from "./trackmenu";
import { share } from "./share";

/**
 * What a right-click on a card offers.
 *
 * A card and a row show the same things, so they should offer the same things:
 * a track card defers entirely to the track menu, and the entity kinds get the
 * actions that make sense for a whole album, artist or playlist.
 */
export function useCardMenu(): (item: ShelfItem) => MenuItem[] {
  const navigate = useNavigate();
  const trackMenu = useTrackMenu();

  return (item) => {
    if (item.kind === "track" && item.track) return trackMenu(item.track);
    if (item.kind === "episode" && item.episode) return trackMenu(item.episode);

    const open = (href: string) => () => navigate(href);

    if (item.kind === "album" && item.album) {
      const album = item.album;
      return [
        { label: "Play", onSelect: () => void playEntity("album", album.id, album.title) },
        { label: "Open album", onSelect: open(`/album/${encodeURIComponent(album.id)}`) },
        { label: "Share", separated: true, onSelect: () => void share("album", album.id) },
      ];
    }

    if (item.kind === "playlist" && item.playlist) {
      const pl = item.playlist;
      return [
        { label: "Play", onSelect: () => void playEntity("playlist", pl.id, pl.title) },
        { label: "Open playlist", onSelect: open(`/playlist/${encodeURIComponent(pl.id)}`) },
        { label: "Share", separated: true, onSelect: () => void share("playlist", pl.id) },
      ];
    }

    if (item.kind === "artist" && item.artist) {
      const artist = item.artist;
      return [
        { label: "Play", onSelect: () => void playEntity("artist", artist.id, artist.name) },
        { label: "Open artist", onSelect: open(`/artist/${encodeURIComponent(artist.id)}`) },
        {
          label: "Follow",
          separated: true,
          onSelect: () => {
            void fetch(apiUrl(`/v1/me/artists/${encodeURIComponent(artist.id)}/follow`), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ follow: true }),
            });
          },
        },
        { label: "Share", onSelect: () => void share("artist", artist.id) },
      ];
    }

    if (item.kind === "podcast" && item.podcast) {
      const show = item.podcast;
      return [
        { label: "Open show", onSelect: open(`/podcast/${encodeURIComponent(show.id)}`) },
        { label: "Share", separated: true, onSelect: () => void share("podcast", show.id) },
      ];
    }

    void transport;
    return [];
  };
}
