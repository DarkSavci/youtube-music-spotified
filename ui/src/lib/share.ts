import { toast } from "./toast";

/**
 * Sharing: the public YouTube Music link for something, on the clipboard.
 *
 * The link is YouTube Music's, never ours — this app's routes mean nothing on
 * anyone else's machine, and the person receiving it may not have the app at
 * all. Each kind needs its own shape, and the identifiers the catalogue hands
 * us are not always the ones those links take: a library artist arrives as
 * MPLA-prefixed and a playlist browse id as VL-prefixed, and pasting either
 * into a link produces a page that does not exist.
 */
export type ShareKind = "track" | "episode" | "album" | "playlist" | "artist" | "podcast";

const BASE = "https://music.youtube.com";

export function shareUrl(kind: ShareKind, id: string): string {
  const enc = encodeURIComponent;
  switch (kind) {
    case "track":
    case "episode":
      return `${BASE}/watch?v=${enc(id)}`;
    case "playlist":
      return `${BASE}/playlist?list=${enc(id.replace(/^VL/, ""))}`;
    case "album":
      // An album is either a release page or, for some, a playlist.
      return id.startsWith("OLAK")
        ? `${BASE}/playlist?list=${enc(id)}`
        : `${BASE}/browse/${enc(id)}`;
    case "artist":
      // The library's view of an artist wraps the channel id; the link wants
      // the channel itself.
      return `${BASE}/channel/${enc(id.replace(/^MPLA(?=UC)/, ""))}`;
    case "podcast":
      return `${BASE}/browse/${enc(id)}`;
  }
}

const NOUN: Record<ShareKind, string> = {
  track: "Song",
  episode: "Episode",
  album: "Album",
  playlist: "Playlist",
  artist: "Artist",
  podcast: "Podcast",
};

/** Copies the link and says so. */
export async function share(kind: ShareKind, id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(shareUrl(kind, id));
    toast(`${NOUN[kind]} link copied to clipboard`);
  } catch {
    toast("Could not copy the link");
  }
}
