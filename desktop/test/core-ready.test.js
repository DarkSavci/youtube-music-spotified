const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { waitForOwnedCore } = require("../core-ready");
function child() {
  return Object.assign(new EventEmitter(), { stderr: new PassThrough() });
}
test("readiness requires the owned child's complete listening message", async () => {
  const c = child();
  let ready = false;
  const result = waitForOwnedCore(c).then(() => { ready = true; });
  c.stderr.write('level=INFO msg="loading"\nlevel=INFO msg="spotifier listen');
  await Promise.resolve();
  assert.equal(ready, false);
  c.stderr.write('ing" addr=127.0.0.1:8674\n');
  await result;
  assert.equal(c.stderr.listenerCount("data"), 0);
});
test("bind failure rejects instead of accepting an existing server", async () => {
  const c = child();
  const result = waitForOwnedCore(c);
  c.stderr.write('level=ERROR msg=listen err="address already in use"\n');
  c.emit("exit", 1, null);
  await assert.rejects(result, /exited before becoming ready/);
});
test("startup timeout and spawn errors reject", async () => {
  await assert.rejects(waitForOwnedCore(child(), 10), /in time/);
  const c = child();
  const result = waitForOwnedCore(c);
  c.emit("error", new Error("spawn failed"));
  await assert.rejects(result, /spawn failed/);
});
