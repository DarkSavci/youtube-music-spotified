const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../ui/node_modules/typescript');

// The player store as local playback drives it, when the core is unreachable.
function store() {
  const source = path.join(__dirname, '../../ui/src/lib/player.ts');
  const code = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, Math, performance,
    require(name) {
      if (name === 'zustand') return require('../../ui/node_modules/zustand');
      throw new Error(name);
    },
  });
  return module.exports.usePlayer;
}

const list = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `T${i}` }));
const ids = (queue) => queue.map((t) => t.id);

test('turning shuffle on reorders the queue around the playing track, and off restores it', () => {
  const player = store();
  const tracks = list(30);
  player.getState().playFrom(tracks, 4, 'Test');
  player.getState().toggleShuffle();

  let s = player.getState();
  assert.equal(s.shuffle, true);
  assert.equal(s.index, 0);
  assert.equal(s.track.id, 't4', 'the playing track keeps playing');
  assert.equal(s.queue[0].id, 't4');
  assert.deepEqual([...ids(s.queue)].sort(), [...ids(tracks)].sort(), 'nothing lost or added');
  assert.notDeepEqual(ids(s.queue.slice(1)), ids(tracks.filter((t) => t.id !== 't4')), 'the rest is shuffled');

  // Next follows the shuffled order.
  s.next();
  assert.equal(player.getState().track.id, s.queue[1].id);

  const playing = player.getState().track.id;
  player.getState().toggleShuffle();
  s = player.getState();
  assert.equal(s.shuffle, false);
  assert.deepEqual(ids(s.queue), ids(tracks), 'the original order is back');
  assert.equal(s.track.id, playing);
  assert.equal(s.index, tracks.findIndex((t) => t.id === playing));
});

test('a queue started with shuffle on plays the chosen track first, then the rest shuffled', () => {
  const player = store();
  player.getState().toggleShuffle();
  const tracks = list(30);
  player.getState().playFrom(tracks, 7, 'Test');
  const s = player.getState();
  assert.equal(s.track.id, 't7');
  assert.equal(s.index, 0);
  assert.notDeepEqual(ids(s.queue.slice(1)), ids(tracks.filter((t) => t.id !== 't7')));
  assert.deepEqual(ids(s.unshuffled), ids(tracks));
});

test('moving within the queue does not reshuffle it', () => {
  const player = store();
  player.getState().toggleShuffle();
  player.getState().playFrom(list(20), 0, 'Test');
  const order = ids(player.getState().queue);
  player.getState().next();
  player.getState().next();
  player.getState().playAt(5);
  player.getState().prev();
  assert.deepEqual(ids(player.getState().queue), order);
});
