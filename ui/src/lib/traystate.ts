import type { RepeatMode } from "./player";

/**
 * What the desktop shell's tray surfaces draw — the flyout, the menu, the
 * taskbar buttons — and what they can ask for.
 *
 * The tray is for control, not for watching: what is playing, and the
 * buttons to change it. Progress, volume, the queue and the lyrics live in
 * the mini player, which can show them properly.
 *
 * Shared by the main window, which produces the snapshot and carries out the
 * actions, and the flyout page, which only draws the one and sends the other.
 */
export interface TrayState {
  track: {
    id: string;
    title: string;
    artist: string;
    artwork: string;
  } | null;
  /** Intent rather than observation: buffering still counts as playing. */
  playing: boolean;
  liked: boolean;
  /** False when signed out, or before the liked list has loaded. */
  canLike: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Whether the mini player is open, for the menu's tick. */
  miniOpen: boolean;
}

export type TrayAction =
  | { type: "toggle" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "like" }
  | { type: "shuffle" }
  | { type: "repeat" }
  | { type: "mini" };
