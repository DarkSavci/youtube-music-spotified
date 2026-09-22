/**
 * Renders the taskbar thumbnail buttons' icons into branding/thumbar/.
 *
 * Windows wants bitmaps for these, and Electron cannot turn an SVG into one on
 * Windows, so they are drawn once from the same Material Symbols paths the UI
 * uses (ui/src/components/Icon.tsx) and committed. One PNG per display scale,
 * named the way nativeImage picks between them.
 *
 *   npx electron make-thumbar-icons.js
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ICONS = { play: "IconPlay", pause: "IconPause", next: "IconSkipNext", prev: "IconSkipPrev" };
// 16px is the thumbnail button's size at 100%.
const SCALES = { "": 16, "@1.25x": 20, "@1.5x": 24, "@2x": 32 };
const OUT = path.join(__dirname, "branding", "thumbar");

const source = fs.readFileSync(path.join(__dirname, "..", "ui", "src", "components", "Icon.tsx"), "utf8");
function pathOf(component) {
  const start = source.indexOf(`export const ${component} = `);
  const m = start >= 0 && source.slice(start).match(/<path d="([^"]+)"/);
  if (!m) throw new Error(`no path for ${component}`);
  return m[1];
}

// An exception in here would otherwise leave Electron running with no window
// and nothing on the console.
app.whenReady().then(render).catch((err) => {
  console.error(err);
  app.exit(1);
});

async function render() {
  const win = new BrowserWindow({ show: false });
  await win.loadURL("data:text/html,<!doctype html><title>icons</title>");
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, component] of Object.entries(ICONS)) {
    for (const [suffix, size] of Object.entries(SCALES)) {
      const d = pathOf(component);
      const dataUrl = await win.webContents.executeJavaScript(`(() => {
        const c = document.createElement("canvas");
        c.width = c.height = ${size};
        const g = c.getContext("2d");
        // Material's 960-unit grid, origin on the baseline.
        g.scale(${size} / 960, ${size} / 960);
        g.translate(0, 960);
        g.fillStyle = "#ffffff";
        g.fill(new Path2D(${JSON.stringify(d)}));
        return c.toDataURL("image/png");
      })()`);
      const file = path.join(OUT, `${name}${suffix}.png`);
      fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
      console.log("wrote", path.relative(__dirname, file));
    }
  }
  app.quit();
}
