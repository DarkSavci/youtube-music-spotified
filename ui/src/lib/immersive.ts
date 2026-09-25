import { useEffect } from "react";

/*
 * Views that fill the window draw Windows' caption buttons straight over their
 * content instead of on the dark title strip.
 *
 * The setting is one switch in the main process, but more than one such view
 * can be open at once — the full-screen player over the lyrics, say. Counted,
 * so closing the top one does not switch it off under the one still showing.
 */
let holders = 0;

function set(on: boolean) {
  window.spotifier?.window?.setImmersiveTitleBar?.(on);
}

/** Keeps the caption buttons immersive while the calling view is mounted. */
export function useImmersiveTitleBar() {
  useEffect(() => {
    if (holders++ === 0) set(true);
    return () => {
      if (--holders === 0) set(false);
    };
  }, []);
}
