/**
 * Playback speed.
 *
 * The chosen speed lives in settings; what actually plays is that speed or
 * 1×, because Listen Together keeps every member on one clock and a sped-up
 * member would drift out of the room.
 *
 * Any speed in the range can be chosen, in small steps, with presets for the
 * common ones — the way YouTube's own speed panel works. An engine either
 * plays any speed or offers a fixed list; with a list, the choice snaps to
 * the nearest speed on it rather than being silently ignored.
 */
import { useSettings } from "./settings";
import { useTogether } from "./together";

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 3;
export const SPEED_STEP = 0.05;
/** One tap away, as YouTube offers them. Slower is on the slider. */
export const SPEED_PRESETS = [1, 1.25, 1.5, 1.75, 2, 3] as const;

/** What an engine can play: any speed in the range, or only these. */
export type SpeedSupport = "any" | readonly number[];

/** "1×", "1.25×": the button's label. */
export function formatSpeed(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

/** Clamped to the range and rounded to a step, so floating-point drift never shows. */
export function clampSpeed(rate: number): number {
  const stepped = Math.round(rate / SPEED_STEP) * SPEED_STEP;
  return Number(Math.min(MAX_SPEED, Math.max(MIN_SPEED, stepped)).toFixed(2));
}

/** The speed an engine will actually play for a requested one. */
export function playableSpeed(rate: number, support: SpeedSupport): number {
  const wanted = clampSpeed(rate);
  if (support === "any" || support.length === 0) return wanted;
  return support.reduce((best, r) => (Math.abs(r - wanted) < Math.abs(best - wanted) ? r : best), support[0]!);
}

/** Whether a Listen Together room — hosted or joined — is pinning playback to 1×. */
export function inRoom(s = useTogether.getState()): boolean {
  return s.role !== null;
}

/** The speed that should be playing now. */
export function effectiveSpeed(): number {
  return inRoom() ? 1 : clampSpeed(useSettings.getState().playbackSpeed || 1);
}
