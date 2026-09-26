/**
 * What the main window's close button does.
 *
 * With "close to tray" on it hides the window and the music carries on. Off,
 * it quits, on every platform. Letting the window close by itself is not
 * enough: the tray flyout is a hidden window of its own, so the app would
 * never see all its windows closed, and would stay running with no way back
 * in but the tray icon.
 *
 * @param {{ quitting: boolean, closeToTray: boolean }} state
 * @returns {"close" | "hide" | "quit"} "close" lets a quit already under way
 *   close the window.
 */
function closeAction({ quitting, closeToTray }) {
  if (quitting) return "close";
  return closeToTray ? "hide" : "quit";
}

module.exports = { closeAction };
