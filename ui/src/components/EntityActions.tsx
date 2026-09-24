import { useEffect, useRef, useState } from "react";
import { toast } from "../lib/toast";
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
  loadTracks,
}: {
  kind: "album" | "playlist" | "artist" | "podcast";
  id: string;
  title: string;
  tracks: Track[];
  loadTracks?: () => Promise<Track[]>;
}) {
  const generation = useRef(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => { setLoading(false); return () => { generation.current++; }; }, [id]);
  const menu = useMenu();
  const prompt = usePrompt();
  const navigate = useNavigate();
  const playlists = useOwnPlaylists();
  const addTo = useAddToPlaylist();
  const createPlaylist = useCreatePlaylist();
  const deletePlaylist = useDeletePlaylist();

  const withTracks = async (action: (all: Track[]) => void) => {
    if (!loadTracks) { action(tracks); return; }
    const current = ++generation.current;
    setLoading(true);
    try {
      const all = await loadTracks();
      if (current === generation.current) action(all);
    } catch {
      if (current === generation.current) toast("Could not load the complete playlist. Please try again.");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  };

  const build = (): MenuItem[] => {
    const out: MenuItem[] = [];

    if (tracks.length > 0) {
      out.push({ label: "Add to queue", onSelect: () => void withTracks((all) => transport.enqueue(all)) });
      out.push({ label: "Play next", onSelect: () => void withTracks((all) => transport.playNext(all)) });
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
            if (name) void withTracks((all) => createPlaylist.mutate({ title: name, tracks: all }));
          })();
        },
      });
      for (const pl of playlists.slice(0, 6)) {
        if (pl.id === id) continue;
        out.push({
          label: `Add all to ${pl.title}`,
          onSelect: () => void withTracks((all) => addTo.mutate({ playlistId: pl.id, trackIds: all.map((t) => t.id) })),
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
      disabled={loading}
      aria-busy={loading}
      onClick={(e) => menu.open(e, build())}
    >
      <IconMore size={22} />
    </button>
  );
}
