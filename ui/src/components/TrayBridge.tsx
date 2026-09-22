import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePlayer } from "../lib/player";
import { transport } from "../lib/playback";
import { useSettings } from "../lib/settings";
import { useLikedIds, useToggleLike } from "../lib/liked";
import { toggleMini, useMini } from "../lib/miniplayer";
import { artistNames, artworkAtLeast } from "../lib/types";
import { desktop } from "../lib/desktop";
import type { TrayAction, TrayState } from "../lib/traystate";

/**
 * Feeds the desktop shell's tray surfaces and carries out what they ask.
 *
 * A component rather than a plain installer because liking needs the query
 * client: the flyout's heart is the same mutation as the bar's, optimistic
 * update and all, so both show the same answer at once. Renders nothing, and
 * does nothing outside the desktop app.
 */
export function TrayBridge() {
  const likedIds = useLikedIds();
  const toggleLike = useToggleLike();
  const qc = useQueryClient();
  const canLike = qc.getQueryState(["liked"])?.status === "success";
  const miniOpen = useMini((s) => s.win !== null);
  const closeToTray = useSettings((s) => s.closeToTray);

  // Read from the push below, which runs outside React's render.
  const live = useRef({ likedIds, canLike, miniOpen });
  live.current = { likedIds, canLike, miniOpen };
  const push = useRef<() => void>(() => {});

  useEffect(() => {
    if (!desktop.available) return;
    let lastKey = "";

    push.current = () => {
      const s = usePlayer.getState();
      const { likedIds, canLike, miniOpen } = live.current;
      const track = s.track;
      const next: TrayState = {
        track: track
          ? {
              id: track.id,
              title: track.title,
              artist: artistNames(track.artists),
              artwork: artworkAtLeast(track.artwork, 120) ?? "",
            }
          : null,
        playing: s.state === "playing" || s.state === "loading" || s.state === "stalled",
        liked: Boolean(track && likedIds.has(track.id)),
        canLike,
        shuffle: s.shuffle,
        repeat: s.repeat,
        miniOpen,
      };
      // The player store changes many times a second; the snapshot only
      // when something it shows does.
      const key = JSON.stringify(next);
      if (key === lastKey) return;
      lastKey = key;
      desktop.setTrayState(next);
    };

    const off = usePlayer.subscribe(() => push.current());
    push.current();
    return off;
  }, []);

  // The liked list and the mini player live outside the player store.
  useEffect(() => {
    push.current();
  }, [likedIds, canLike, miniOpen]);

  useEffect(() => {
    desktop.setCloseToTray(closeToTray);
  }, [closeToTray]);

  // Latest mutation, so the action handler below never holds a stale one.
  const like = useRef(toggleLike.mutate);
  like.current = toggleLike.mutate;

  useEffect(
    () =>
      desktop.onTrayAction((action: TrayAction) => {
        switch (action.type) {
          case "toggle":
            return transport.toggle();
          case "next":
            return transport.next();
          case "prev":
            return transport.prev();
          case "shuffle":
            return transport.toggleShuffle();
          case "repeat":
            return transport.cycleRepeat();
          case "mini":
            return toggleMini();
          case "like": {
            const track = usePlayer.getState().track;
            if (!track || !live.current.canLike) return;
            like.current({ trackId: track.id, liked: live.current.likedIds.has(track.id), track });
            return;
          }
        }
      }),
    [],
  );

  return null;
}
