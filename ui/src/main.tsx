// Inter is bundled rather than fetched from a CDN: the desktop app must look
// the same on first launch with no network, and a music player has no reason
// to announce every launch to a font host.
import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { installFlushHooks } from "./lib/playlog";
import "./styles/global.css";
import "./styles/shell.css";
import "./styles/content.css";

/**
 * HashRouter rather than BrowserRouter: the packaged desktop app loads from a
 * file URL, where path-based routing has no server to fall back on.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Queued listening events are flushed when the window is hidden or closed,
// so history is not lost on exit.
installFlushHooks();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <App />
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);
