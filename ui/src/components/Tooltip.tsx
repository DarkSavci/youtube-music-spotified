import { useEffect, useRef, useState } from "react";

/**
 * Tooltips for controls that are only an icon.
 *
 * One listener on the document rather than a wrapper around forty buttons.
 * Every icon control in the app already carries an `aria-label` — it has to,
 * or a screen reader would announce nothing — so the label a tooltip needs is
 * already written down. Reading it here means a new icon button gets a
 * tooltip by existing, and can never carry a tooltip that disagrees with what
 * assistive technology is told.
 *
 * Only icon-only controls qualify. A button with visible text already says
 * what it does, and repeating it under the cursor is noise.
 */

type Shown = { label: string; x: number; y: number; above: boolean };

/** How long the pointer must rest before a tooltip appears. */
const DELAY_MS = 350;

/** Distance from the control, leaving room for the arrow. */
const GAP = 10;

function labelFor(el: Element): string | null {
  const control = el.closest<HTMLElement>(
    'button[aria-label], a[aria-label], [role="switch"][aria-label], [role="button"][aria-label]',
  );
  if (!control) return null;
  if (control.getAttribute("aria-hidden") === "true") return null;

  const label = control.getAttribute("aria-label")?.trim();
  if (!label) return null;

  /*
   * Icon-only, decided by what the control actually renders.
   *
   * Checking for a class would mean every new button had to remember to opt
   * in; checking for text means the rule is simply "if you can already read
   * what it does, you do not need telling".
   */
  if ((control.textContent || "").trim().length > 0) return null;
  return label;
}

export function Tooltips() {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const anchor = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const clear = () => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      anchor.current = null;
      setShown(null);
    };

    const onOver = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      const control = target.closest<HTMLElement>("button, a, [role]");
      if (!control || control === anchor.current) return;

      window.clearTimeout(timer.current);
      const label = labelFor(target);
      if (!label) {
        anchor.current = null;
        setShown(null);
        return;
      }
      anchor.current = control;
      timer.current = window.setTimeout(() => {
        // The control may have gone since the timer was set — a menu closing,
        // a row scrolling out — and measuring a detached element gives zeros.
        if (!control.isConnected) return;
        const r = control.getBoundingClientRect();
        // Above by default, below when there is no room, which is what
        // happens to the controls pinned to the top of a page.
        const above = r.top > 56;
        /*
         * Kept on screen.
         *
         * Centring on the control puts half the tooltip past the edge for
         * anything near one — and the controls most worth explaining are the
         * ones pinned to the corners of the transport bar. The estimate is
         * rough because the tooltip has not been measured yet; it only has to
         * be close enough that the clamp lands inside the window.
         */
        const half = Math.min(220, label.length * 7) / 2 + 8;
        const x = Math.min(
          Math.max(r.left + r.width / 2, half),
          window.innerWidth - half,
        );
        setShown({ label, x, y: above ? r.top - GAP : r.bottom + GAP, above });
      }, DELAY_MS);
    };

    const onOut = (e: MouseEvent) => {
      const to = e.relatedTarget as Node | null;
      if (anchor.current && to && anchor.current.contains(to)) return;
      clear();
    };

    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    // Anything that moves the page or changes what is under the pointer
    // invalidates a position that was measured a moment ago.
    document.addEventListener("mousedown", clear, true);
    document.addEventListener("keydown", clear, true);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("blur", clear);

    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mouseout", onOut, true);
      document.removeEventListener("mousedown", clear, true);
      document.removeEventListener("keydown", clear, true);
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("blur", clear);
    };
  }, []);

  if (!shown) return null;
  return (
    <div
      className="tooltip"
      data-above={shown.above || undefined}
      style={{ left: shown.x, top: shown.y }}
      // Announced already by the aria-label this was read from, so saying it
      // again here would have a screen reader read every icon twice.
      aria-hidden="true"
    >
      {shown.label}
    </div>
  );
}
