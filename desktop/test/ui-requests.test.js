const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../ui/node_modules/typescript');
const queryCore = require('../../ui/node_modules/@tanstack/query-core');

// Transpiles a ui/src/lib module and runs it with its imports stubbed.
function load(file, modules = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../ui/src/lib', file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const require = (name) => {
    if (name in modules) return modules[name];
    throw new Error(`unexpected import ${name}`);
  };
  vm.runInNewContext(code, { module, exports: module.exports, require, Set, Map, Promise, Error, Number, Date, ...globals });
  return module.exports;
}

const base = { apiUrl: (p) => `http://core${p}`, API_BASE: 'http://core/v1' };

test('failures YouTube caused are never retried; others get one more try', () => {
  const { ApiError, shouldRetry } = load('api.ts', { './base': base });
  assert.equal(shouldRetry(0, new ApiError('slow down', 429)), false);
  assert.equal(shouldRetry(0, new ApiError('upstream', 502)), false);
  assert.equal(shouldRetry(0, new ApiError('signed out', 401, true)), false);
  assert.equal(shouldRetry(0, new ApiError('not found', 404)), true);
  assert.equal(shouldRetry(1, new ApiError('not found', 404)), false);
  // Offline (the core unreachable) is worth one more try too.
  assert.equal(shouldRetry(0, new ApiError('offline', 0)), true);
  assert.equal(new ApiError('slow down', 429).rateLimited, true);
});

test('a 429 carries its Retry-After', async () => {
  const fetch = async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    headers: { get: (h) => (h === 'Retry-After' ? '42' : null) },
    json: async () => ({ error: 'rate limited' }),
  });
  const { api, ApiError } = load('api.ts', { './base': base }, { fetch });
  await assert.rejects(api.home(), (err) => err instanceof ApiError && err.status === 429 && err.retryAfter === 42);
});

function warmHarness() {
  const posts = [];
  const timers = [];
  let now = 0;
  const window = {
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  };
  const advance = (ms) => {
    now += ms;
    for (const t of timers) if (t.fn && t.at <= now) { const fn = t.fn; t.fn = null; fn(); }
  };
  const fetch = (url) => { posts.push(url); return Promise.resolve({ ok: true }); };
  const DateStub = { now: () => now };
  const warm = load('warm.ts', { './base': base }, { window, fetch, Date: DateStub });
  return { warm, posts, advance };
}

test('hover warms only after the pointer rests, and at most six a minute', () => {
  const { warm, posts, advance } = warmHarness();
  // Crossing a row on the way elsewhere warms nothing.
  const cancel = warm.warmOnHover('crossed0001');
  advance(300);
  cancel();
  advance(1000);
  assert.equal(posts.length, 0);
  // Resting on rows warms them, up to the minute's allowance.
  for (let i = 0; i < 10; i++) {
    warm.warmOnHover(`rested00${String(i).padStart(3, '0')}`);
    advance(700);
  }
  assert.equal(posts.length, 6);
  assert.ok(posts.every((u) => u.endsWith('?reason=hover')));
  // A minute later the allowance is back.
  advance(60_000);
  warm.warmOnHover('later000001');
  advance(700);
  assert.equal(posts.length, 7);
});

test('a page warms its first playable track only', () => {
  const { warm, posts } = warmHarness();
  warm.warmFirst([{ id: 'deadtrack01', playable: false }, { id: 'first000001' }, { id: 'second00001' }, { id: 'third000001' }]);
  assert.deepEqual(posts.map((u) => u.split('/').pop()), ['first000001?reason=page']);
});

function likedHarness(ok) {
  const posts = [];
  const fetch = async (url, init) => { posts.push({ url, body: init?.body }); return { ok, status: ok ? 200 : 500 }; };
  const qc = new queryCore.QueryClient();
  const invalidated = [];
  const invalidate = qc.invalidateQueries.bind(qc);
  qc.invalidateQueries = (filters) => { invalidated.push(filters); return invalidate(filters); };
  const liked = load('liked.ts', {
    '@tanstack/react-query': { useMutation: () => ({}), useQuery: () => ({}), useQueryClient: () => qc },
    './api': { api: {}, shouldRetry: () => false },
    './base': base,
  }, { fetch });
  qc.setQueryData(['liked'], { tracks: [{ id: 'kept0000001' }] });
  return { liked, qc, posts, invalidated };
}

test('a like changes the cached list at once and refetches nothing', async (t) => {
  const { liked, qc, posts, invalidated } = likedHarness(true);
  t.after(() => qc.clear());
  await liked.setLiked(qc, { id: 'new00000001', title: 'New' }, true);
  assert.deepEqual(Array.from(qc.getQueryData(['liked']).tracks, (t) => t.id), ['new00000001', 'kept0000001']);
  assert.equal(JSON.parse(posts[0].body).rating, 'like');
  // Nothing is refetched now: other lists are only marked stale.
  assert.ok(invalidated.every((f) => f.refetchType === 'none'));
  assert.ok(!invalidated.some((f) => f.queryKey[0] === 'liked'));
  await liked.setLiked(qc, { id: 'kept0000001' }, false);
  assert.deepEqual(Array.from(qc.getQueryData(['liked']).tracks, (t) => t.id), ['new00000001']);
  assert.equal(JSON.parse(posts[1].body).rating, 'none');
});

test('a like YouTube refuses is put back', async (t) => {
  const { liked, qc } = likedHarness(false);
  t.after(() => qc.clear());
  await assert.rejects(liked.setLiked(qc, { id: 'new00000001' }, true));
  assert.deepEqual(Array.from(qc.getQueryData(['liked']).tracks, (t) => t.id), ['kept0000001']);
});

test('playing a playlist continues from the pages already loaded', async (t) => {
  const calls = [];
  const page = (ids, next) => ({ playlist: { id: 'PL', title: 'List', tracks: ids.map((id) => ({ id })) }, next });
  const api = {
    playlistPage: async (_id, cursor) => {
      calls.push(cursor);
      return cursor === 'c2' ? page(['e', 'f'], 'c3') : page(['g'], undefined);
    },
  };
  const mod = load('queryclient.ts', {
    '@tanstack/react-query': queryCore,
    './api': { api, shouldRetry: () => false },
  });
  t.after(() => mod.queryClient.clear());
  const key = mod.playlistPagesKey('PL');
  mod.queryClient.setQueryData(key, { pages: [page(['a', 'b'], 'c1'), page(['c', 'd'], 'c2')], pageParams: ['', 'c1'] });
  const all = await mod.completePlaylist('PL');
  assert.deepEqual(Array.from(all, (t) => t.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  // Only the pages not loaded yet were asked for.
  assert.deepEqual(calls, ['c2', 'c3']);
  // And they are in the page's cache now.
  assert.equal(mod.queryClient.getQueryData(key).pages.length, 4);
  // A second play asks for nothing.
  await mod.completePlaylist('PL');
  assert.deepEqual(calls, ['c2', 'c3']);
});

test('a like with no list loaded reads the list again instead of inventing one', async (t) => {
  const { liked, qc, invalidated } = likedHarness(true);
  t.after(() => qc.clear());
  qc.removeQueries({ queryKey: ['liked'] });
  await liked.setLiked(qc, { id: 'new00000001' }, true);
  assert.equal(qc.getQueryData(['liked']), undefined);
  assert.ok(invalidated.some((f) => f.queryKey[0] === 'liked' && f.refetchType === undefined));
});
