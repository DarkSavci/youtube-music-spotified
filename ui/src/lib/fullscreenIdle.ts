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
    // Hidden controls are not focusable. Reveal before moving focus into them.
    if (e.key === 'Tab' && root.dataset.controlsHidden === 'true') {
      e.preventDefault();
      reveal();
      win.requestAnimationFrame(() => { if (!disposed) root.querySelector<HTMLButtonElement>('.fsp__close')?.focus(); });
    } else reveal();
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
