const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../ui/node_modules/typescript');

// Transpiles a ui/src/lib module and runs it with its imports stubbed.
function load(file, modules = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../ui/src/lib', file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const require = (name) => {
    if (name in modules) return modules[name];
    throw new Error(`unexpected import ${name}`);
  };
  vm.runInNewContext(code, { module, exports: module.exports, require, Set, Map, Promise, Error, Number, Math, JSON, ...globals });
  return module.exports;
}

const plain = (v) => JSON.parse(JSON.stringify(v));

test('recent searches: the account first, duplicates once without case, capped', () => {
  const { mergeSearches } = load('searchmerge.ts');
  const account = [
    { query: 'Daft Punk', token: 'T1' },
    { query: 'nils frahm', token: 'T2' },
  ];
  // The newest local search is already in the account's list.
  const got = plain(mergeSearches(account, ['daft punk', 'Bonobo', 'NILS FRAHM']));
  assert.deepEqual(got, [
    { query: 'Daft Punk', token: 'T1', local: true },
    { query: 'nils frahm', token: 'T2', local: true },
    { query: 'Bonobo', local: true },
  ]);

  const many = Array.from({ length: 20 }, (_, i) => ({ query: `q${i}`, token: `t${i}` }));
  assert.equal(mergeSearches(many, ['x', 'y']).length, 10);
  assert.equal(mergeSearches(many, [], 3).length, 3);
});

test('a search just made here, not yet in the kept account list, comes first', () => {
  const { mergeSearches } = load('searchmerge.ts');
  const got = plain(mergeSearches([{ query: 'older', token: 'T1' }], ['just now', 'older', 'local only']));
  assert.deepEqual(got.map((r) => r.query), ['just now', 'older', 'local only']);
  assert.equal(got[0].token, undefined);
  assert.equal(got[1].token, 'T1');
});

test('signed out, the list is only this device’s', () => {
  const { mergeSearches } = load('searchmerge.ts');
  const got = plain(mergeSearches([], ['a', 'b']));
  assert.deepEqual(got, [{ query: 'a', local: true }, { query: 'b', local: true }]);
});

test('removing an account search posts its token to the core', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 204, headers: { get: () => null }, json: async () => ({}) };
  };
  const base = { apiUrl: (p) => `http://core${p}`, API_BASE: 'http://core/v1' };
  const { api } = load('api.ts', { './base': base }, { fetch });
  await api.forgetSearches(['T1']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://core/v1/me/search-history/forget');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { tokens: ['T1'] });

  await api.searchHistory();
  await api.remoteQueue();
  assert.deepEqual(calls.slice(1).map((c) => c.url), ['http://core/v1/me/search-history', 'http://core/v1/me/remote-queue']);
});

function remoteHarness(answer) {
  const played = [];
  const toasts = [];
  const { continueFromRemote } = load('remotequeue.ts');
  const run = () => continueFromRemote({
    fetchQueue: typeof answer === 'function' ? answer : async () => answer,
    play: (tracks, index, origin) => played.push(plain({ ids: tracks.map((t) => t.id), index, origin })),
    toast: (m) => toasts.push(m),
  });
  return { run, played, toasts };
}

const track = (id, playable = true) => ({ id, title: id, playable });

test('the remote queue replaces this one, starting where the other device was', async () => {
  const h = remoteHarness({ tracks: [track('a'), track('b'), track('c')], index: 1, title: 'Liked Music' });
  assert.equal(await h.run(), 'played');
  assert.deepEqual(h.played, [{ ids: ['a', 'b', 'c'], index: 1, origin: 'Liked Music' }]);
  assert.deepEqual(h.toasts, []);
});

test('unplayable entries are left out, and the start moves to the next playable one', async () => {
  const h = remoteHarness({ tracks: [track('a'), track('x', false), track('b', false), track('c')], index: 1 });
  await h.run();
  assert.deepEqual(h.played, [{ ids: ['a', 'c'], index: 1, origin: 'YouTube Music' }]);

  const tail = remoteHarness({ tracks: [track('a'), track('z', false)], index: 1 });
  await tail.run();
  assert.deepEqual(tail.played, [{ ids: ['a'], index: 0, origin: 'YouTube Music' }]);
});

test('an empty or failed read says so and leaves the queue alone', async () => {
  const empty = remoteHarness({ tracks: [], index: 0 });
  assert.equal(await empty.run(), 'empty');
  assert.equal(empty.played.length, 0);
  assert.match(empty.toasts[0], /Nothing is queued/);

  const failed = remoteHarness(async () => { throw Object.assign(new Error('bad gateway'), { status: 502 }); });
  assert.equal(await failed.run(), 'failed');
  assert.equal(failed.played.length, 0);
  assert.match(failed.toasts[0], /Couldn't read your queue/);

  const limited = remoteHarness(async () => { throw Object.assign(new Error('slow down'), { status: 429 }); });
  await limited.run();
  assert.match(limited.toasts[0], /limiting requests/);
});

function launchHarness(answer, { idle = [true, true], current } = {}) {
  const loaded = [];
  const toasts = [];
  const idles = [...idle];
  const { continueOnLaunch } = load('remotequeue.ts');
  const run = () => continueOnLaunch({
    fetchQueue: typeof answer === 'function' ? answer : async () => answer,
    idle: async () => (idles.length ? idles.shift() : true),
    currentId: () => current,
    load: async (tracks, index, origin) => { loaded.push(plain({ ids: tracks.map((t) => t.id), index, origin })); return true; },
    toast: (m) => toasts.push(m),
  });
  return { run, loaded, toasts };
}

test('at launch the remote queue is loaded where the other device was, with a note', async () => {
  const h = launchHarness({ tracks: [track('a'), track('b')], index: 1, title: 'Mix' });
  assert.equal(await h.run(), 'loaded');
  assert.deepEqual(h.loaded, [{ ids: ['a', 'b'], index: 1, origin: 'Mix' }]);
  assert.match(h.toasts[0], /Picked up your queue/);
});

test('at launch nothing is asked or changed while something is playing here', async () => {
  let asked = 0;
  const h = launchHarness(async () => { asked++; return { tracks: [track('a')], index: 0 }; }, { idle: [false] });
  assert.equal(await h.run(), 'busy');
  assert.equal(asked, 0);
  // Started playing while the queue was being read: left alone.
  const late = launchHarness({ tracks: [track('a')], index: 0 }, { idle: [true, false] });
  assert.equal(await late.run(), 'busy');
  assert.equal(late.loaded.length, 0);
});

test('at launch a failed, empty or same-song read changes nothing and says nothing', async () => {
  const failed = launchHarness(async () => { throw Object.assign(new Error('x'), { status: 429 }); });
  assert.equal(await failed.run(), 'failed');
  const empty = launchHarness({ tracks: [], index: 0 });
  assert.equal(await empty.run(), 'empty');
  const same = launchHarness({ tracks: [track('a'), track('b')], index: 1 }, { current: 'b' });
  assert.equal(await same.run(), 'same');
  for (const h of [failed, empty, same]) {
    assert.equal(h.loaded.length, 0);
    assert.deepEqual(h.toasts, []);
  }
});
