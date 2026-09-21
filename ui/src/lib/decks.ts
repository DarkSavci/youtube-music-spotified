/**
 * Two decks and a mixer.
 *
 * Crossfading needs two tracks audible at once, which needs two media
 * elements and a gain on each. A single element can only cut. The engine
 * previously had a second element for preloading and one gain node, so it
 * could warm the next track but never fade into it — the capability was
 * advertised and the code to honour it did not exist.
 *
 * Kept apart from the engine because it is the only part that touches Web
 * Audio: the engine decides *when* to transition, this decides *how* one
 * sounds.
 */

export interface DeckHandle {
  el: HTMLAudioElement;
  videoId: string | null;
}

/**
 * Equaliser band centres, in hertz.
 *
 * Five bands rather than ten: the point is a usable tone control, and each
 * extra band is another filter in series on every sample.
 */
export const EQ_BANDS = [60, 250, 1000, 4000, 12000];

/*
 * Slider position to gain.
 *
 * Amplitude and loudness are not the same thing. Halving the amplitude is a
 * drop of only 6 dB, and it takes about 10 dB to sound half as loud — so a
 * slider wired straight to gain spends its whole top half barely changing
 * anything and crams every useful quiet level into the bottom fifth. That is
 * the jumpiness: the control is not broken, it is the wrong curve.
 *
 * Loudness grows as roughly the 0.3 power of intensity, and intensity as the
 * square of amplitude, so perceived loudness goes as amplitude^0.6. Raising
 * the position to the reciprocal of that undoes it, and the slider becomes
 * even: halfway is half as loud, and the quiet end has room to be quiet.
 *
 *     position 0.5 -> -10 dB      (half as loud, as it reads)
 *     position 0.1 -> -33 dB      (was -20 dB, which is still quite loud)
 */
const LOUDNESS_EXPONENT = 1 / 0.6;

export function perceptualGain(position: number): number {
  // Past full scale (volume boost) the gain rises linearly: 200% is twice
  // the amplitude, +6 dB, and the curve meets the taper at 100%.
  if (position > 1) return Math.min(position, 2);
  const p = Math.max(0, Math.min(1, position));
  // Silence has to be exactly silent; a power curve only approaches zero.
  if (p === 0) return 0;
  return Math.pow(p, LOUDNESS_EXPONENT);
}

export class Mixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  /**
   * Holds peaks under full scale once volume boost takes the level past
   * 100%, where they would otherwise clip. Idle (ratio 1) below that.
   */
  private limiter: DynamicsCompressorNode | null = null;
  private gains = new WeakMap<HTMLAudioElement, GainNode>();
  /*
   * Replay gain sits on its own node, ahead of the fade.
   *
   * The deck's gain carries the crossfade envelope, which is rewritten as a
   * curve on every transition — folding the track's correction into it would
   * mean the fade overwrote the correction the moment it ran. Two nodes in
   * series multiply, so each can be set without knowing about the other.
   */
  private norms = new WeakMap<HTMLAudioElement, GainNode>();
  /*
   * What each deck's replay gain should be, whether or not it can be applied.
   *
   * The correction arrives from a fetch, and the graph is built on the first
   * play — so the two race. When the correction won, there was no node to put
   * it on and it was dropped without trace: both decks played uncorrected
   * while the setting said normalisation was on. Remembering the figure lets
   * the node adopt it the moment it exists.
   */
  private wantedGainDb = new WeakMap<HTMLAudioElement, number>();
  private levelTimer?: number;
  private bands: BiquadFilterNode[] = [];
  /** Remembered so a graph built later starts with the user's curve. */
  private eq: number[] = [];

  /** The gain the loudness leveller has settled on, or 1 while it is off. */
  private levelGain = 1;

  /**
   * Builds the graph on first use.
   *
   * An AudioContext created before a user gesture starts suspended, so
   * deferring construction to the first play avoids a player that looks like
   * it is working while producing silence.
   *
   * Returns false when Web Audio is unavailable, which is not fatal: the
   * elements still play, they just cannot be faded or levelled.
   */
  ensure(): boolean {
    if (this.ctx) return true;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;

      /*
       * The equaliser sits between the master gain and the output.
       *
       * Peaking filters in series, one per band, which is the ordinary way to
       * build a graphic equaliser: each affects a range around its centre and
       * they sum. They are always in the graph at 0 dB rather than being
       * patched in when enabled, because rewiring a live graph clicks.
       */
      let node: AudioNode = this.master;
      this.bands = EQ_BANDS.map((hz) => {
        const f = this.ctx!.createBiquadFilter();
        f.type = "peaking";
        f.frequency.value = hz;
        f.Q.value = 1.1;
        f.gain.value = 0;
        node.connect(f);
        node = f;
        return f;
      });

      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1;
      this.limiter.knee.value = 0;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.25;
      this.limiter.ratio.value = 1;
      node.connect(this.limiter);
      this.limiter.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      /*
       * Keep the output open between tracks.
       *
       * With nothing sounding, the audio output can idle, and waking it
       * again can swallow the first moments of the next track: the media
       * clock starts at zero while the device is still coming back. A
       * silent tone through a gain of zero keeps it running. It never
       * touches the music's path. The same fix as kaset's ADR-0036.
       */
      const keepAlive = this.ctx.createOscillator();
      const silence = this.ctx.createGain();
      silence.gain.value = 0;
      keepAlive.connect(silence).connect(this.ctx.destination);
      keepAlive.start();
      this.engageLimiter();
      if (this.eq.length > 0) this.setEq(this.eq);
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  /**
   * Applies equaliser gains, in decibels, one per band.
   *
   * Ramped rather than set: a step change in filter gain is audible as a click
   * on its own, which is the opposite of what an equaliser is for.
   */
  setEq(gains: number[]) {
    this.eq = gains;
    if (!this.ctx) return;
    this.bands.forEach((f, i) => {
      const db = Math.max(-12, Math.min(12, gains[i] ?? 0));
      f.gain.setTargetAtTime(db, this.ctx!.currentTime, 0.05);
    });
  }

  get available(): boolean {
    return this.ctx !== null;
  }

  resume() {
    void this.ctx?.resume();
  }

  /**
   * Attaches an element to the graph, once.
   *
   * createMediaElementSource can only be called once per element, and calling
   * it twice throws and takes the element's audio with it — hence the map.
   */
  private gainFor(el: HTMLAudioElement): GainNode | null {
    if (!this.ctx || !this.master) return null;
    const existing = this.gains.get(el);
    if (existing) return existing;
    try {
      const source = this.ctx.createMediaElementSource(el);
      // From here the graph sets the level. A volume the element was given
      // while there was no graph (0 for a preloaded deck) would otherwise
      // stay underneath it and silence the track.
      el.volume = 1;
      const norm = this.ctx.createGain();
      const gain = this.ctx.createGain();
      source.connect(norm).connect(gain).connect(this.master);
      this.norms.set(el, norm);
      this.gains.set(el, gain);
      // A correction that arrived before the graph existed applies now.
      const wanted = this.wantedGainDb.get(el);
      if (wanted !== undefined) norm.gain.value = Math.pow(10, wanted / 20);
      return gain;
    } catch {
      return null;
    }
  }

  /**
   * Sets a deck's replay gain, in decibels.
   *
   * Applied per deck rather than to the master because during a crossfade two
   * tracks with different loudness are audible at once, and one correction
   * cannot be right for both.
   *
   * Ramped over a few milliseconds rather than stepped: the node may already
   * be passing audio when a correction arrives, and a discontinuity in gain
   * is a click.
   */
  setTrackGainDb(el: HTMLAudioElement, db: number) {
    // Recorded first and unconditionally, so a correction that arrives before
    // the graph exists is not lost — gainFor adopts it when it builds the node.
    this.wantedGainDb.set(el, db);
    this.gainFor(el);
    const norm = this.norms.get(el);
    if (!norm || !this.ctx) return;
    const linear = Math.pow(10, db / 20);
    norm.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.01);
  }

  /** Whether a deck is carrying a correction, so the fallback can stand down. */
  hasTrackGain(el: HTMLAudioElement): boolean {
    return this.norms.has(el);
  }

  /** Removes every correction, for when normalisation is turned off. */
  clearTrackGains(decks: HTMLAudioElement[]) {
    for (const el of decks) {
      // Forget the intent too, or a deck would silently pick its old
      // correction back up the next time the graph was rebuilt.
      this.wantedGainDb.delete(el);
      if (!this.ctx) continue;
      this.norms.get(el)?.gain.setTargetAtTime(1, this.ctx.currentTime, 0.05);
    }
  }

  /**
   * Routes a deck into the graph at the given level, unless it is already.
   *
   * A deck given its track before the graph existed — the last track,
   * restored paused when the app opens — plays straight to the output
   * otherwise, where the volume, normalisation and EQ cannot reach it.
   */
  adopt(el: HTMLAudioElement, level: number) {
    if (!this.ctx || this.gains.has(el)) return;
    this.set(el, level);
  }

  /** Sets a deck's level immediately, cancelling any fade in progress. */
  set(el: HTMLAudioElement, value: number) {
    const gain = this.gainFor(el);
    if (!gain || !this.ctx) {
      // No graph: the element's own volume is the only control available.
      el.volume = Math.max(0, Math.min(1, value));
      return;
    }
    gain.gain.cancelScheduledValues(this.ctx.currentTime);
    gain.gain.setValueAtTime(value, this.ctx.currentTime);
  }

  /** Master volume, applied after any crossfade or levelling. */
  setMaster(value: number) {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
  }

  /**
   * Crossfades between two decks over a duration.
   *
   * Equal-power rather than linear: two linear ramps sum to a noticeable dip
   * in the middle, because power goes as the square of amplitude. Curves of
   * cos and sin hold the total constant, which is why a crossfade done this
   * way sounds like one track becoming another rather than a dip between them.
   */
  crossfade(from: HTMLAudioElement, to: HTMLAudioElement, ms: number, toLevel: number) {
    const fromGain = this.gainFor(from);
    const toGain = this.gainFor(to);
    if (!this.ctx || !fromGain || !toGain) {
      // Without a graph a crossfade is not possible; cut instead of stalling.
      from.volume = 0;
      to.volume = toLevel;
      return;
    }

    const now = this.ctx.currentTime;
    const seconds = Math.max(0.02, ms / 1000);
    const steps = 64;
    const out = new Float32Array(steps);
    const into = new Float32Array(steps);
    for (let i = 0; i < steps; i += 1) {
      const t = (i / (steps - 1)) * (Math.PI / 2);
      out[i] = Math.cos(t) * toLevel;
      into[i] = Math.sin(t) * toLevel;
    }

    for (const [gain, curve] of [
      [fromGain, out],
      [toGain, into],
    ] as const) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueCurveAtTime(curve, now, seconds);
    }
  }

  /**
   * Evens out loudness by measuring, for tracks that do not report theirs.
   *
   * This is the fallback, not the mechanism. Most tracks carry an integrated
   * loudness in their player response, and `setTrackGainDb` applies the exact
   * correction before a sample plays. When that figure is missing this
   * measures what is coming out and corrects slowly toward a reference
   * instead — which cannot act before a track starts, and deliberately moves
   * too slowly to flatten the dynamics inside a song.
   */
  setLevelling(on: boolean) {
    if (!on) {
      this.levelGain = 1;
      if (this.master && this.ctx) {
        this.master.gain.setTargetAtTime(this.baseVolume, this.ctx.currentTime, 0.2);
      }
      if (this.levelTimer !== undefined) {
        clearInterval(this.levelTimer);
        this.levelTimer = undefined;
      }
      return;
    }
    if (this.levelTimer !== undefined) return;
    this.levelTimer = window.setInterval(() => this.measure(), 250);
  }

  private baseVolume = 1;

  /**
   * Remembers the user's volume so levelling multiplies rather than replaces it.
   *
   * The position is tapered here rather than by the caller, so the slider, the
   * session and the keyboard shortcuts all keep dealing in 0..1 positions and
   * only the audio graph sees a gain.
   */
  private engageLimiter() {
    if (!this.limiter) return;
    this.limiter.ratio.value = this.baseVolume > 1 ? 20 : 1;
  }

  setBaseVolume(v: number) {
    this.baseVolume = perceptualGain(v);
    this.engageLimiter();
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(this.baseVolume * this.levelGain, this.ctx.currentTime, 0.02);
  }

  private measure() {
    if (!this.analyser || !this.ctx || !this.master) return;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);

    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) sum += buf[i]! * buf[i]!;
    const rms = Math.sqrt(sum / buf.length);
    // Silence and near-silence carry no information about loudness.
    if (rms < 0.005) return;

    // A reference a little below full scale, so a correction upward has
    // somewhere to go without clipping.
    const target = 0.12;
    const wanted = Math.max(0.6, Math.min(1.8, target / rms));
    // Move a fraction of the way each tick: a leveller that reacts quickly
    // pumps, which is more objectionable than the loudness difference.
    this.levelGain += (wanted - this.levelGain) * 0.06;
    this.master.gain.setTargetAtTime(
      this.baseVolume * this.levelGain,
      this.ctx.currentTime,
      0.5,
    );
  }

  /**
   * The current output level, for diagnostics.
   *
   * Reading the graph is the only way to tell an inaudible volume change from
   * one that merely updated a number: the session can record a new volume
   * while the audio element plays straight past the mixer.
   */
  debugLevel(decks: HTMLAudioElement[] = []): {
    master: number;
    rms: number;
    replayGain: number[];
    fades: number[];
    routed: boolean[];
  } | null {
    if (!this.analyser || !this.master) return null;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) sum += buf[i]! * buf[i]!;
    return {
      master: this.master.gain.value,
      rms: Math.sqrt(sum / buf.length),
      // Per deck, because the correction is per track: during a crossfade the
      // two differ, and a single number could not show that.
      replayGain: decks.map((el) => this.norms.get(el)?.gain.value ?? 1),
      // Each deck's crossfade gain: during a crossfade both are audible.
      fades: decks.map((el) => this.gains.get(el)?.gain.value ?? 0),
      // Whether each deck plays through the graph, where volume reaches it.
      routed: decks.map((el) => this.gains.has(el)),
    };
  }

  destroy() {
    if (this.levelTimer !== undefined) clearInterval(this.levelTimer);
    void this.ctx?.close();
    this.ctx = null;
  }
}
