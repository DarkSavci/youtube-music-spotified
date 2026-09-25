/**
 * Renders the taskbar thumbnail buttons' icons into branding/thumbar/.
 *
 * Windows takes only bitmaps for these buttons, and Electron cannot turn an
 * SVG into one on Windows, so they are drawn out to PNGs here and committed.
 *
 * The Liked Music button comes from the icon library — IconAddCircle, then
 * IconCheckCircle once added, as Spotify draws it — so rerun this after
 * changing those in ui/src/components/Icon.tsx.
 *
 * The transport glyphs are drawn for this size instead. The library's skip
 * icons carry a hairline bar that no scaling can draw crisply at the 16px
 * Windows allows, so these follow what Spotify ships here: a solid 2px bar
 * touching its triangle, rounded corners, every vertical edge on a whole
 * pixel, about 10px tall and optically centred.
 *
 * Electron hands Windows only an image's 1x bitmap, so there is one file per
 * Windows scaling step and tray.js loads the one for the display itself.
 *
 *   npx electron make-thumbar-icons.js
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// 16px is the thumbnail button's size at 100%; one file per Windows scaling step.
const SCALES = {
  "": 16, "@1.25x": 20, "@1.5x": 24, "@1.75x": 28, "@2x": 32,
  "@2.25x": 36, "@2.5x": 40, "@3x": 48,
};
const OUT = path.join(__dirname, "branding", "thumbar");

// Transport shapes on a 16-unit grid: ["rect", x0, y0, x1, y1] or
// ["tri", x0, y0, x1, y1, x2, y2], where the first two points share a
// vertical edge. Play sits half a unit right of the box centre, because a
// triangle's weight is on its flat side.
const TOP = 3, BOTTOM = 13, MID = 8;
const SHAPES = {
  play: [["tri", 4.5, TOP, 4.5, BOTTOM, 13, MID]],
  pause: [["rect", 4, TOP, 7, BOTTOM], ["rect", 9, TOP, 12, BOTTOM]],
  prev: [["rect", 3, TOP, 5, BOTTOM], ["tri", 13, TOP, 13, BOTTOM, 5, MID]],
  next: [["tri", 3, TOP, 3, BOTTOM, 11, MID], ["rect", 11, TOP, 13, BOTTOM]],
};

// Library glyphs, by the component that draws them in the app.
const LIBRARY = { like: "IconAddCircle", liked: "IconCheckCircle" };
// Extra weight, in pixels at 16px, for glyphs whose lines are hairlines at
// this size: the library's weight-400 ring is about a pixel. The ring and what
// sits inside it are weighted separately — a plus as heavy as the ring crowds
// the middle. The check circle is solid, and thickening it would only narrow
// the check cut out of it.
const EMBOLDEN = { like: { ring: 1, centre: 0.4 } };
// Their circles span 13 of the 16 units: a little over the transport's 10,
// because a circle reads smaller than a square of the same height.
const LIBRARY_SIZE = 13;

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
  const library = Object.fromEntries(Object.entries(LIBRARY).map(([name, c]) => [name, pathOf(c)]));
  fs.mkdirSync(OUT, { recursive: true });
  const images = await win.webContents.executeJavaScript(`(() => {
    const shapes = ${JSON.stringify(SHAPES)}, scales = ${JSON.stringify(SCALES)};
    const library = ${JSON.stringify(library)}, librarySize = ${LIBRARY_SIZE};
    const embolden = ${JSON.stringify(EMBOLDEN)};
    // Measure the library glyphs in their own 960-unit coordinates.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    document.body.append(svg);
    const boxes = {};
    for (const [name, d] of Object.entries(library)) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", d);
      svg.append(p);
      boxes[name] = p.getBBox();
    }
    const out = {};
    for (const [suffix, size] of Object.entries(scales)) {
      const k = size / 16;
      const snap = (v) => Math.round(v * k);
      const r = 0.75 * k;
      const canvas = () => {
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const g = c.getContext("2d");
        g.fillStyle = g.strokeStyle = "#ffffff";
        return [c, g];
      };
      // A closed polygon whose corners are rounded by arcs of radius r.
      const polygon = (g, pts) => {
        const n = pts.length;
        g.beginPath();
        g.moveTo((pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2);
        for (let i = 0; i < n; i++) g.arcTo(...pts[i], ...pts[(i + 1) % n], r);
        g.closePath();
        g.fill();
      };
      for (const [name, parts] of Object.entries(shapes)) {
        const [c, g] = canvas();
        for (const [kind, ...p] of parts) {
          if (kind === "rect") {
            const [x0, y0, x1, y1] = p.map(snap);
            polygon(g, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
          } else {
            polygon(g, [[snap(p[0]), snap(p[1])], [snap(p[2]), snap(p[3])], [p[4] * k, p[5] * k]]);
          }
        }
        out[name + suffix] = c.toDataURL("image/png");
      }

      for (const [name, d] of Object.entries(library)) {
        const b = boxes[name];
        const s = (librarySize * k) / Math.max(b.width, b.height);
        // Centred, then snapped so the glyph's left and top edges sit on pixels.
        const x = Math.round((size - b.width * s) / 2) - b.x * s;
        const y = Math.round((size - b.height * s) / 2) - b.y * s;
        const [c, g] = canvas();
        g.setTransform(s, 0, 0, s, x, y);
        const shape = new Path2D(d);
        g.fill(shape);
        if (embolden[name]) {
          // Stroking the outline in the fill colour grows a line by the
          // stroke's width, half on each side. Each weight is clipped to its
          // part: the ring beyond 30% of the glyph's size from its centre,
          // the rest inside it.
          const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
          const split = 0.3 * Math.max(b.width, b.height);
          const inner = new Path2D();
          inner.arc(cx, cy, split, 0, Math.PI * 2);
          const outer = new Path2D();
          outer.rect(b.x - b.width, b.y - b.height, b.width * 3, b.height * 3);
          outer.arc(cx, cy, split, 0, Math.PI * 2);
          g.lineJoin = "round";
          for (const [part, clip, rule] of [["ring", outer, "evenodd"], ["centre", inner, "nonzero"]]) {
            if (!embolden[name][part]) continue;
            g.save();
            g.clip(clip, rule);
            g.lineWidth = (embolden[name][part] * k) / s;
            g.stroke(shape);
            g.restore();
          }
        }
        out[name + suffix] = c.toDataURL("image/png");
      }
    }
    return out;
  })()`);
  for (const [file, dataUrl] of Object.entries(images)) {
    const target = path.join(OUT, `${file}.png`);
    fs.writeFileSync(target, Buffer.from(dataUrl.split(",")[1], "base64"));
    console.log("wrote", path.relative(__dirname, target));
  }
  app.quit();
}
