import { create } from "zustand";

/**
 * A short confirmation at the bottom of the window.
 *
 * For actions whose result is otherwise invisible — copying a link changes
 * nothing on screen, so without this there is no way to know it worked.
 * One at a time: a new message replaces the old one rather than stacking.
 */
export interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastState {
  message: string | null;
  /** A button beside the message, for a toast that offers somewhere to go. */
  action: ToastAction | null;
  /** Bumped on every show, so repeating the same message restarts its timer. */
  seq: number;
  show: (message: string, action?: ToastAction) => void;
  hide: () => void;
}

export const useToast = create<ToastState>((set) => ({
  message: null,
  action: null,
  seq: 0,
  show: (message, action) => set((s) => ({ message, action: action ?? null, seq: s.seq + 1 })),
  hide: () => set({ message: null, action: null }),
}));

export function toast(message: string, action?: ToastAction) {
  useToast.getState().show(message, action);
}
