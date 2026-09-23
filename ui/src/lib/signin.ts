import { create } from "zustand";
import { desktop } from "./desktop";

/**
 * Signing in, shared by every button that offers it.
 *
 * There were three — the top bar, the library sidebar and Settings — each with
 * its own idea of what signing in meant. The sidebar's was a page reload, so
 * pressing it did nothing but flash the window. One hook means one behaviour,
 * and one "in progress" state that every button can show.
 *
 * On success the desktop shell restarts the core and reloads the window, so
 * there is nothing left to do here; the reload takes the whole app, and every
 * cached page with it, onto the new account.
 */
interface SignInState {
  signingIn: boolean;
  /** Why the last attempt failed, in words for the person who tried. */
  problem: string | null;
  signIn: () => Promise<void>;
}

export const useSignIn = create<SignInState>((set, get) => ({
  signingIn: false,
  problem: null,
  signIn: async () => {
    if (get().signingIn || !desktop.available) return;
    set({ signingIn: true, problem: null });
    try {
      const result = await desktop.signIn();
      if (!result.ok) {
        set({
          problem:
            result.reason === "not-signed-in"
              ? "The browser closed before sign-in finished."
              : result.reason === "closed"
                ? null
                : result.reason === "browser-not-found"
                  ? "Install Chrome, Edge, Brave, or Chromium in Applications to sign in."
                  : "Sign-in did not complete. Try again.",
        });
      }
    } finally {
      set({ signingIn: false });
    }
  },
}));

/** The button label, which also tells the person where to look. */
export function signInLabel(signingIn: boolean): string {
  return signingIn ? "Finish in your browser…" : "Sign in";
}
