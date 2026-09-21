import { useSettings } from "./settings";
import type { ShelfItem, Track } from "./types";

/**
 * Hiding music videos.
 *
 * The setting existed with a control in Settings and no consumer anywhere, so
 * turning it off changed nothing. It is the product's position rather than a
 * limitation: the reason to build an audio-first client on YouTube Music is to
 * get the catalogue without the video-first framing.
 *
 * Filtering happens on the client because the same response feeds surfaces
 * that should and should not be filtered — a video the user deliberately
 * searched for under the Videos filter is not noise.
 */
export function useTrackFilter(): (tracks: Track[]) => Track[] {
  const show = useSettings((s) => s.showMusicVideos);
  return (tracks) => (show ? tracks : tracks.filter((t) => !t.isVideo));
}

export function useShelfItemFilter(): (items: ShelfItem[]) => ShelfItem[] {
  const show = useSettings((s) => s.showMusicVideos);
  return (items) =>
    show ? items : items.filter((i) => !(i.kind === "track" && i.track?.isVideo));
}
