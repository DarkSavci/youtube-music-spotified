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
  // A song nobody has played yet still has a count, and goes last.
  const zero = [song('a', '', '86 plays'), song('b', '', '0 plays'), song('c', '', '137 plays')];
  assert.deepEqual(ids(byPlays(zero)), ['c', 'a', 'b']);
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

const me = { id: 'UCme', name: 'Me' };
const by = (...names) => names.map((n) => (n === 'Me' ? { id: 'UCme', name: 'Me' } : { id: `UC${n}`, name: n }));

test('releases complete the list without repeating a song it has', () => {
  const { withReleases } = load();
  const list = [{ ...song('a', 'r1', '9M plays'), artists: by('Me') }, { ...song('b', 'r2', '1M plays'), artists: by('Me') }];
  const releases = [
    { id: 'r1', title: 'One', artists: by('Me'), tracks: [
      { id: 'a', title: 'a', artists: by('Me') },
      // Another video of a listed song.
      { id: 'a-video', title: 'A ', artists: by('Me'), album: { id: 'r1', name: 'One' } },
      { id: 'c', title: 'c', artists: by('Me') },
    ] },
    { id: 'r3', title: 'Three', artists: by('Me'), tracks: [{ id: 'd', title: 'd', artists: [] }, { id: 'c', title: 'c', artists: by('Me') }] },
  ];
  const out = withReleases(list, releases, me);
  assert.deepEqual(ids(out), ['a', 'b', 'c', 'd']);
  // A release's own songs are placed on it, credited to it, when their rows omit both.
  assert.equal(out[3].album.id, 'r3');
  assert.equal(out[3].artists[0].id, 'UCme');
});

test('only songs crediting the artist are taken from a release', () => {
  const { withReleases } = load();
  const soundtrack = { id: 'ost', title: 'A Film (Soundtrack)', artists: by('Various'), tracks: [
    { id: 'x', title: 'Someone else', artists: by('Other') },
    { id: 'y', title: 'Mine', artists: by('Other', 'Me') },
    // Credited by name alone, as some rows are.
    { id: 'z', title: 'Also mine', artists: [{ name: 'me' }] },
  ] };
  assert.deepEqual(ids(withReleases([], [soundtrack], me)), ['y', 'z']);
});

test('a song on several editions is added once', () => {
  const { withReleases } = load();
  const t = (id, title) => ({ id, title, artists: by('Me') });
  const out = withReleases([], [
    { id: 'std', title: 'Hurry Up Tomorrow', artists: by('Me'), tracks: [t('1', 'Sacrifice (Remix)')] },
    { id: 'dlx', title: 'Hurry Up Tomorrow (Deluxe)', artists: by('Me'), tracks: [t('2', 'Sacrifice (Remix)'), t('3', 'Bonus')] },
    { id: 'single', title: 'Sacrifice (Remixes)', artists: by('Me'), tracks: [t('4', 'sacrifice  (remix)')] },
  ], me);
  assert.deepEqual(ids(out), ['1', '3']);
});

test('editions of a release stand under the earliest, plainest one', () => {
  const { editions, editionTitle } = load();
  assert.equal(editionTitle('After Hours (Deluxe)'), 'After Hours');
  assert.equal(editionTitle('Random Access Memories (10th Anniversary Edition)'), 'Random Access Memories');
  assert.equal(editionTitle('Abbey Road [Remastered 2019] (Super Deluxe Edition)'), 'Abbey Road');
  assert.equal(editionTitle('Hurry Up Tomorrow'), 'Hurry Up Tomorrow');
  assert.equal(editionTitle('(Deluxe)'), '(Deluxe)');
  const map = editions([
    { id: 'dlx', title: 'After Hours (Deluxe)', year: '2020' },
    { id: 'std', title: 'After Hours', year: '2020' },
    { id: 'ann', title: 'Random Access Memories (10th Anniversary Edition)', year: '2023' },
    { id: 'ram', title: 'Random Access Memories', year: '2013' },
  ]);
  assert.equal(map.get('dlx').id, 'std');
  assert.equal(map.get('ann').id, 'ram');
  assert.equal(map.get('ann').year, 2013);
  assert.equal(map.get('ann').title, 'Random Access Memories');
});

test('grouping puts editions together and dates them by the main one', () => {
  const { byAlbum, editions } = load();
  const canon = editions([{ id: 'std', title: 'After Hours', year: '2020' }, { id: 'dlx', title: 'After Hours (Deluxe)', year: '2020' }, { id: 'old', title: 'Trilogy', year: '2012' }]);
  const groups = byAlbum([song('a', 'dlx'), song('b', 'old'), song('c', 'std')], new Map(), canon);
  assert.deepEqual(Array.from(groups, (g) => [g.id, g.title, g.year, ids(g.tracks)]), [
    ['std', 'After Hours', 2020, ['a', 'c']],
    ['old', 'Trilogy', 2012, ['b']],
  ]);
});

test('compilations are recognised by their titles', () => {
  const { isCompilation } = load();
  for (const t of ['Greatest Hits', 'The Highlights', 'The Best of Tarkan', "Kayahan'ın En İyileri 1", 'A Tribute to Someone', 'The Essentials'])
    assert.ok(isCompilation(t), t);
  for (const t of ['After Hours', 'Hits Different', 'Live at Wembley', 'Highlights of My Life'])
    assert.ok(!isCompilation(t), t);
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

test('a song the list carries twice keeps its place, on its original release', () => {
  const { withReleases } = load();
  const on = (id, title, album) => ({ id, title, artists: by('Me'), album: { id: album, name: album } });
  const out = withReleases([on('1', 'Wicked Games', 'The Highlights'), on('2', 'Other', 'X'), on('3', 'Wicked Games', 'House of Balloons')], [], me);
  assert.deepEqual(Array.from(out, (t) => `${t.id}@${t.album.name}`), ['3@House of Balloons', '2@X']);
});

test('releases open albums first, then singles, and a single whose song is known last', () => {
  const { releasePlan } = load();
  const rel = (id, title) => ({ id, title, artists: by('Me') });
  const albums = [rel('a1', 'After Hours'), rel('comp', 'The Highlights'), rel('a2', 'Starboy (Deluxe)')];
  const singles = [
    rel('s1', 'Blinding Lights'),
    rel('s2', 'Save Your Tears (feat. Someone)'),
    rel('s3', 'Brand New Song'),
    rel('s4', 'Earned It [Remastered]'),
  ];
  const known = [{ id: 'x', title: 'blinding  lights' }, { id: 'y', title: 'Save Your Tears' }, { id: 'z', title: 'Earned It' }];
  const plan = releasePlan(['undated'], albums, singles, known);
  // Only an exact title counts as known: a featured or other version may be
  // a recording the list lacks, so those singles are opened.
  assert.deepEqual(Array.from(plan.order), ['undated', 'a1', 'a2', 's2', 's3', 's4', 's1']);
  assert.deepEqual([...plan.covered], ['s1']);
});

test('a release listed as both album and single, or needed for a year, is planned once and not deferred', () => {
  const { releasePlan } = load();
  const rel = (id, title) => ({ id, title, artists: by('Me') });
  const plan = releasePlan(['s1'], [rel('a1', 'One')], [rel('s1', 'Hit'), rel('a1', 'One')], [{ id: 'h', title: 'Hit' }, { id: 'o', title: 'One' }]);
  assert.deepEqual(Array.from(plan.order), ['s1', 'a1']);
  assert.equal(plan.covered.size, 0);
});

test('singles named with a featured artist or a version are not taken as known', () => {
  const { releasePlan } = load();
  const rel = (id, title) => ({ id, title, artists: by('Me') });
  const plan = releasePlan([], [], [rel('bb', 'Bad Blood (feat. Kendrick Lamar)'), rel('w', 'willow (lonely witch version)')], [{ id: 'a', title: 'Bad Blood' }, { id: 'b', title: 'willow' }]);
  assert.equal(plan.covered.size, 0);
});
