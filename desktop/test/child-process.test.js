const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { stopChild } = require("../child-process");

test("stop waits for graceful termination, including when killed is already true", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", `
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 80));
    setInterval(() => {}, 1000);
    process.send('ready');
  `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(child, "message");
  child.kill();
  await stopChild(child, 2000);
  assert.equal(child.exitCode, 0);
});

test("stop escalates an unresponsive child and waits for its exit", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    process.send('ready');
  `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(child, "message");
  await stopChild(child, 50);
  assert.equal(child.signalCode, "SIGKILL");
  await stopChild(child);
});
