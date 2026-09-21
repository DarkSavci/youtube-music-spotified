import type { NormalizationLevel } from "./engine";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * User preferences.
 *
 * Persisted per-viewer in browser storage rather than in the Control plane:
 * these are device preferences — output volume behaviour, which engine to
 * prefer, whether this machine shows music videos — and syncing them across
 * devices would be wrong rather than merely unnecessary.
 *
 * Every read and write is guarded: storage throws in private mode and in some
 * embedded contexts, and a player that refuses to start because it cannot save
 * a preference would be absurd.
 */

export type EnginePreference = "auto" | "native" | "embedded";
export type ThemeChoice = "dark" | "system";

export type { NormalizationLevel } from "./engine";

export interface Settings {
  /** Milliseconds of overlap between tracks. Zero disables crossfade. */
  crossfadeMs: number;
  gapless: boolean;
  normalization: boolean;

  /**
   * What normalisation aims for.
   *
   * Three levels rather than a slider, because the choice is between kinds of
   * compromise and not a continuum: quiet leaves headroom for dynamics, loud
   * matches everything else and spends that headroom to do it.
   */
  normalizationLevel: NormalizationLevel;

  /**
   * Music videos are hidden by default. The reason to build an audio-first
   * client on YouTube Music is to get the catalogue without the video-first
   * framing, so this is the product's position rather than a limitation.
   */
  showMusicVideos: boolean;

  enginePreference: EnginePreference;

  theme: ThemeChoice;
  reduceMotion: boolean;

  /**
   * Lets the volume go past 100%, up to 200%.
   *
   * Off by default: past full scale the music is amplified beyond what was
   * mastered, and a limiter has to hold the peaks down, which flattens loud
   * passages. Worth it for a quiet track on weak speakers, not as a default.
   */
  volumeBoost: boolean;

  /**
   * How much audio to keep on disk, in megabytes. Played and prefetched
   * tracks start from there without resolving; beyond the cap, the least
   * recently played go first.
   */
  cacheMaxMB: number;

  /** Keep playing similar songs once the queue runs out, from YouTube's radio. */
  autoplay: boolean;

  /** Restore the previous queue on launch. */
  resumeOnLaunch: boolean;

  /**
   * Whether listening here is sent to YouTube.
   *
   * Off by default, and the only setting that writes to the account: it feeds
   * watch history and recommendations, and is what lets a track picked up on
   * the phone carry on here. Everything else Spotifier does is read-only.
   */
  reportToYouTube: boolean;
  showQualityBadge: boolean;

  /**
   * Look up timed lyrics from LRCLIB when YouTube Music has none, or has only
   * untimed words.
   *
   * On by default, because words that do not follow the music are not what
   * anyone means by lyrics in a player, and YouTube Music never returns
   * timings.
   *
   * It is the one feature that contacts a service outside YouTube: it sends
   * the track title, artist and duration to lrclib.net, nothing identifying
   * the listener, and only while the lyrics view is open. Turn it off to use
   * YouTube Music alone.
   */
  timedLyrics: boolean;

  /**
   * Equaliser gains in decibels, one per band in `EQ_BANDS`.
   *
   * Stored as a plain array so a preset is just a set of numbers, and an
   * empty curve is indistinguishable from the equaliser being off.
   */
  eq: number[];
}

/*
Defaults that leave the player switched on.

Most of these started off because the feature behind them was half-built, and
a switch is a poor way to find out that something works. They are on now
because each one is finished and measured, and the ones still off are off for
a reason rather than caution.

  crossfade       six seconds, the length that reads as one track becoming
                  another rather than a dip between them
  normalization   exact replay gain from the published per-track loudness
  resumeOnLaunch  the queue survives closing the app
  reportToYouTube on, because it was asked for: it is the only setting here
                  that writes to the account, and it is what makes a track
                  started on the phone carry on here
  timedLyrics     lyrics that follow the music
  showQualityBadge  what the stream actually is, which is worth seeing

Left off deliberately:

  showMusicVideos the reason to build an audio-first client on YouTube Music
                  is to get the catalogue without the video-first framing
  reduceMotion    the system already asks this question; overriding it by
                  default would answer it for the listener
  eq              flat, because a tone control that arrives already shaping
                  the sound is not a neutral starting point
*/
export const DEFAULT_SETTINGS: Settings = {
  crossfadeMs: 6000,
  gapless: true,
  normalization: true,
  normalizationLevel: "normal",
  showMusicVideos: false,
  enginePreference: "auto",
  theme: "dark",
  reduceMotion: false,
  resumeOnLaunch: true,
  reportToYouTube: true,
  volumeBoost: false,
  cacheMaxMB: 2048,
  autoplay: true,
  showQualityBadge: true,
  timedLyrics: true,
  eq: [0, 0, 0, 0, 0],
};

interface SettingsStore extends Settings {
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  reset(): void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (key, value) => set({ [key]: value } as Partial<SettingsStore>),
      reset: () => set({ ...DEFAULT_SETTINGS }),
    }),
    {
      name: "spotifier.settings",

      /*
       * Version 2 turns the finished features on.
       *
       * Saved settings normally win, which is right — but it means someone
       * who has run the app before keeps defaults that were chosen when the
       * features behind them were half-built, and never sees them switched
       * on. Crossfade, normalisation and reporting only became worth
       * defaulting to once they worked.
       *
       * A migration rather than a reset: only the keys whose defaults changed
       * are touched, so a deliberately chosen equaliser curve, engine or
       * volume level survives.
       */
      version: 2,
      migrate: (persisted, from) => {
        const saved = (persisted ?? {}) as Partial<SettingsStore>;
        if (from >= 2) return saved;
        return {
          ...saved,
          crossfadeMs: DEFAULT_SETTINGS.crossfadeMs,
          normalization: DEFAULT_SETTINGS.normalization,
          normalizationLevel: DEFAULT_SETTINGS.normalizationLevel,
          reportToYouTube: DEFAULT_SETTINGS.reportToYouTube,
          resumeOnLaunch: DEFAULT_SETTINGS.resumeOnLaunch,
        };
      },

      // Defaults win for any key added in a later version, so an upgrade never
      // leaves a setting undefined.
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<SettingsStore>),
      }),
    },
  ),
);

/**
 * Applies preferences that affect the document rather than a component.
 *
 * Reduced motion is honoured from the OS already; this lets a user opt in
 * independently of the system setting, which matters on machines where that
 * setting is managed centrally.
 */
export function applyDocumentSettings(s: Settings) {
  const root = document.documentElement;
  root.dataset.theme = s.theme === "system" ? "" : s.theme;
  if (s.reduceMotion) {
    root.style.setProperty("--duration-fast", "0.01ms");
    root.style.setProperty("--duration-base", "0.01ms");
    root.style.setProperty("--duration-slow", "0.01ms");
  } else {
    root.style.removeProperty("--duration-fast");
    root.style.removeProperty("--duration-base");
    root.style.removeProperty("--duration-slow");
  }
}

/** The loudest the volume can be set: 200% with boost, otherwise 100%. */
export function maxVolume(boost = useSettings.getState().volumeBoost): number {
  return boost ? 2 : 1;
}
