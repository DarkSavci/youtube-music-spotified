import { useEffect, useState } from "react";

/**
 * The dominant colour of a piece of artwork.
 *
 * Spotify's lyrics view is a flat colour taken from the cover rather than a
 * blurred copy of it, which is what keeps large text readable over it — a
 * blur still has light and dark regions, and type has to survive both.
 *
 * The artwork hosts all send `Access-Control-Allow-Origin: *`, so the image
 * can be read back from a canvas. If that ever stops being true the read
 * throws on a tainted canvas and the fallback colour is used, which is why
 * every caller gets a usable colour rather than null.
 */

const FALLBACK = "#2a2a2a";
const cache = new Map<string, string>();

export function useArtColor(url: string | undefined): string {
  const [color, setColor] = useState(() => (url && cache.get(url)) || FALLBACK);

  useEffect(() => {
    if (!url) {
      setColor(FALLBACK);
      return;
    }
    const cached = cache.get(url);
    if (cached) {
      setColor(cached);
      return;
    }

    let cancelled = false;
    extract(url)
      .then((c) => {
        cache.set(url, c);
        if (!cancelled) setColor(c);
      })
      .catch(() => {
        if (!cancelled) setColor(FALLBACK);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return color;
}

/**
 * Reads the artwork and picks a colour to sit behind white text.
 *
 * Averaging the whole image gives mud, and the single most frequent colour is
 * often a near-black border. Instead the most frequent *saturated* bucket wins,
 * then it is pushed into a band that white type reads against: dark enough for
 * contrast, saturated enough not to look like a grey error state.
 */
async function extract(url: string): Promise<string> {
  const img = new Image();
  // Required for the canvas read below; without it the canvas is tainted.
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();

  const size = 48; // Small on purpose: this is a colour, not a thumbnail.
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return FALLBACK;
  ctx.drawImage(img, 0, 0, size, size);

  const { data } = ctx.getImageData(0, 0, size, size);
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const a = data[i + 3]!;
    if (a < 200) continue;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    // Skip near-greys and the very dark or very light extremes: they are
    // usually letterboxing or a white sleeve, not the cover's colour.
    if (sat < 0.2 || max < 30 || min > 235) continue;

    // Quantise, so near-identical pixels count together.
    const key = `${r >> 4}:${g >> 4}:${b >> 4}`;
    const cur = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    cur.n += 1;
    cur.r += r;
    cur.g += g;
    cur.b += b;
    buckets.set(key, cur);
  }

  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const v of buckets.values()) {
    if (!best || v.n > best.n) best = v;
  }
  if (!best) return FALLBACK;

  return readable(best.r / best.n, best.g / best.n, best.b / best.n);
}

/** Pushes a colour into a band that white text reads against. */
function readable(r: number, g: number, b: number): string {
  let [h, s, l] = rgbToHsl(r, g, b);
  // Keep some colour, but never enough to vibrate under white type.
  s = Math.min(0.62, Math.max(0.28, s));
  // The band matters more than the hue: too light and white text disappears,
  // too dark and the whole view reads as broken.
  l = Math.min(0.42, Math.max(0.24, l));
  const [nr, ng, nb] = hslToRgb(h, s, l);
  return `#${[nr, ng, nb].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const to = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [to(h + 1 / 3) * 255, to(h) * 255, to(h - 1 / 3) * 255];
}
