import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const CORE = "http://127.0.0.1:8674";

/**
 * Artwork and the embedded player are the only remote origins the app needs.
 * Everything else — scripts, styles, the typeface — ships in the bundle, so
 * the policy can deny by default and name the few exceptions.
 */
const CSP = [
  "default-src 'self'",
  // The embedded engine loads YouTube's iframe player API. Without this the
  // fallback engine can never start, so the one path that exists for when
  // native playback breaks was itself broken.
  "script-src 'self' https://www.youtube.com",
  // React writes style attributes for progress bars and extracted artwork
  // colours; those are inline styles by definition.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  // gstatic serves the generated covers for Liked Music and other built-in
  // playlists — the first artwork in the sidebar, and the most visible thing
  // the policy blocked.
  "img-src 'self' data: blob: https://i.ytimg.com https://lh3.googleusercontent.com https://yt3.googleusercontent.com https://yt3.ggpht.com https://www.gstatic.com https://music.youtube.com",
  `media-src 'self' blob: ${CORE}`,
  `connect-src 'self' ${CORE} https://www.youtube.com`,
  // The embedded engine's fallback player.
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Injects the policy into the built page only.
 *
 * Applying it in development would break the dev server, which needs eval and
 * a websocket for hot reload — so the tag is added at build time rather than
 * written into index.html.
 */
function csp() {
  return {
    name: "spotifier-csp",
    apply: "build" as const,
    transformIndexHtml(html: string) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), csp()],
  // Relative asset paths. The packaged app loads index.html over file://,
  // where an absolute "/assets/..." resolves to the filesystem root rather
  // than next to the HTML — so the page renders nothing at all.
  base: "./",
  server: {
    port: 5219,
    host: "127.0.0.1",
    // The Go sidecar. Proxying it keeps development same-origin, which is why
    // `lib/base.ts` can fall back to a relative path here; the packaged app
    // has no origin to be relative to and supplies an absolute one instead.
    proxy: { "/v1": CORE },
  },
});
