const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../ui/node_modules/typescript');

function load() {
  const source = fs.readFileSync(path.join(__dirname, '../../ui/src/lib/samelist.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Set });
  return module.exports;
}
const song = (id) => ({ id });
const list = (...ids) => ids.map(song);

test('clicking the playing song in its own list resumes it, even after autoplay or a shuffle', () => {
  const { isCurrentList } = load();
  const now = { track: song('a'), queue: list('c', 'a', 'b', 'r1', 'r2'), origin: 'Album' };
  assert.equal(isCurrentList(now, list('a', 'b', 'c'), 0, 'Album'), true);
});

test('another list that starts on the playing song replaces the queue', () => {
  const { isCurrentList } = load();
  // Popular rows queued five songs; the artist's Play asks for all of them.
  const now = { track: song('a'), queue: list('a', 'b', 'c', 'd', 'e'), origin: 'Artist' };
  assert.equal(isCurrentList(now, list('a', 'b', 'c', 'd', 'e', 'f'), 0, 'Artist'), false);
  // A shuffle of songs all already queued, whose first pick is the song
  // playing, is still a new list: its origin says so.
  assert.equal(isCurrentList(now, list('a', 'c', 'b'), 0, 'Artist · Shuffle'), false);
  // And a different song is never the current one.
  assert.equal(isCurrentList(now, list('b', 'a'), 0, 'Artist'), false);
});
