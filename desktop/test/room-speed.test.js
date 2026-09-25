const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../ui/node_modules/typescript');

test('v2 rooms pin playback to 1x through reconnect and restore personal speed on leave', () => {
  let status = 'disconnected';
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../../ui/src/lib/speed.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require(name) {
    if (name === './together') return { useTogether: { getState: () => ({ status }) } };
    if (name === './settings') return { useSettings: { getState: () => ({ playbackSpeed: 1.5 }) } };
    throw new Error(name);
  } });
  assert.equal(module.exports.effectiveSpeed(), 1.5);
  for (status of ['connecting', 'waiting', 'connected', 'reconnecting']) {
    assert.equal(module.exports.effectiveSpeed(), 1, status);
  }
  status = 'disconnected';
  assert.equal(module.exports.effectiveSpeed(), 1.5);
});
