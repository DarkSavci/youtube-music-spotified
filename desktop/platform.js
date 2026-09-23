const path = require("node:path");

/** Only native builds: every bundled helper is executed before packaging. */
function targetFor(platform = process.platform, arch = process.arch) {
  if (!(platform === "win32" && arch === "x64") &&
      !(platform === "darwin" && ["arm64", "x64"].includes(arch))) {
    throw new Error(`Unsupported target: ${platform}-${arch}. Build on Windows x64 or macOS arm64/x64.`);
  }
  const mac = platform === "darwin";
  return {
    platform, arch, mac,
    goos: mac ? "darwin" : "windows",
    goarch: arch === "x64" ? "amd64" : "arm64",
    core: mac ? "spotifier" : "spotifier.exe",
    ytdlp: mac ? "yt-dlp" : "yt-dlp.exe",
    ytdlpAsset: mac ? "yt-dlp_macos.zip" : "yt-dlp_win.zip",
    deno: mac ? "deno" : "deno.exe",
    denoAsset: mac
      ? `deno-${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin.zip`
      : "deno-x86_64-pc-windows-msvc.zip",
  };
}

function vendorDirectory(base, target = targetFor()) {
  return target.mac ? path.join(base, "vendor", `${target.platform}-${target.arch}`) : path.join(base, "vendor");
}

function resourcesDirectory(appDir, target = targetFor()) {
  return target.mac
    ? path.join(appDir, "Youtube Music Spotified.app", "Contents", "Resources")
    : path.join(appDir, "resources");
}

module.exports = { targetFor, vendorDirectory, resourcesDirectory };
