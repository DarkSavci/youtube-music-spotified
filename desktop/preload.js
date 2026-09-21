/**
 * Preload bridge.
 *
 * The renderer runs with context isolation and no Node access, so this exposes
 * a deliberately small, explicit surface instead. Anything not listed here is
 * unreachable from the UI, which is the point: the renderer displays a remote
 * catalog and should not be able to touch the filesystem or spawn anything.
 */
const { contextBridge, ipcRenderer } = require("electron");

/**
 * Absolute base for the local core.
 *
 * The packaged page loads over file://, where a root-relative "/v1" resolves
 * to the drive root rather than to a server. An absolute URL is the only thing
 * that works in both the packaged app and the dev server.
 */
const CORE_ORIGIN = "http://127.0.0.1:8674";

contextBridge.exposeInMainWorld("spotifier", {
  /** Absolute origin of the Go core, read synchronously at page load. */
  coreOrigin: CORE_ORIGIN,

  /**
   * Title-bar controls.
   *
   * The window is frameless so the app can draw its own bar; these are what
   * the frame used to provide. Nothing here takes an argument, so the renderer
   * cannot ask the shell to act on any window but its own.
   */
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    onMaximizeChange: (fn) => {
      const handler = (_e, value) => fn(value);
      ipcRenderer.on("window:maximized", handler);
      return () => ipcRenderer.removeListener("window:maximized", handler);
    },
  },

  /** Port the Go core listens on, so the UI can build its base URL. */
  corePort: () => ipcRenderer.invoke("core-port"),
  dataDir: () => ipcRenderer.invoke("data-dir"),

  /** Hardware media keys, forwarded from the main process. */
  onMediaKey: (handler) => {
    const listener = (_event, action) => handler(action);
    ipcRenderer.on("media-key", listener);
    return () => ipcRenderer.removeListener("media-key", listener);
  },

  /** Fires when the sidecar dies, so the UI can show why nothing works. */
  onCoreStatus: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on("core-status", listener);
    return () => ipcRenderer.removeListener("core-status", listener);
  },

  /**
   * Sign-in runs in a window the app owns, so YouTube's cookie rotation
   * updates our session rather than invalidating a copied snapshot.
   */
  auth: {
    signIn: () => ipcRenderer.invoke("auth:sign-in"),
    refresh: () => ipcRenderer.invoke("auth:refresh"),
    signOut: () => ipcRenderer.invoke("auth:sign-out"),
    status: () => ipcRenderer.invoke("auth:status"),
  },

  isDesktop: true,
});
