import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { installShortcuts } from "../lib/shortcuts";
import { usePlayer } from "../lib/player";
import { useLikedIds, useToggleLike } from "../lib/liked";
import { useCreatePlaylist } from "../lib/playlists";
import { usePrompt } from "./Prompt";

/**
 * Installs the keyboard shortcuts.
 *
 * A component rather than a hook in the shell, because several shortcuts now
 * need things only available inside the providers — a prompt for a playlist
 * name, the mutation that creates one — and the shell renders those providers,
 * so it sits outside them and cannot use their hooks.
 *
 * The panel toggles stay with the shell, which owns that state, and arrive
 * here as props.
 */
export function Shortcuts({
  onToggleQueue,
  onToggleLyrics,
  onToggleFullScreen,
}: {
  onToggleQueue: () => void;
  onToggleLyrics: () => void;
  onToggleFullScreen: () => void;
}) {
  const navigate = useNavigate();
  const prompt = usePrompt();
  const createPlaylist = useCreatePlaylist();
  const liked = useLikedIds();
  const toggleLike = useToggleLike();
  const track = usePlayer((s) => s.track);

  useEffect(() => {
    return installShortcuts({
      go: (path) => navigate(path),
      back: () => navigate(-1),
      forward: () => navigate(1),
      toggleQueue: onToggleQueue,
      toggleLyrics: onToggleLyrics,
      toggleFullScreen: onToggleFullScreen,

      // The field owns its own focus, so this only has to put the caret in
      // it. The delay lets the route change render the field first.
      focusSearch: () => {
        navigate("/search");
        window.setTimeout(() => {
          const el = document.querySelector<HTMLInputElement>(".searchfield input");
          el?.focus();
          el?.select();
        }, 60);
      },

      newPlaylist: () => {
        void (async () => {
          const name = await prompt.text({
            title: "New playlist",
            label: "Name",
            initial: "My playlist",
          });
          if (name) createPlaylist.mutate({ title: name });
        })();
      },

      // Saving with nothing playing would be a keystroke that silently does
      // nothing, which is worse than one that is not bound at all.
      saveCurrent: () => {
        if (!track) return;
        toggleLike.mutate({ trackId: track.id, liked: liked.has(track.id) });
      },
    });
  }, [
    navigate, prompt, createPlaylist, liked, toggleLike, track,
    onToggleQueue, onToggleLyrics, onToggleFullScreen,
  ]);

  return null;
}
