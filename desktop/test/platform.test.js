const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { targetFor, vendorDirectory, resourcesDirectory } = require("../platform");
const { findMacBrowser } = require("../mac-browser");

test("Mac helpers and resources agree for native arm64 and Intel builds", () => {
  for (const [arch, goarch, denoArch] of [["arm64", "arm64", "aarch64"], ["x64", "amd64", "x86_64"]]) {
    const target = targetFor("darwin", arch);
    assert.equal(target.goarch, goarch);
    assert.equal(target.goos, "darwin");
    assert.equal(target.core, "spotifier");
    assert.equal(target.ytdlpAsset, "yt-dlp_macos.zip");
    assert.equal(target.denoAsset, `deno-${denoArch}-apple-darwin.zip`);
    assert.equal(resourcesDirectory("build with spaces", target), path.join("build with spaces", "Youtube Music Spotified.app", "Contents", "Resources"));
    assert.equal(vendorDirectory("desktop", target), path.join("desktop", "vendor", `darwin-${arch}`));
  }
});

test("Windows retains its existing helper names, cache, and resource layout", () => {
  const target = targetFor("win32", "x64");
  assert.equal(target.core, "spotifier.exe");
  assert.equal(target.ytdlpAsset, "yt-dlp_win.zip");
  assert.equal(target.denoAsset, "deno-x86_64-pc-windows-msvc.zip");
  assert.equal(vendorDirectory("desktop", target), path.join("desktop", "vendor"));
  assert.equal(resourcesDirectory("build", target), path.join("build", "resources"));
  assert.throws(() => targetFor("win32", "arm64"), /Unsupported target/);
  assert.throws(() => targetFor("linux", "x64"), /Unsupported target/);
});

test("browser discovery supports user installs and never guesses Safari", () => {
  const expected = path.join("/Users/test", "Applications", "Brave Browser.app", "Contents", "MacOS", "Brave Browser");
  assert.equal(findMacBrowser("/Users/test", (file) => file === expected), expected);
  assert.equal(findMacBrowser("/Users/test", () => false), null);
});
