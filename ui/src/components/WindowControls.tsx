import { useEffect, useState } from "react";

/**
 * Title-bar controls.
 *
 * The window is frameless so the app can draw its own bar rather than sit
 * under a light Windows strip that cannot be themed. Owning the bar means
 * owning these: minimise, maximise/restore and close.
 *
 * Sizes and order follow the Windows convention — 46x32, close on the right,
 * red on hover — because these are system controls before they are ours, and
 * a player that moves them is a player people mis-click.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const bridge = typeof window !== "undefined" ? window.spotifier?.window : undefined;

  useEffect(() => {
    if (!bridge) return;
    // A rejection here must not become an unhandled one: the controls are
    // cosmetic until clicked, and a window that cannot report its own state
    // should still render them rather than take the page down.
    bridge.isMaximized().then(setMaximized, () => setMaximized(false));
    // Windows can maximise us without going through our button — snap
    // layouts, a drag to the top edge, Win+Up — so the icon follows the
    // window rather than our own clicks.
    return bridge.onMaximizeChange(setMaximized);
  }, [bridge]);

  if (!bridge) return null;

  return (
    <div className="wincontrols">
      <button
        className="wincontrols__btn"
        aria-label="Minimize"
        onClick={() => bridge.minimize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>

      <button
        className="wincontrols__btn"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => bridge.toggleMaximize()}
      >
        {maximized ? (
          /* Two offset frames: the standard restore glyph. */
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M2.5 0.5h7v7M0.5 2.5h7v7h-7z"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect
              x="0.5"
              y="0.5"
              width="9"
              height="9"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
          </svg>
        )}
      </button>

      <button
        className="wincontrols__btn wincontrols__btn--close"
        aria-label="Close"
        onClick={() => bridge.close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
    </div>
  );
}
