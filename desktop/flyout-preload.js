/**
 * Preload for the tray flyout.
 *
 * Smaller than the main window's bridge on purpose: the flyout only draws a
 * snapshot and asks for actions. It never talks to the core, and cannot reach
 * the account or the filesystem.
 */
const { contextBridge, ipcRenderer } = require("electron");

const subscribe = (channel) => (fn) => {
  const handler = (_e, value) => fn(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("spotifierFlyout", {
  /** The player snapshot, whenever it changes. */
  onState: subscribe("flyout:state"),
  /** Whether the flyout is on screen, so the page can animate in. */
  onVisible: subscribe("flyout:visible"),
  /** Playback actions, plus "open" (the main window) and "hide". */
  action: (action) => ipcRenderer.send("flyout:action", action),
  /** Content height in CSS pixels; the window resizes to it. */
  setHeight: (h) => ipcRenderer.send("flyout:height", h),
});
