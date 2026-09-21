import { useNavigate } from "react-router-dom";
import { useMenu, type MenuItem } from "./ContextMenu";
import { usePrompt } from "./Prompt";
import { IconMore } from "./Icon";
import { transport } from "../lib/playback";
import { share } from "../lib/share";
import { useAddToPlaylist, useCreatePlaylist, useDeletePlaylist, useOwnPlaylists } from "../lib/playlists";
import type { Track } from "../lib/types";

/**
 * The "…" button on an entity page.
 *
 * A page and a card show the same thing, so they should offer the same
 * actions: a card had a menu and the page it opens did not, which meant the
 * quickest way to queue an album was to navigate away from it.
 *
 * The actions need the whole track list, which the page already has and a
 * card does not — so "add all to a playlist" exists here and not there.
 */
export function EntityActions({
  kind,
  id,
  title,
  tracks,
}: {
  kind: "album" | "playlist" | "artist" | "podcast";
  id: string;
  title: string;
  tracks: Track[];
}) {
  const menu = useMenu();
  const prompt = usePrompt();
  const navigate = useNavigate();
  const playlists = useOwnPlaylists();
  const addTo = useAddToPlaylist();
  const createPlaylist = useCreatePlaylist();
  const deletePlaylist = useDeletePlaylist();

  const build = (): MenuItem[] => {
    const out: MenuItem[] = [];
    const ids = tracks.map((t) => t.id);

    if (tracks.length > 0) {
      out.push({ label: "Add to queue", onSelect: () => transport.enqueue(tracks) });
      out.push({ label: "Play next", onSelect: () => transport.playNext(tracks) });
      out.push({
        label: "Add all to a new playlist…",
        separated: true,
        onSelect: () => {
          void (async () => {
            const name = await prompt.text({
              title: "New playlist",
              label: "Name",
              initial: title,
            });
            if (name) createPlaylist.mutate({ title: name, tracks });
          })();
        },
      });
      for (const pl of playlists.slice(0, 6)) {
        if (pl.id === id) continue;
        out.push({
          label: `Add all to ${pl.title}`,
          onSelect: () => addTo.mutate({ playlistId: pl.id, trackIds: ids }),
        });
      }
    }

    if (kind === "playlist" && id !== "LM") {
      out.push({
        label: "Delete playlist",
        separated: true,
        onSelect: () => {
          void (async () => {
            const sure = await prompt.confirm({
              title: `Delete ${title}?`,
              body: "This removes the playlist from your YouTube Music account. It cannot be undone.",
              confirmLabel: "Delete",
              danger: true,
            });
            if (sure) {
              deletePlaylist.mutate(id);
              // The page it was opened from no longer exists.
              navigate("/");
            }
          })();
        },
      });
    }

    // Each kind has its own link shape; browse/<id> was wrong for playlists and
    // for artists opened from the library.
    out.push({ label: "Share", separated: true, onSelect: () => void share(kind, id) });
    return out;
  };

  return (
    <button
      className="iconbtn entityactions__more"
      aria-label={`More options for ${title}`}
      onClick={(e) => menu.open(e, build())}
    >
      <IconMore size={22} />
    </button>
  );
}
