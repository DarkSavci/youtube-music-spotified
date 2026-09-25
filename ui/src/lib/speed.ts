/**
 * Playback speed.
 *
 * The chosen speed lives in settings; what actually plays is that speed or
 * 1×, because Listen Together keeps every member on one clock and a sped-up
 * member would drift out of the room. Engines report which of these they can
 * play; the rest are shown but disabled rather than silently ignored.
 */
import { useSettings } from "./settings";
import { useTogether } from "./together";

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** "1×", "1.25×". */
export function formatSpeed(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

/** Whether a Listen Together room — hosted or joined — is pinning playback to 1×. */
export function inRoom(s = useTogether.getState()): boolean {
  return s.role !== null;
}

/** The speed that should be playing now. */
export function effectiveSpeed(): number {
  return inRoom() ? 1 : useSettings.getState().playbackSpeed || 1;
}
