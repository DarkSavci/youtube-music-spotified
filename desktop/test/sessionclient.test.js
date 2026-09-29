const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../ui/node_modules/typescript');

// Loads sessionclient.ts with a scripted fetch and a controllable EventSource.
function harness() {
  const source = path.join(__dirname, '../../ui/src/lib/sessionclient.ts');
  const code = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const responses = [];
  const streams = [];
  class FakeEventSource {
    constructor() { this.listeners = {}; streams.push(this); }
    addEventListener(kind, fn) { this.listeners[kind] = fn; }
    close() { this.closed = true; }
    emit(p) { this.listeners.projection({ data: JSON.stringify(p) }); }
  }
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, JSON, Math, Date, Promise, console,
    localStorage: { getItem: () => 'dev', setItem() {} },
    AbortSignal: { timeout: () => undefined },
    EventSource: FakeEventSource,
    setTimeout: (fn) => { fn(); return 1; },
    fetch: async () => { const body = responses.shift(); return { ok: true, status: 200, json: async () => body }; },
    require(name) {
      if (name === './base') return { apiUrl: (p) => p };
      throw new Error(name);
    },
  });
  const applied = [];
  const client = new module.exports.SessionClient((p) => applied.push(`${p.state.version}:${p.state.state}`));
  return { client, responses, streams, applied };
}
const projection = (version, state) => ({ state: { version, state }, target: {}, devices: [], capabilities: {} });

test('a command response older than what the stream already delivered is not applied', async () => {
  const h = harness();
  h.responses.push({ projection: projection(750, 'playing') });
  await h.client.start('test', {});
  const stream = h.streams[0];
  stream.emit(projection(751, 'playing'));
  // The seek's response (753, playing) arrives after the stream said the
  // track stalled at the new position (754).
  let answer;
  h.responses.push(new Promise((r) => (answer = r)));
  const pending = h.client.command({ Kind: 'seek', PositionMs: 90000 });
  stream.emit(projection(754, 'stalled'));
  answer({ rejected: '', projection: projection(753, 'playing') });
  await pending;
  assert.deepEqual(h.applied, ['750:playing', '751:playing', '754:stalled']);
  // A same-version snapshot (a device list change) is still taken.
  stream.emit(projection(754, 'stalled'));
  assert.equal(h.applied.length, 4);
});

test('after the stream reconnects, a restarted core counting from 1 is followed', async () => {
  const h = harness();
  h.responses.push({ projection: projection(900, 'playing') });
  await h.client.start('test', {});
  h.streams[0].emit(projection(901, 'playing'));
  // The core restarts: the stream drops and comes back with low versions.
  h.streams[0].onerror();
  const again = h.streams.at(-1);
  assert.notEqual(again, h.streams[0]);
  again.emit(projection(1, 'paused'));
  again.emit(projection(2, 'playing'));
  assert.deepEqual(h.applied.slice(-2), ['1:paused', '2:playing']);
});

test('the client asks the core directly whether it is offline (#7)', async () => {
  const h = harness();
  h.responses.push({ offline: true });
  assert.equal(await h.client.offline(), true);
  h.responses.push({ offline: false });
  assert.equal(await h.client.offline(), false);
});

// Loads the client with one scripted fetch, for registration's outcomes.
function withFetch(fetch, onProjection = () => {}) {
  const source = path.join(__dirname, '../../ui/src/lib/sessionclient.ts');
  const code = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const streams = [];
  const logged = [];
  const log = (...args) => logged.push(args.map(String).join(' '));
  vm.runInNewContext(code, {
    module, exports: module.exports, JSON, Math, Date, Promise,
    console: { warn: log, error: log, debug() {}, info() {} },
    localStorage: { getItem: () => 'dev', setItem() {} },
    AbortSignal: { timeout: () => undefined },
    EventSource: class { constructor() { streams.push(this); } addEventListener() {} close() {} },
    setTimeout: () => 1,
    fetch,
    require(name) {
      if (name === './base') return { apiUrl: (p) => p };
      throw new Error(name);
    },
  });
  return { client: new module.exports.SessionClient(onProjection), streams, logged };
}

test('a throw while applying the first projection does not count as the core being unreachable', async () => {
  const h = withFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ projection: projection(1, 'paused') }) }),
    () => { throw new Error('a store listener broke'); },
  );
  assert.equal(await h.client.start('test', {}), true);
  assert.equal(h.streams.length, 1, 'the projection stream is still opened');
  assert.match(h.logged.join('\n'), /applying the first projection failed: Error: a store listener broke/);
});

test('a refused or failed registration says why', async () => {
  const refused = withFetch(async () => ({ ok: false, status: 503, text: async () => '{"error":"session unavailable"}' }));
  assert.equal(await refused.client.start('test', {}), false);
  assert.match(refused.logged.join('\n'), /register refused: HTTP 503 \{"error":"session unavailable"\}/);

  const failed = withFetch(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(await failed.client.start('test', {}), false);
  assert.match(failed.logged.join('\n'), /register failed: TypeError: Failed to fetch/);
});
