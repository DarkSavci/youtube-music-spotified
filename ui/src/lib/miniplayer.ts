import { create } from "zustand";

/**
 * The mini player's window.
 *
 * Built the way Spotify built theirs: a second, always-on-top window that this
 * page opens and then draws into with a React portal. Being part of this
 * page's React tree is the point — the mini player reads the same player
 * store, liked list and lyrics cache as everything else, so there is no
 * second copy of any state to keep in step.
 *
 * In the desktop app the window is an ordinary `window.open`, which the shell
 * turns into a frameless, remembered, optionally-on-top window (see
 * desktop/miniplayer.js). In a browser that supports it, Document
 * Picture-in-Picture gives the same thing; elsewhere there is no mini player.
 */

export const MINI_FRAME = "miniplayer";

interface MiniState {
  win: Window | null;
  /** The element the portal renders into. */
  root: HTMLElement | null;
}

export const useMini = create<MiniState>(() => ({ win: null, root: null }));

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

function pip(): DocumentPictureInPicture | undefined {
  return (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture })
    .documentPictureInPicture;
}

export function miniSupported(): boolean {
  return Boolean(window.spotifier?.mini) || Boolean(pip());
}

export function isMiniOpen(): boolean {
  const { win } = useMini.getState();
  return Boolean(win && !win.closed);
}

export async function openMini(): Promise<void> {
  const current = useMini.getState().win;
  if (current && !current.closed) {
    current.focus();
    return;
  }

  let win: Window | null = null;
  if (window.spotifier?.mini) {
    // An empty URL rather than about:blank: the window keeps its initial
    // document instead of navigating, so what is written into it stays.
    win = window.open("", MINI_FRAME);
  } else {
    const api = pip();
    if (api) win = await api.requestWindow({ width: 320, height: 320 }).catch(() => null);
  }
  if (!win) return;

  const root = prepare(win);
  useMini.setState({ win, root });
}

export function closeMini(): void {
  const { win } = useMini.getState();
  if (win && !win.closed) win.close();
  useMini.setState({ win: null, root: null });
}

export function toggleMini(): void {
  if (isMiniOpen()) closeMini();
  else void openMini();
}

/** Grows the window to at least this size, for the queue and lyrics. */
export function ensureMiniSize(width: number, height: number): void {
  const { win } = useMini.getState();
  if (!win || win.closed) return;
  if (window.spotifier?.mini) window.spotifier.mini.ensureSize(width, height);
  else if (win.innerWidth < width || win.innerHeight < height) {
    // Picture-in-Picture windows can resize themselves, within the browser's
    // limits.
    try {
      win.resizeTo(Math.max(win.outerWidth, width), Math.max(win.outerHeight, height));
    } catch {
      /* not allowed here; the panel scrolls instead */
    }
  }
}

/**
 * Makes the new window look like this one, and returns the portal's root.
 *
 * The styles are copied rather than imported again, so the mini player is
 * styled by exactly what this page has — including the development server's
 * injected tags, which are kept in step as they hot-reload.
 */
function prepare(win: Window): HTMLElement {
  const doc = win.document;
  doc.title = "Mini player";
  doc.documentElement.lang = document.documentElement.lang;
  doc.body.className = "mini-doc";

  const cloned: Node[] = [];
  const copyStyles = () => {
    for (const node of cloned.splice(0)) node.parentNode?.removeChild(node);
    for (const node of document.head.querySelectorAll("style, link[rel='stylesheet']")) {
      let copy: HTMLElement;
      if (node instanceof HTMLLinkElement) {
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        // Absolute: the new document's base is not this one's.
        link.href = node.href;
        copy = link;
      } else {
        copy = doc.createElement("style");
        copy.textContent = node.textContent;
      }
      doc.head.appendChild(copy);
      cloned.push(copy);
    }
  };

  // Theme and reduced motion live on the root element.
  const copyRoot = () => {
    for (const { name, value } of Array.from(document.documentElement.attributes)) {
      if (name !== "lang") doc.documentElement.setAttribute(name, value);
    }
  };

  copyStyles();
  copyRoot();

  let pending = 0;
  const headWatch = new MutationObserver(() => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(copyStyles);
  });
  headWatch.observe(document.head, { childList: true, subtree: true, characterData: true });
  const rootWatch = new MutationObserver(copyRoot);
  rootWatch.observe(document.documentElement, { attributes: true });

  const root = doc.createElement("div");
  root.className = "mini-root";
  doc.body.appendChild(root);

  // However it closes — its own button, Alt+F4, the tray — forget it.
  win.addEventListener("pagehide", () => {
    headWatch.disconnect();
    rootWatch.disconnect();
    if (useMini.getState().win === win) useMini.setState({ win: null, root: null });
  });

  return root;
}

// The mini player is drawn by this page. If this page goes — a reload after
// signing in, the app quitting — an empty mini player would be left behind.
window.addEventListener("pagehide", closeMini);
