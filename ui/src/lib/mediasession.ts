import { usePlayer, currentPosition, interpolationRate } from "./player";
import { transport } from "./playback";
import { artistNames, artworkAtLeast } from "./types";

/**
 * Operating-system media integration.
 *
 * Chromium's Media Session API drives the native now-playing surface — the
 * Windows volume-flyout overlay, the macOS Now Playing panel, and the media
 * keys on keyboards and headsets. Feeding it turns the app from a window that
 * happens to make noise into something the OS treats as a media player.
 *
 * Every call is guarded. The API is absent in older engines and partially
 * implemented in some, and a missing handler must degrade to "the OS shows
 * less" rather than throwing.
 */

let installed = false;

export function installMediaSession(): () => void {
  if (installed || typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return () => {};
  }
  installed = true;

  const ms = navigator.mediaSession;

  const setHandler = (
    action: MediaSessionAction,
    handler: MediaSessionActionHandler | null,
  ) => {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      // Not every action is supported everywhere; an unsupported one simply
      // does not appear on the OS surface.
    }
  };

  setHandler("play", () => {
    if (usePlayer.getState().state !== "playing") transport.toggle();
  });
  setHandler("pause", () => {
    if (usePlayer.getState().state === "playing") transport.toggle();
  });
  setHandler("nexttrack", () => transport.next());
  setHandler("previoustrack", () => transport.prev());
  setHandler("seekto", (details) => {
    if (typeof details.seekTime === "number") {
      transport.seek(details.seekTime * 1000);
    }
  });
  setHandler("seekforward", (details) => {
    const s = usePlayer.getState();
    transport.seek(currentPosition(s) + (details.seekOffset ?? 10) * 1000);
  });
  setHandler("seekbackward", (details) => {
    const s = usePlayer.getState();
    transport.seek(Math.max(0, currentPosition(s) - (details.seekOffset ?? 10) * 1000));
  });

  let lastTrackId: string | null = null;

  const sync = () => {
    const s = usePlayer.getState();
    const track = s.track;

    if (!track) {
      ms.playbackState = "none";
      ms.metadata = null;
      lastTrackId = null;
      return;
    }

    // Rebuild metadata only on a track change. Reassigning it every tick makes
    // the OS overlay flicker on some Windows builds.
    if (track.id !== lastTrackId) {
      lastTrackId = track.id;
      const art = artworkAtLeast(track.artwork, 512);
      try {
        ms.metadata = new MediaMetadata({
          title: track.title,
          artist: artistNames(track.artists),
          album: track.album?.name ?? "",
          artwork: art ? [{ src: art, sizes: "512x512", type: "image/jpeg" }] : [],
        });
      } catch {
        /* metadata unsupported; transport controls still work */
      }
    }

    ms.playbackState = s.state === "playing" ? "playing" : "paused";

    // Position lets the OS draw a live scrubber. It throws if the values are
    // inconsistent, so guard rather than trusting them.
    try {
      const duration = track.durationMs / 1000;
      const position = Math.min(currentPosition(s) / 1000, duration || 0);
      if (duration > 0 && position >= 0) {
        // The OS scrubber interpolates on its own, so it needs the real rate.
        ms.setPositionState({ duration, position, playbackRate: interpolationRate(s) || 1 });
      }
    } catch {
      /* inconsistent state mid-transition; the next tick corrects it */
    }
  };

  const unsubscribe = usePlayer.subscribe(sync);
  // The OS scrubber drifts without a periodic nudge, but it needs far less
  // than frame rate.
  const timer = window.setInterval(sync, 2000);
  sync();

  return () => {
    unsubscribe();
    clearInterval(timer);
    for (const action of [
      "play", "pause", "nexttrack", "previoustrack",
      "seekto", "seekforward", "seekbackward",
    ] as MediaSessionAction[]) {
      setHandler(action, null);
    }
    installed = false;
  };
}
