/**
 * Bridge to the desktop shell.
 *
 * Every capability here is optional: the same UI runs in a plain browser,
 * where `window.spotifier` is simply absent. Callers check `isDesktop` rather
 * than assuming, so nothing has to be stubbed out for the web build.
 */

export interface AuthResult {
  ok: boolean;
  count?: number;
  reason?: string;
}

interface DesktopBridge {
  corePort(): Promise<number>;
  dataDir(): Promise<string>;
  onMediaKey(handler: (action: string) => void): () => void;
  onCoreStatus(handler: (status: { running: boolean; code?: number }) => void): () => void;
  auth: {
    signIn(): Promise<AuthResult>;
    refresh(): Promise<AuthResult>;
    signOut(): Promise<AuthResult>;
    status(): Promise<{ hasCredentials: boolean }>;
  };
  isDesktop: true;
  /** Absolute origin of the Go core. See lib/base.ts for why this exists. */
  coreOrigin?: string;

  /** Title-bar controls, present because the window is frameless. */
  window?: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
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

  /** Hardware media keys. Returns an unsubscribe function, or a no-op. */
  onMediaKey(handler: (action: string) => void): () => void {
    return window.spotifier?.onMediaKey(handler) ?? (() => {});
  },

  onCoreStatus(handler: (s: { running: boolean; code?: number }) => void): () => void {
    return window.spotifier?.onCoreStatus(handler) ?? (() => {});
  },
};
