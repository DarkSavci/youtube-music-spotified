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

  const fresh = failureLadder(2, 60_000, () => now);
  fresh.failed(1);
  fresh.loaded();
  assert.equal(fresh.failed(2), 'counted', 'a track that loads ends the run');
});

function nativeHarness() {
  const clock = { now: 0 };
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
    window: { setInterval: () => 1, clearInterval: noop, setTimeout: () => 1, clearTimeout: noop },
    setInterval: () => 1, clearInterval: noop, setTimeout: () => 1, clearTimeout: noop,
    fetch: async () => ({ ok: true, json: async () => ({ rateLimited: false }) }),
    console: { info: noop, warn: noop, debug: noop },
    require(name) {
      if (name === './base') return { apiUrl: (p) => p };
      if (name === './decks') return { Mixer: function Mixer() { return mixer; }, perceptualGain: (v) => v };
      if (name === './silence') return { audibleEdges: async () => null };
      throw new Error(name);
    },
  });
  const native = new engine.NativeEngine((e) => events.push(e));
  const target = (over = {}) => ({ epoch: 1, videoId: 'dead1234567', startAtMs: 0, playing: true, preloadVideoId: null, volume: 1, transition: { kind: 'gapless' }, ...over });
  return { native, decks, events, target, clock, failures: () => events.filter((e) => e.kind === 'failed') };
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
  // One that starts disarms it.
  h.engine.apply(h.target({ epoch: 3, videoId: 'plays123456' }));
  h.handlers().onStateChange({ data: 1 });
  assert.equal(h.timers.size, 0);
});
