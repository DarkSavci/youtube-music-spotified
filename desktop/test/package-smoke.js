// Runs the actual packaged helpers with only OS tools on PATH.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { targetFor, resourcesDirectory } = require("../platform");

const target = targetFor();
const appDir = path.resolve(__dirname, "..", "..", "dist-desktop", `Youtube Music Spotified-${target.platform}-${target.arch}`);
const resources = resourcesDirectory(appDir, target);
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
env.PATH = target.mac ? "/usr/bin:/bin" : `${process.env.SystemRoot}\\System32`;
const run = (file, args) => execFileSync(file, args, { env, encoding: "utf8", timeout: 60000 });

assert.ok(fs.existsSync(path.join(resources, "app", "ui", "dist", "index.html")));
assert.match(run(path.join(resources, "yt-dlp", target.ytdlp), ["--version"]), /^\d{4}\.\d{2}\.\d{2}/);
assert.match(run(path.join(resources, "deno", target.deno), ["eval", "console.log(1 + 1)"]), /^2\s*$/);
// Go's flag package writes usage to stderr and returns success for -h.
run(path.join(resources, target.core), ["-h"]);
if (target.mac) {
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", path.join(appDir, "Youtube Music Spotified.app")]);
}
console.log(`Packaged helper smoke checks passed: ${target.platform}-${target.arch}`);
