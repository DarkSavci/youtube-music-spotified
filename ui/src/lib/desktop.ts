/**
 * Bridge to the desktop shell.
 *
 * Every capability here is optional: the same UI runs in a plain browser,
 * where `window.spotifier` is simply absent. Callers check `isDesktop` rather
 * than assuming, so nothing has to be stubbed out for the web build.
 */

import type { TrayAction, TrayState } from "./traystate";

/** Where the app's updater is. Mirrors desktop/updater.js. */
export type UpdateStatus =
  | { status: "unavailable" | "idle" | "checking" }
  | { status: "none"; checkedAt: number }
  | { status: "downloading"; version: string; percent: number }
  | { status: "ready"; version: string }
  | { status: "error"; error: string };

export interface AuthResult {
  ok: boolean;
  count?: number;
  reason?: string;
}

export interface SavedAccounts {
 activeId: string | null;
 accounts: { id: string; name: string; avatarUrl?: string; channel: string; channels: { id: string; name: string; handle?: string; avatarUrl?: string }[] }[];
}

/**
 * Launch at login, as the OS reports it. needsApproval is macOS holding a
 * registration until it is allowed in System Settings.
 */
export interface LoginItemState {
  supported: boolean;
  enabled: boolean;
  needsApproval: boolean;
}

const NO_LOGIN_ITEM: LoginItemState = { supported: false, enabled: false, needsApproval: false };

interface DesktopBridge {
  accountScope?: string;
  platform?: string;
  nativeTitleBar?: boolean;
  corePort(): Promise<number>;
  dataDir(): Promise<string>;
  /** Absent in shells older than 0.1.2. */
  version?(): Promise<{ version: string; update: UpdateStatus }>;
  checkForUpdate?(): Promise<UpdateStatus>;
  installUpdate?(): void;
  /** Absent in shells that predate launch at login. */
  loginItem?(): Promise<LoginItemState>;
  setLoginItem?(on: boolean): Promise<LoginItemState>;
  onMediaKey(handler: (action: string) => void): () => void;
  onCoreStatus(handler: (status: { running: boolean; code?: number }) => void): () => void;
  auth: {
    accounts?(): Promise<SavedAccounts>;
    channels?(): Promise<SavedAccounts>;
    switchAccount?(id: string): Promise<AuthResult>;
    selectChannel?(id: string): Promise<AuthResult>;
    removeAccount?(id: string): Promise<AuthResult>;
    signIn(): Promise<AuthResult>;
    refresh(): Promise<AuthResult>;
    signOut(): Promise<AuthResult>;
    status(): Promise<{ hasCredentials: boolean }>;
  };
  isDesktop: true;
  /** Absolute origin of the Go core. See lib/base.ts for why this exists. */
  coreOrigin?: string;

  /** Tray icon, flyout and taskbar buttons. Absent in older shells. */
  tray?: {
    setState(state: TrayState): void;
    setCloseToTray(on: boolean): void;
    /** Returns an unsubscribe function. */
    onAction(fn: (action: TrayAction) => void): () => void;
  };

  /** The mini player window's shell-side controls. Absent in older shells. */
  mini?: {
    prefs(): Promise<{ alwaysOnTop: boolean }>;
    setAlwaysOnTop(on: boolean): void;
    ensureSize(width: number, height: number): void;
  };

  /** Title-bar controls, present because the window is frameless. */
  window?: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    /** Windows: caption buttons drawn straight over fullscreen content. */
    setImmersiveTitleBar?(on: boolean): void;
    showMain?(): void;
    /** Returns an unsubscribe function. */
    onMaximizeChange(fn: (maximized: boolean) => void): () => void;
  };
}

declare global {
  interface Window {
    spotifier?: DesktopBridge;
  }
}

export const desktop = {
  get isMac(): boolean {
    return typeof window !== "undefined" && window.spotifier?.platform === "darwin";
  },
  get available(): boolean {
    return typeof window !== "undefined" && window.spotifier?.isDesktop === true;
  },

  /**
   * Opens sign-in in a window the app owns.
   *
   * In a plain browser there is nowhere to own a session, so this reports that
   * rather than pretending to succeed.
   */
  async signIn(): Promise<AuthResult> {
    if (!window.spotifier) {
      return { ok: false, reason: "sign-in requires the desktop app" };
    }
    return window.spotifier.auth.signIn();
  },

  async signOut(): Promise<AuthResult> {
    if (!window.spotifier) return { ok: false, reason: "unavailable" };
    return window.spotifier.auth.signOut();
  },

  /** Re-reads the owned session. Cheap, and the answer to cookie rotation. */
  async refreshAuth(): Promise<AuthResult> {
    if (!window.spotifier) return { ok: false, reason: "unavailable" };
    return window.spotifier.auth.refresh();
  },

  /** This copy's version and the updater's state, or null outside the desktop app. */
  async version(): Promise<{ version: string; update: UpdateStatus } | null> {
    return (await window.spotifier?.version?.()) ?? null;
  },

  /** Launch at login as the OS has it; unsupported outside a packaged desktop build. */
  async loginItem(): Promise<LoginItemState> {
    return (await window.spotifier?.loginItem?.()) ?? NO_LOGIN_ITEM;
  },

  /** Registers or removes the login entry, and returns what the OS now says. */
  async setLoginItem(on: boolean): Promise<LoginItemState> {
    return (await window.spotifier?.setLoginItem?.(on)) ?? NO_LOGIN_ITEM;
  },

  /** Asks the updater to look now. A found update downloads on its own. */
  async checkForUpdate(): Promise<UpdateStatus | null> {
    return (await window.spotifier?.checkForUpdate?.()) ?? null;
  },

  /** Quits, installs the waiting update and starts again. */
  installUpdate(): void {
    window.spotifier?.installUpdate?.();
  },

  /** Hardware media keys. Returns an unsubscribe function, or a no-op. */
  onMediaKey(handler: (action: string) => void): () => void {
    return window.spotifier?.onMediaKey(handler) ?? (() => {});
  },

  onCoreStatus(handler: (s: { running: boolean; code?: number }) => void): () => void {
    return window.spotifier?.onCoreStatus(handler) ?? (() => {});
  },

  /** The snapshot every tray surface draws from. */
  setTrayState(state: TrayState): void {
    window.spotifier?.tray?.setState(state);
  },

  setCloseToTray(on: boolean): void {
    window.spotifier?.tray?.setCloseToTray(on);
  },

  /** Brings the main window back, from the tray or the mini player. */
  showMainWindow(): void {
    window.spotifier?.window?.showMain?.();
    window.focus();
  },

  /** Actions from the tray, the flyout and the taskbar buttons. */
  onTrayAction(fn: (action: TrayAction) => void): () => void {
    return window.spotifier?.tray?.onAction(fn) ?? (() => {});
  },
};
