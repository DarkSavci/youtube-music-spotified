import { create } from "zustand";

/**
 * A short confirmation at the bottom of the window.
 *
 * For actions whose result is otherwise invisible — copying a link changes
 * nothing on screen, so without this there is no way to know it worked.
 * One at a time: a new message replaces the old one rather than stacking.
 */
interface ToastState {
  message: string | null;
  /** Bumped on every show, so repeating the same message restarts its timer. */
  seq: number;
  show: (message: string) => void;
  hide: () => void;
}

export const useToast = create<ToastState>((set) => ({
  message: null,
  seq: 0,
  show: (message) => set((s) => ({ message, seq: s.seq + 1 })),
  hide: () => set({ message: null }),
}));

export function toast(message: string) {
  useToast.getState().show(message);
}
