const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../ui/node_modules/typescript');

function load(file, context) {
  const source = fs.readFileSync(path.join(__dirname, '../../ui/src/lib', file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Promise, Math, Number, JSON, Map, Set, Error, String, ...context });
  return module.exports;
}

const flush = () => new Promise((r) => setImmediate(r));

test('the failure ladder counts distinct tracks, falls back at the threshold, and retries native later', () => {
  let now = 0;
  const { failureLadder } = load('fallback.ts', {});
  const ladder = failureLadder(2, 60_000, () => now);
  assert.equal(ladder.failed(1), 'counted');
  // One dead track reported many times is still one failure.
  for (let i = 0; i < 20; i++) assert.equal(ladder.failed(1), 'duplicate');
  assert.equal(ladder.fellBack, false);
  assert.equal(ladder.failed(2), 'fallback');
  assert.equal(ladder.fellBack, true);
  assert.equal(ladder.failed(3), 'counted', 'already fallen back');
  assert.equal(ladder.retryNative(), false, 'too soon');
  now = 60_000;
  assert.equal(ladder.retryNative(), true);
  assert.equal(ladder.fellBack, false);
  assert.equal(ladder.retryNative(), false);

  // A report for a track other than the one now meant to play is stale.
  const stale = failureLadder(2, 60_000, () => now);
  assert.equal(stale.failed(4, 5), 'stale');
  assert.equal(stale.failed(5, 5), 'counted');
  assert.equal(stale.failed(3, 6), 'stale');
  assert.equal(stale.fellBack, false, 'a stale preload failure does not tip it over');
  assert.equal(stale.failed(6, 6), 'fallback');

  const fresh = failureLadder(2, 60_000, () => now);
  fresh.failed(1);
  fresh.loaded();
  assert.equal(fresh.failed(2), 'counted', 'a track that loads ends the run');
});

function nativeHarness(options = {}) {
  const clock = { now: 0 };
  const timeouts = [];
  const intervals = [];
  const events = [];
  const decks = [];
  class FakeAudio {
    constructor() {
      Object.assign(this, { src: '', paused: true, currentTime: 0, duration: NaN, error: null, readyState: 0, listeners: {}, playCalls: 0 });
      this.rejectWith = null;
      decks.push(this);
    }
    addEventListener(kind, fn) { (this.listeners[kind] ??= []).push(fn); }
    fire(kind) { for (const fn of this.listeners[kind] ?? []) fn(); }
    play() {
      this.playCalls += 1;
      if (this.rejectWith) return Promise.reject(Object.assign(new Error(this.rejectWith), { name: this.rejectWith }));
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    removeAttribute(k) { this[k] = ''; }
    load() {}
  }
  const noop = () => {};
  const mixer = new Proxy({ available: true }, { get: (t, k) => (k in t ? t[k] : noop) });
  const engine = load('engine.ts', {
    Audio: FakeAudio,
    MediaError: { MEDIA_ERR_ABORTED: 1 },
    performance: { now: () => clock.now },
    window: { setInterval: (fn) => (intervals.push(fn), 1), clearInterval: noop, setTimeout: (fn) => timeouts.push(fn), clearTimeout: noop },
    setInterval: () => 1, clearInterval: noop, setTimeout: () => 1, clearTimeout: noop,
    fetch: async () => ({ ok: true, json: async () => ({ rateLimited: false }) }),
    console: { info: noop, warn: noop, debug: noop },
    require(name) {
      if (name === './base') return { apiUrl: (p) => p };
      if (name === './decks') return { Mixer: function Mixer() { return mixer; }, perceptualGain: (v) => v };
      if (name === './silence') return { audibleEdges: options.audibleEdges ?? (async () => null) };
      throw new Error(name);
    },
  });
  const native = new engine.NativeEngine((e) => events.push(e));
  const target = (over = {}) => ({ epoch: 1, videoId: 'dead1234567', startAtMs: 0, playing: true, preloadVideoId: null, volume: 1, transition: { kind: 'gapless' }, ...over });
  const runTimeouts = () => { for (const fn of timeouts.splice(0)) fn(); };
  const tick = (ms = 250) => { clock.now += ms; for (const fn of intervals) fn(); };
  return { native, decks, events, target, clock, runTimeouts, tick, failures: () => events.filter((e) => e.kind === 'failed') };
}

test('a dead track is reported once, however many reconciles reject play()', async () => {
  const h = nativeHarness();
  h.native.apply(h.target());
  const deck = h.decks.find((d) => d.src.includes('dead1234567'));
  assert.ok(deck, 'the track was loaded');
  // The load fails: the element holds an error and every play() rejects.
  deck.error = { code: 4 };
  deck.rejectWith = 'NotSupportedError';
  // The core's projections keep reconciling while it is "playing".
  for (let i = 0; i < 20; i++) h.native.apply(h.target({ volume: 1 - i / 100 }));
  await flush();
  assert.equal(h.failures().length, 0, 'play() rejections leave the failure to the error listener');
  // The element's error event: retried twice, then reported.
  deck.fire('error'); deck.fire('error'); deck.fire('error');
  await flush();
  for (let i = 0; i < 5; i++) { deck.fire('error'); h.native.apply(h.target()); }
  await flush();
  assert.equal(h.failures().length, 1);
  assert.equal(h.failures()[0].epoch, 1);
});

test('a NotSupportedError with no error event after it is still reported, once', async () => {
  const h = nativeHarness();
  h.native.apply(h.target());
  const deck = h.decks.find((d) => d.src.includes('dead1234567'));
  deck.rejectWith = 'NotSupportedError';
  for (let i = 0; i < 5; i++) h.native.apply(h.target({ volume: 0.5 + i / 10 }));
  await flush();
  assert.equal(h.failures().length, 0, 'waits for the element first');
  h.runTimeouts();
  await flush();
  assert.deepEqual(h.failures().map((e) => [e.epoch, e.reason]), [[1, 'NotSupportedError']]);
});

test('a NotSupportedError that the error listener answers is not reported twice', async () => {
  const h = nativeHarness();
  h.native.apply(h.target());
  const deck = h.decks.find((d) => d.src.includes('dead1234567'));
  deck.rejectWith = 'NotSupportedError';
  h.native.apply(h.target({ volume: 0.4 }));
  await flush();
  deck.error = { code: 4 };
  for (let i = 0; i < 3; i++) deck.fire('error');
  await flush();
  h.runTimeouts();
  await flush();
  assert.equal(h.failures().length, 1);
});

test('pressing play again on a failed track loads it afresh and can report again', async () => {
  const h = nativeHarness();
  h.native.apply(h.target());
  const deck = h.decks.find((d) => d.src.includes('dead1234567'));
  deck.error = { code: 4 };
  deck.rejectWith = 'NotSupportedError';
  for (let i = 0; i < 3; i++) deck.fire('error');
  await flush();
  assert.equal(h.failures().length, 1);
  // The core paused it; the listener presses play on the same track.
  h.native.apply(h.target({ playing: false }));
  deck.src = 'stale';
  deck.src = '/v1/stream/dead1234567?retry=2';
  h.native.apply(h.target({ playing: true }));
  assert.equal(deck.src, '/v1/stream/dead1234567', 'a fresh request rather than the dead element');
  for (let i = 0; i < 3; i++) deck.fire('error');
  await flush();
  assert.equal(h.failures().length, 2);
});

test('other play() rejections are still failures, once per track', async () => {
  const h = nativeHarness();
  h.native.apply(h.target());
  const deck = h.decks.find((d) => d.src.includes('dead1234567'));
  deck.rejectWith = 'SomethingElse';
  for (let i = 0; i < 5; i++) h.native.apply(h.target({ volume: 0.5 + i / 10 }));
  await flush();
  assert.equal(h.failures().length, 1);
  // A different track (new epoch) reports on its own.
  h.native.apply(h.target({ epoch: 2, videoId: 'next1234567' }));
  const next = h.decks.find((d) => d.src.includes('next1234567'));
  next.rejectWith = 'SomethingElse';
  h.native.apply(h.target({ epoch: 2, videoId: 'next1234567', volume: 0.3 }));
  await flush();
  assert.deepEqual(h.failures().map((e) => e.epoch), [1, 2]);
});

test('a seek that never lands counts as a stall, so a refused range cannot hang playback', async () => {
  const h = nativeHarness();
  h.native.apply(h.target({ videoId: 'live1234567' }));
  const deck = h.decks.find((d) => d.src.includes('live1234567'));
  deck.paused = false;
  deck.currentTime = 64.6;
  deck.seeking = true;
  const tick = () => h.native.watchForStall(deck);
  tick();
  // Each 20s without movement: two retries, each seeking back to 64.6s...
  for (let i = 0; i < 2; i++) {
    h.clock.now += 21_000; tick();
    deck.paused = false; deck.seeking = true; deck.currentTime = 64.6;
  }
  assert.equal(h.failures().length, 0);
  // ...and then it is the track.
  h.clock.now += 21_000; tick();
  await flush();
  assert.deepEqual(h.failures().map((e) => e.reason), ['stalled']);
});

function embeddedHarness() {
  const events = [];
  const timers = new Map();
  let nextTimer = 1;
  const calls = [];
  let handlers = null;
  class Player {
    constructor(_el, opts) { handlers = opts.events; }
    loadVideoById(o) { calls.push(['load', o.videoId]); }
    cueVideoById(o) { calls.push(['cue', o.videoId]); }
    playVideo() { calls.push(['play']); }
    pauseVideo() { calls.push(['pause']); }
    setVolume() {}
    seekTo() {}
    getCurrentTime() { return 0; }
    getDuration() { return 200; }
    getAvailablePlaybackRates() { return [0.5, 1, 1.5, 2]; }
    getPlaybackRate() { return 1; }
    setPlaybackRate() {}
    destroy() {}
  }
  const el = () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} });
  const window = {
    YT: { Player },
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => 0,
    clearInterval: () => {},
  };
  const document = { createElement: el, body: el(), head: { appendChild(s) { window.onYouTubeIframeAPIReady?.(); } } };
  const mod = load('embedded.ts', {
    window, document, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, Object,
    require(name) {
      if (name === './speed') return { MIN_SPEED: 0.5, MAX_SPEED: 3 };
      throw new Error(name);
    },
  });
  const engine = new mod.EmbeddedEngine((e) => events.push(e));
  const target = (over = {}) => ({ epoch: 1, videoId: 'vid12345678', startAtMs: 0, playing: true, preloadVideoId: null, volume: 1, transition: { kind: 'gapless' }, ...over });
  return { engine, events, calls, timers, ready: () => handlers.onReady(), handlers: () => handlers, target, failures: () => events.filter((e) => e.kind === 'failed') };
}

test('embedded: a target that arrives before the player is ready is still loaded', async () => {
  const h = embeddedHarness();
  h.engine.apply(h.target());
  await flush();
  h.ready();
  assert.deepEqual(h.calls.slice(0, 2), [['load', 'vid12345678'], ['play']]);
});

test('embedded: errors are reported once per track, and a track that never starts fails', async () => {
  const h = embeddedHarness();
  await flush();
  h.ready();
  h.engine.apply(h.target());
  h.handlers().onError({ data: 150 });
  h.handlers().onError({ data: 150 });
  assert.equal(h.failures().length, 1);
  // A new track that neither plays nor errors: the start watchdog reports it.
  h.engine.apply(h.target({ epoch: 2, videoId: 'silent12345' }));
  assert.equal(h.calls.at(-2)[1], 'silent12345');
  for (const [id, fn] of [...h.timers]) { h.timers.delete(id); fn(); }
  assert.deepEqual(h.failures().map((e) => [e.epoch, e.reason]), [[1, 'player_error_150'], [2, 'embedded_no_start']]);
  // The same video again under a new epoch (a retry) is watched under that epoch.
  h.engine.apply(h.target({ epoch: 3, videoId: 'silent12345' }));
  for (const [id, fn] of [...h.timers]) { h.timers.delete(id); fn(); }
  assert.deepEqual([h.failures().at(-1).epoch, h.failures().at(-1).reason], [3, 'embedded_no_start']);
  // One that starts disarms it.
  h.engine.apply(h.target({ epoch: 4, videoId: 'plays123456' }));
  h.handlers().onStateChange({ data: 1 });
  assert.equal(h.timers.size, 0);
});

test('a failing preload of the next track is retried twice at most, later each time', async () => {
  const h = nativeHarness();
  const preloads = () => h.decks.reduce((n, d) => n + (d.pointed ?? 0), 0);
  // Count every time a deck is pointed at the next track's preload URL.
  for (const d of h.decks) {
    let src = d.src;
    Object.defineProperty(d, 'src', {
      get: () => src,
      set: (v) => { src = v; if (String(v).includes('next1234567')) d.pointed = (d.pointed ?? 0) + 1; },
    });
  }
  const t = h.target({ videoId: 'live1234567', preloadVideoId: 'next1234567' });
  h.native.apply(t);
  assert.equal(preloads(), 1, 'the next track is warmed');
  const idle = h.decks.find((d) => d.src.includes('next1234567'));
  // Every attempt is refused. The core keeps reconciling meanwhile.
  for (let round = 0; round < 10; round++) {
    idle.error = { code: 4 };
    idle.fire('error');
    for (let i = 0; i < 20; i++) h.native.apply({ ...t, volume: 1 - i / 100 });
    h.clock.now += 60_000;
    h.runTimeouts();
    await flush();
  }
  assert.equal(preloads(), 3, 'one warm-up and two retries, then no more');
  assert.equal(h.failures().length, 0, 'a failed preload is not the playing track failing');
});

test('a silence measurement that keeps missing is asked for a few times, not every reconcile', async () => {
  const asked = [];
  const h = nativeHarness({ audibleEdges: async (id) => { asked.push(id); return null; } });
  // Measured for crossfades: where the sound ends and the next one begins.
  const t = h.target({ videoId: 'live1234567', preloadVideoId: 'next1234567', transition: { kind: 'crossfade', durationMs: 5000 } });
  for (let round = 0; round < 20; round++) {
    // The core re-applies its target many times a minute.
    for (let i = 0; i < 10; i++) h.native.apply({ ...t, volume: 1 - i / 100 });
    await flush();
    h.clock.now += 60_000;
    h.runTimeouts();
    await flush();
  }
  const perTrack = (id) => asked.filter((x) => x === id).length;
  // One first ask and three retries (EDGE_RETRY_MS), then no more.
  assert.equal(perTrack('live1234567'), 4);
  assert.equal(perTrack('next1234567'), 4);
});

// Plays for a while, then the connection dies: currentTime stops moving.
function playThenFreeze(h, id, seconds) {
  h.native.apply(h.target({ videoId: id }));
  const deck = h.decks.find((d) => d.src.includes(id));
  deck.paused = false;
  for (let i = 1; i <= seconds * 4; i++) { deck.currentTime = i / 4; h.tick(); }
  return deck;
}

test('a deck that stops moving says it is buffering at once, and reports no frozen positions', async () => {
  const h = nativeHarness();
  const deck = playThenFreeze(h, 'froz1234567', 59);
  const mark = h.events.length;
  // 1.5 s without movement: one "stalled", and no position reports after it.
  for (let i = 0; i < 6; i++) h.tick();
  const after = h.events.slice(mark);
  const stalled = after.findIndex((e) => e.kind === 'stalled');
  assert.ok(stalled >= 0, 'buffering reported');
  assert.ok(after.filter((e) => e.kind === 'stalled').length === 1);
  for (let i = 0; i < 8; i++) h.tick();
  assert.equal(h.events.slice(mark + stalled + 1).filter((e) => e.kind === 'position').length, 0);
  // It moves again: positions resume, so the core goes back to "playing".
  deck.currentTime = 59.5; h.tick();
  assert.equal(h.events.at(-1).kind, 'position');
  assert.equal(h.events.at(-1).positionMs, 59500);
});

test('a stream that dies mid-track fails in about twenty seconds, not a minute', async () => {
  const h = nativeHarness();
  const deck = playThenFreeze(h, 'dies1234567', 59);
  const frozeAt = h.clock.now;
  const reloads = [];
  let failedAt = null;
  while (h.clock.now - frozeAt < 60_000 && failedAt === null) {
    const src = deck.src;
    h.tick();
    // A retry reloads the same track; its range is refused, so it never moves.
    if (deck.src !== src) { reloads.push(h.clock.now - frozeAt); deck.paused = false; deck.currentTime = 59; }
    await flush();
    if (h.failures().length) failedAt = h.clock.now - frozeAt;
  }
  assert.equal(reloads.length, 2, 'picked up again twice first');
  assert.ok(reloads[0] <= 6_500, `first retry after ${reloads[0]} ms`);
  assert.ok(failedAt !== null && failedAt <= 21_000, `failed after ${failedAt} ms`);
  assert.deepEqual(h.failures().map((e) => e.reason), ['stalled']);
});

test('a slow first load is given time before it counts as stalled', async () => {
  const h = nativeHarness();
  h.native.apply(h.target({ videoId: 'slow1234567' }));
  const deck = h.decks.find((d) => d.src.includes('slow1234567'));
  deck.paused = false;
  const src = deck.src;
  // Twelve seconds with no first byte: buffering, but not retried or failed.
  for (let i = 0; i < 48; i++) h.tick();
  await flush();
  assert.ok(h.events.some((e) => e.kind === 'stalled'));
  assert.equal(deck.src, src, 'not reloaded yet');
  assert.equal(h.failures().length, 0);
  // Then it starts.
  deck.currentTime = 0.25; h.tick();
  assert.equal(h.events.at(-1).kind, 'position');
});

test('a track that never starts is retried once, patiently, and fails in about half a minute', async () => {
  const h = nativeHarness();
  h.native.apply(h.target({ videoId: 'none1234567' }));
  const deck = h.decks.find((d) => d.src.includes('none1234567'));
  deck.paused = false;
  const start = h.clock.now;
  let reloads = 0;
  let failedAt = null;
  while (h.clock.now - start < 60_000 && failedAt === null) {
    const src = deck.src;
    h.tick();
    if (deck.src !== src) { reloads++; deck.paused = false; }
    await flush();
    if (h.failures().length) failedAt = h.clock.now - start;
  }
  assert.equal(reloads, 1);
  assert.ok(failedAt !== null && failedAt >= 29_000 && failedAt <= 31_000, `failed after ${failedAt} ms`);
});

// A browser reload: the element drops to 0 and paused until metadata arrives.
function reloadLikeABrowser(deck) { deck.currentTime = 0; deck.paused = true; }

test('a retry whose reload hangs keeps the position, and never reports 0', async () => {
  const h = nativeHarness();
  const deck = playThenFreeze(h, 'hang1234567', 59);
  const frozeAt = h.clock.now;
  const mark = h.events.length;
  const reloads = [];
  while (h.clock.now - frozeAt < 40_000 && !h.failures().length) {
    const src = deck.src;
    h.tick();
    if (deck.src !== src) { reloads.push(h.clock.now - frozeAt); reloadLikeABrowser(deck); }
    await flush();
  }
  const positions = h.events.slice(mark).filter((e) => e.kind === 'position');
  assert.equal(positions.filter((e) => e.positionMs === 0).length, 0, "the reload's 0 was reported");
  assert.equal(reloads.length, 2);
  // The second window is a retry's (7 s), not a fresh mid-track one (6 s).
  assert.ok(reloads[1] - reloads[0] >= 7_000, `second retry after ${reloads[1] - reloads[0]} ms`);
  assert.equal(h.failures().length, 1);
  // Had the metadata arrived, it would have picked the track up at 59 s.
  deck.fire('loadedmetadata');
  assert.equal(deck.currentTime, 59);
});

test('creeping at the buffered edge is not the music coming back', async () => {
  const h = nativeHarness();
  const deck = playThenFreeze(h, 'edge1234567', 62);
  deck.currentTime = 62.909; h.tick();
  const mark = h.events.length;
  for (let i = 0; i < 8; i++) h.tick();
  assert.ok(h.events.slice(mark).some((e) => e.kind === 'stalled'));
  const shown = h.events.length;
  deck.currentTime = 62.973; h.tick(); h.tick();
  assert.equal(h.events.slice(shown).filter((e) => e.kind === 'position').length, 0);
  deck.currentTime = 63.4; h.tick();
  assert.equal(h.events.at(-1).kind, 'position');
});

test('a track that plays on after a retry gets its retries back', async () => {
  const h = nativeHarness();
  const deck = playThenFreeze(h, 'back1234567', 30);
  // Drops out, is picked up, and plays on for a while.
  let src = deck.src;
  while (deck.src === src) h.tick();
  deck.fire('loadedmetadata');
  deck.paused = false;
  for (let i = 1; i <= 12 * 4; i++) { deck.currentTime = 30 + i / 4; h.tick(); }
  // A second outage later still gets two retries before failing.
  const frozeAt = h.clock.now;
  let reloads = 0;
  while (h.clock.now - frozeAt < 40_000 && !h.failures().length) {
    src = deck.src;
    h.tick();
    if (deck.src !== src) { reloads++; reloadLikeABrowser(deck); }
    await flush();
  }
  assert.equal(reloads, 2);
  assert.equal(h.failures().length, 1);
});
