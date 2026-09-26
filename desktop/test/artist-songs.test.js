const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../ui/node_modules/typescript');

function load() {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../../ui/src/lib/artistsongs.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports });
  return module.exports;
}

const song = (id, album, plays) => ({ id, title: id, playCount: plays, album: album ? { id: album, name: `Album ${album}` } : undefined });
// The module runs in its own realm, so its arrays are copied out before comparing.
const ids = (list) => Array.from(list, (t) => t.id);

test('play counts parse with their suffixes', () => {
  const { playCount } = load();
  assert.equal(playCount('1.9B plays'), 1.9e9);
  assert.equal(playCount('22M plays'), 22e6);
  assert.equal(playCount('850K views'), 850e3);
  assert.equal(playCount('1,234 plays'), 1234);
  assert.equal(playCount(''), 0);
  assert.equal(playCount(undefined), 0);
});

test('songs order by plays, and are left alone when a count is missing', () => {
  const { byPlays } = load();
  assert.deepEqual(ids(byPlays([song('a', '', '22M plays'), song('b', '', '30M plays'), song('c', '', '1B plays')])), ['c', 'b', 'a']);
  const partial = [song('a', '', '22M plays'), song('b', '', ''), song('c', '', '1B plays')];
  assert.deepEqual(ids(byPlays(partial)), ['a', 'b', 'c']);
});

test('newest first puts undated songs last and keeps order within a year', () => {
  const { newestFirst, yearsByAlbum } = load();
  const years = yearsByAlbum([{ id: 'old', year: '2001' }, { id: 'new', year: '2013' }], [{ id: 'bad', year: '' }]);
  const out = newestFirst([song('x', 'old'), song('y', 'none'), song('z', 'new'), song('w', 'new'), song('v', '')], years);
  assert.deepEqual(ids(out), ['z', 'w', 'x', 'y', 'v']);
});

test('grouping by album orders albums newest first, undated after, loose songs last', () => {
  const { byAlbum, yearsByAlbum } = load();
  const years = yearsByAlbum([{ id: 'a1', year: '2001' }, { id: 'a2', year: '2013' }]);
  const groups = byAlbum([song('s1', 'a1'), song('s2', ''), song('s3', 'a2'), song('s4', 'a3'), song('s5', 'a1')], years);
  assert.deepEqual(Array.from(groups, (g) => [g.id, g.year, ids(g.tracks)]), [
    ['a2', 2013, ['s3']],
    ['a1', 2001, ['s1', 's5']],
    ['a3', undefined, ['s4']],
    ['', undefined, ['s2']],
  ]);
  assert.equal(groups[3].title, 'Other songs');
});

test('albums still missing a year are listed once, in order', () => {
  const { missingAlbums, yearsByAlbum } = load();
  const years = yearsByAlbum([{ id: 'known', year: '1999' }]);
  assert.deepEqual(Array.from(missingAlbums([song('a', 'x'), song('b', 'known'), song('c', 'y'), song('d', 'x'), song('e', '')], years)), ['x', 'y']);
});

test('releases complete the list without repeating a song it has', () => {
  const { withReleases } = load();
  const list = [song('a', 'r1', '9M plays'), song('b', 'r2', '1M plays')];
  const releases = [
    { id: 'r1', title: 'One', tracks: [{ id: 'a', title: 'a' }, { id: 'a-video', title: 'A ', album: { id: 'r1', name: 'One' } }, { id: 'c', title: 'c' }] },
    { id: 'r3', title: 'Three', tracks: [{ id: 'd', title: 'd' }, { id: 'c', title: 'c' }] },
  ];
  const out = withReleases(list, releases);
  assert.deepEqual(ids(out), ['a', 'b', 'c', 'd']);
  // A release's own songs are placed on it even when their rows omit it.
  assert.equal(out[3].album.id, 'r3');
});

test('a shuffle keeps every song once', () => {
  const { shuffled } = load();
  const input = ['a', 'b', 'c', 'd', 'e'];
  let n = 0;
  const out = Array.from(shuffled(input, () => [0.9, 0.1, 0.5, 0.3][n++ % 4]));
  assert.deepEqual([...out].sort(), input);
  assert.notDeepEqual(out, input);
  assert.deepEqual(input, ['a', 'b', 'c', 'd', 'e']);
});
