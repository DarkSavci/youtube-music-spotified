// Run with Electron: electron desktop/test/audio-smoke.js
// Offline audio only: no speakers, network, or account data are used.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("../../ui/node_modules/typescript");
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../../ui/src/lib/decks.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL("about:blank");
  const result = await win.webContents.executeJavaScript(`(async () => {
    const exports = {};
    ${code}
    async function render(volume) {
      let ctx;
      window.AudioContext = function() {
        ctx = new OfflineAudioContext(1, 48000, 48000);
        // A deterministic source exercises the same deck routing as media.
        ctx.createMediaElementSource = () => {
          const source = ctx.createOscillator();
          source.frequency.value = 1000;
          source.start();
          return source;
        };
        return ctx;
      };
      const mixer = new exports.Mixer();
      mixer.setBaseVolume(volume);
      mixer.ensure();
      const el = { volume: 1 };
      mixer.adopt(el, 1);
      const rendered = await ctx.startRendering();
      const samples = rendered.getChannelData(0).slice(-4096);
      const rms = Math.sqrt(samples.reduce((sum, v) => sum + v*v, 0) / samples.length);
      // One normalisation step must choose the same correction at any volume.
      mixer.measure();
      return { rms, correction: mixer.levelGain, routed: mixer.debugLevel([el]).routed[0] };
    }
    const full = await render(1);
    const quiet = await render(0.1);
    const muted = await render(0);
    if (!full.routed || !quiet.routed) throw Error('Deck not routed');
    if (Math.abs(quiet.rms / full.rms - exports.perceptualGain(0.1)) > 0.0001) throw Error('Wrong output gain');
    if (Math.abs(full.correction - quiet.correction) > 0.00001) throw Error('Normalisation depends on slider volume');
    if (muted.rms !== 0) throw Error('Mute is not silent');
    return { full, quiet, muted };
  })()`);
  console.log("AUDIO PASS", JSON.stringify(result));
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
