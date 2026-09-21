/**
 * Packaging.
 *
 * Uses @electron/packager rather than electron-builder: the latter downloads a
 * code-signing toolchain unconditionally for Windows targets, and extracting
 * it fails on a stock Windows install because the archive contains symlinks
 * that need Developer Mode or elevation. We do not sign, so the whole
 * toolchain is dead weight.
 *
 * Produces an unpacked, runnable application directory. `npm run installer`
 * then wraps that directory in an NSIS setup file with electron-builder's
 * --prepackaged, which skips the toolchain because nothing is re-packaged or
 * signed.
 */
const { packager } = require("@electron/packager");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");

const root = path.join(__dirname, "..");
const out = path.join(root, "dist-desktop");

/*
 * yt-dlp ships with the app.
 *
 * It is what reaches the subscriber audio tiers: the built-in resolver cannot
 * carry account cookies, so without yt-dlp a Premium account plays standard
 * quality. Relying on it being on PATH meant every install but the developer's
 * quietly got the worse stream.
 *
 * Fetched from the official release and checked against the checksums that
 * release publishes, then cached so a rebuild does not download it again.
 * A week-old cache is refreshed, because yt-dlp tracks YouTube's changes and
 * an old copy is the usual reason it stops working. If GitHub cannot be
 * reached, a copy on PATH is used instead, and failing both is fatal:
 * packaging without it would ship the degraded app without saying so.
 */
const YTDLP_RELEASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const vendor = path.join(__dirname, "vendor");
/*
 * The unpacked Windows build, not the single-file yt-dlp.exe.
 *
 * The single file is a self-extracting archive that unpacks Python on every
 * run: 1.3-1.5 s before yt-dlp does anything, paid on every track. The
 * unpacked build starts in about half a second. It is the same release,
 * published as yt-dlp_win.zip beside the .exe and covered by the same
 * checksum file.
 */
const ytdlpDir = path.join(vendor, "yt-dlp");
const ytdlpCached = path.join(ytdlpDir, "yt-dlp.exe");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchYtdlp() {
  const fresh =
    fs.existsSync(ytdlpCached) && Date.now() - fs.statSync(ytdlpCached).mtimeMs < WEEK_MS;
  if (fresh) {
    console.log("yt-dlp: using cached copy");
    return ytdlpDir;
  }

  try {
    console.log("yt-dlp: downloading the latest release...");
    const [zip, sums] = await Promise.all([
      download(`${YTDLP_RELEASE}/yt-dlp_win.zip`),
      download(`${YTDLP_RELEASE}/SHA2-256SUMS`),
    ]);
    const line = sums.toString("utf8").split(/\r?\n/).find((l) => / yt-dlp_win\.zip$/.test(l.trim()));
    const expected = line && line.trim().split(/\s+/)[0].toLowerCase();
    const actual = crypto.createHash("sha256").update(zip).digest("hex");
    if (!expected || expected !== actual) {
      throw new Error(`checksum mismatch (expected ${expected || "none"}, got ${actual})`);
    }
    fs.mkdirSync(vendor, { recursive: true });
    const zipPath = path.join(vendor, "yt-dlp_win.zip");
    fs.writeFileSync(zipPath, zip);
    fs.rmSync(ytdlpDir, { recursive: true, force: true });
    fs.mkdirSync(ytdlpDir, { recursive: true });
    // Windows ships bsdtar, which reads zip archives.
    execFileSync(windowsTar(), ["-xf", zipPath, "-C", ytdlpDir]);
    fs.rmSync(zipPath, { force: true });
    if (!ytdlpVersion(ytdlpCached)) throw new Error("the unpacked build does not run");
    // The app's own updater compares against this to know what it has.
    fs.writeFileSync(path.join(ytdlpDir, "release.sha256"), actual);
    // Touch it, so the weekly freshness check measures from this download.
    const now = new Date();
    fs.utimesSync(ytdlpCached, now, now);
    console.log("yt-dlp: verified " + actual.slice(0, 16) + "…");
    return ytdlpDir;
  } catch (err) {
    console.warn("yt-dlp: download failed (" + err.message + ")");
  }

  // A stale cache still beats nothing — if it actually runs.
  if (fs.existsSync(ytdlpCached) && ytdlpVersion(ytdlpCached)) {
    console.warn("yt-dlp: using the older cached copy");
    return ytdlpDir;
  }

  // Last resort: whatever is installed on this machine.
  for (const candidate of ytdlpOnPath()) {
    fs.mkdirSync(ytdlpDir, { recursive: true });
    fs.copyFileSync(candidate, ytdlpCached);
    /*
     * Run it from where it will live, not where it was found.
     *
     * Package managers put a launcher on PATH rather than the program:
     * Chocolatey's is a 64 KB shim that finds the real yt-dlp by a relative
     * path, which only resolves inside Chocolatey's own folder. Copied into
     * the app it just prints "cannot find file" — and the app would have
     * shipped it and quietly played everything at standard quality.
     */
    const version = ytdlpVersion(ytdlpCached);
    if (version) {
      console.warn(`yt-dlp: using ${version} from this machine: ${candidate}`);
      return ytdlpDir;
    }
    fs.rmSync(ytdlpCached, { force: true });
  }

  console.error("yt-dlp: no working copy available; refusing to package without it");
  process.exit(1);
}

/*
 * Windows' own tar, which reads zip archives. Named in full: a shell with Git
 * on PATH finds GNU tar first, which takes "C:" for a remote host.
 */
function windowsTar() {
  return path.join(process.env.SystemRoot || "C:/Windows", "System32", "tar.exe");
}

/** The version a yt-dlp binary reports, or null when it does not run. */
function ytdlpVersion(bin) {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 60000 }).trim();
    return /^\d{4}\.\d{2}\.\d{2}/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/*
 * yt-dlp binaries on this machine, real programs before launchers.
 *
 * For a Chocolatey shim the real program sits under lib/yt-dlp/tools beside
 * the shim's bin folder, so that is tried first.
 */
function ytdlpOnPath() {
  let listed = [];
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    listed = execFileSync(finder, ["yt-dlp"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /\.exe$/i.test(l) && fs.existsSync(l));
  } catch {
    /* not on PATH */
  }
  const out = [];
  for (const found of listed) {
    const choco = path.join(path.dirname(found), "..", "lib", "yt-dlp", "tools");
    for (const arch of ["x64", "x86", ""]) {
      const real = path.join(choco, arch, "yt-dlp.exe");
      if (fs.existsSync(real)) out.push(real);
    }
    out.push(found);
  }
  return out;
}

async function main() {
  /*
   * Build the core here rather than trusting whatever is in bin/.
   *
   * This script used to copy a pre-built binary and only check that one
   * existed. A stale binary is indistinguishable from a fresh one at that
   * check, so a fixed bug gets packaged unfixed and then verified as still
   * broken — which cost a full debugging cycle chasing a fix that was never
   * in the binary under test. `go build` is already incremental; the check
   * that cannot be wrong is cheaper than the one that can.
   */
  const core = path.join(root, "bin", "spotifier.exe");
  console.log("building core...");
  try {
    execFileSync("go", ["build", "-o", core, "./cmd/spotifier"], {
      cwd: root,
      stdio: "inherit",
    });
  } catch {
    console.error("core build failed");
    process.exit(1);
  }

  /*
   * Build the UI here too, for the same reason the core is built here.
   *
   * Checking that a bundle exists cannot tell a fresh one from a stale one.
   * A typecheck failure in an earlier command once left the previous bundle
   * in place, packaging shipped it, and the sweep then reported a feature as
   * broken that had in fact never been compiled. Verifying something other
   * than what you built is the most expensive kind of green.
   *
   * The typecheck runs first and its failure is fatal: shipping a bundle that
   * does not typecheck is how that stale build happened.
   */
  // Node refuses to run a .cmd shim without a shell on Windows, and npm is a
  // .cmd there. Without this the spawn fails and reads as a failing build.
  const viaShell = process.platform === "win32";
  for (const [label, script] of [["typechecking ui", "typecheck"], ["building ui", "build"]]) {
    console.log(label + "...");
    try {
      execFileSync("npm", ["--prefix", JSON.stringify(path.join(root, "ui")), "run", script], {
        cwd: root,
        stdio: "inherit",
        shell: viaShell,
      });
    } catch {
      console.error(label + " failed; refusing to package");
      process.exit(1);
    }
  }

  const bundle = path.join(root, "ui", "dist", "index.html");
  if (!fs.existsSync(bundle)) {
    console.error("ui bundle missing after build: " + bundle);
    process.exit(1);
  }

  const ytdlp = await fetchYtdlp();

  const paths = await packager({
    dir: __dirname,
    out,
    overwrite: true,
    platform: "win32",
    arch: "x64",
    name: "Youtube Music Spotified",
    appVersion: require("./package.json").version,
    // Stamped into the .exe, which is what Explorer and the taskbar read.
    icon: path.join(__dirname, "branding", "icon.ico"),
    // Only what the app actually runs. node_modules is excluded because the
    // main process has no runtime dependencies beyond Electron itself.
    ignore: [/^\/node_modules/, /^\/build\.js$/, /^\/dist-desktop/, /^\/vendor/, /^\/branding\/installer\.nsh$/],
    // branding/ ships: main.js loads the PNG for the window icon at runtime.
    // yt-dlp sits beside the core in resources/, where main.js looks for it.
    extraResource: [core, ytdlp],
    // The renderer bundle is copied in below rather than by packager, so its
    // path inside the app matches what main.js expects.
    asar: false,
    quiet: true,
  });

  const appDir = paths[0];
  const resources = path.join(appDir, "resources", "app");

  // main.js resolves the bundle at ./ui/dist when packaged.
  const uiTarget = path.join(resources, "ui", "dist");
  fs.mkdirSync(uiTarget, { recursive: true });
  fs.cpSync(path.join(root, "ui", "dist"), uiTarget, { recursive: true });

  console.log(`packaged: ${appDir}`);
  console.log(`  executable : ${path.join(appDir, "Youtube Music Spotified.exe")}`);
  console.log(`  core       : ${path.join(appDir, "resources", "spotifier.exe")}`);
  console.log(`  yt-dlp     : ${path.join(appDir, "resources", "yt-dlp", "yt-dlp.exe")}`);
  console.log(`  ui bundle  : ${uiTarget}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
