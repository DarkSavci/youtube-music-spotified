const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * Each launch runs in its own process, as the app does: init() takes over the
 * console, so two in one process would log every line twice.
 */
function launch(dataDir, downloads, body = '') {
  const script = `
    const Module = require('module');
    const load = Module._load;
    Module._load = function (request, ...rest) {
      if (request === 'electron') return {
        app: { getVersion: () => '9.9.9', getLocale: () => 'en', isPackaged: true, getPath: () => ${JSON.stringify(downloads)} },
        shell: { showItemInFolder() {}, openPath() {} },
      };
      return load.call(this, request, ...rest);
    };
    const logs = require(${JSON.stringify(path.join(__dirname, '..', 'logs.js'))});
    logs.init(${JSON.stringify(dataDir)});
    (async () => { ${body} })().then(() => process.exit(0));
  `;
  return execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
}

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ytms-logs-'));
  fs.mkdirSync(path.join(root, 'dl'));
  return { root, data: path.join(root, 'data'), dl: path.join(root, 'dl'), logs: path.join(root, 'data', 'logs') };
}

test('every launch writes its own file, which starts with what launched', () => {
  const s = scratch();
  launch(s.data, s.dl, `console.log('first run');`);
  launch(s.data, s.dl, `console.log('second run');`);
  const files = fs.readdirSync(s.logs).sort();
  assert.equal(files.length, 2);
  for (const name of files) assert.match(name, /^app-\d{8}-\d{6}(-\d+)?\.log$/);
  const texts = files.map((f) => fs.readFileSync(path.join(s.logs, f), 'utf8'));
  assert.equal(texts.filter((t) => t.includes('first run')).length, 1);
  assert.equal(texts.filter((t) => t.includes('second run')).length, 1);
  for (const t of texts) assert.match(t.split('\n')[0], /\[main\] launch v9\.9\.9/);
});

test('a launch that outgrows its file continues in a numbered part', () => {
  const s = scratch();
  launch(s.data, s.dl, `for (let i = 0; i < 1400; i++) logs.write('core', 'info', 'level=INFO msg="youtube call" '.repeat(125));`);
  const files = fs.readdirSync(s.logs).sort();
  assert.equal(files.length, 2);
  assert.match(files[0], /^app-\d{8}-\d{6}-2\.log$/);
  assert.ok(fs.statSync(path.join(s.logs, files[1])).size <= 5 * 1024 * 1024);
});

test('old launches are pruned, the single-file logs of older versions included', () => {
  const s = scratch();
  fs.mkdirSync(s.logs, { recursive: true });
  const names = ['app.log', 'app.1.log', ...Array.from({ length: 25 }, (_, i) => `app-20260101-0000${String(i).padStart(2, '0')}.log`)];
  names.forEach((name, i) => {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
    fs.writeFileSync(path.join(s.logs, name), 'old\n');
    fs.utimesSync(path.join(s.logs, name), at, at);
  });
  launch(s.data, s.dl);
  const files = fs.readdirSync(s.logs);
  assert.equal(files.length, 20);
  assert.ok(files.some((f) => !f.startsWith('app-2026010')), 'this launch is kept');
});

test('the report zip holds the files at its root, not under "./", which Explorer shows as empty', () => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const s = scratch();
  launch(s.data, s.dl, `console.log('before');`);
  const out = launch(s.data, s.dl, `
    const r = await logs.exportBundle({ dataDir: ${JSON.stringify(s.data)}, corePort: 1, ytdlp: null, page: null });
    process.stdout.write('RESULT' + JSON.stringify(r));
  `);
  const result = JSON.parse(out.slice(out.indexOf('RESULT') + 6));
  assert.equal(result.ok, true);
  const tar = process.platform === 'darwin' ? '/usr/bin/tar' : path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
  const entries = execFileSync(tar, ['-tf', result.path], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.equal(entries[0], 'info.txt');
  assert.equal(entries.filter((e) => /^app-.*\.log$/.test(e)).length, 2);
  assert.ok(entries.every((e) => !e.startsWith('./')), entries.join(', '));
});
