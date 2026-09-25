/**
 * The player is a modal dialog, so Tab stays inside it: from the player itself
 * it starts at the first control (Shift: the last), and it wraps at either end
 * instead of reaching the app underneath. Handles each event once.
 */
export function trapTab(root: HTMLElement, e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  const focusable = [...root.querySelectorAll<HTMLElement>('.fsp__close, .fsp__foot button:not([disabled]), .fsp__foot input')];
  const first = focusable[0], last = focusable[focusable.length - 1];
  const active = root.ownerDocument.activeElement;
  const target = !root.contains(active) || active === root ? (e.shiftKey ? last : first)
    : e.shiftKey && active === first ? last
    : !e.shiftKey && active === last ? first
    : null;
  if (target) { e.preventDefault(); target.focus(); }
}

/** Fullscreen chrome stays available during keyboard, pointer and dialog use. */
export function watchFullscreenIdle(root: HTMLElement, hide: (hidden: boolean) => void, delay = 3000) {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  let timer: ReturnType<typeof setTimeout>;
  let dragging = false;
  let keyboard = false;
  let overControls = false;
  let disposed = false;
  const controls = '.fsp__foot, .fsp__close, .fsp__context';
  const reveal = () => {
    hide(false);
    clearTimeout(timer);
    timer = setTimeout(check, delay);
  };
  const check = () => {
    if (disposed) return;
    const focused = keyboard && root.contains(doc.activeElement) && doc.activeElement !== root;
    const overlay = doc.querySelector('[role="menu"], [role="alertdialog"], dialog[open]');
    if (dragging || overControls || focused || overlay) timer = setTimeout(check, delay);
    else hide(true);
  };
  const move = (e: PointerEvent) => { overControls = Boolean((e.target as Element)?.closest?.(controls)); reveal(); };
  const down = () => { dragging = true; keyboard = false; reveal(); };
  const up = () => { dragging = false; reveal(); };
  const leave = () => { overControls = false; reveal(); };
  const key = (e: KeyboardEvent) => {
    keyboard = true;
    reveal();
    if (e.key === 'Tab') trapTab(root, e);
  };
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerdown', down);
  root.addEventListener('pointerleave', leave);
  root.addEventListener('focusin', reveal);
  win.addEventListener('pointerup', up);
  win.addEventListener('pointercancel', up);
  win.addEventListener('keydown', key, true);
  reveal();
  return () => {
    disposed = true; clearTimeout(timer);
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerdown', down);
    root.removeEventListener('pointerleave', leave);
    root.removeEventListener('focusin', reveal);
    win.removeEventListener('pointerup', up);
    win.removeEventListener('pointercancel', up);
    win.removeEventListener('keydown', key, true);
  };
}
