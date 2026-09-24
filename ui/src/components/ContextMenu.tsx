import { IconChevronRight, IconPlus, IconQueue, IconPlay, IconShare, IconHeart, IconLibrary, IconFolder, IconDelete, IconArtist, IconAlbum, IconRadio, IconPin } from "./Icon";
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
} from "react";

/**
 * Right-click menus.
 *
 * One menu exists at a time, owned here, and any component opens it by calling
 * `useMenu().open(event, items)`. The alternative — each row rendering its own
 * hidden menu — puts a subtree behind every track in a virtualised list of
 * thousands, and leaves each of them to re-solve dismissal, edge flipping and
 * keyboard handling.
 *
 * Items are data, so a caller decides what a menu contains without knowing how
 * one behaves.
 */

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  children?: MenuItem[];
  icon?: React.ReactNode;
  /** Draws a rule above this item, for grouping unlike actions. */
  separated?: boolean;
  disabled?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

interface MenuApi {
  open: (e: React.MouseEvent, items: MenuItem[]) => void;
}

const Ctx = createContext<MenuApi>({ open: () => {} });

export function useMenu(): MenuApi {
  return useContext(Ctx);
}

export function MenuProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MenuState | null>(null);

  const open = useCallback((e: React.MouseEvent, items: MenuItem[]) => {
    if (items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, items });
  }, []);

  return (
    <Ctx.Provider value={{ open }}>
      {children}
      {state ? <Menu state={state} onClose={() => setState(null)} /> : null}
    </Ctx.Provider>
  );
}

function itemIcon(item: MenuItem) {
  if (item.icon) return item.icon;
  const label = item.label.toLowerCase();
  const Icon = label.includes("delete") || label.startsWith("remove") ? IconDelete
    : label.includes("radio") ? IconRadio : label.includes("album") ? IconAlbum
    : label.includes("folder") || label.startsWith("move to") ? IconFolder
    : label.includes("queue") ? IconQueue : label.startsWith("play") ? IconPlay
    : label.includes("share") || label.includes("copy") ? IconShare
    : label.includes("pin") ? IconPin : label.includes("save") || label.includes("liked") ? IconHeart
    : label.startsWith("go to") ? IconArtist : label.includes("playlist") || label.startsWith("create") ? IconPlus : IconLibrary;
  return <Icon size={18} />;
}

function Menu({ state, onClose }: { state: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const doc = ref.current?.ownerDocument ?? document;
    const view = doc.defaultView ?? window;
    const outside = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); };
    view.addEventListener("keydown", escape);
    doc.addEventListener("mousedown", outside);
    view.addEventListener("scroll", outside, true);
    view.addEventListener("resize", onClose);
    return () => { view.removeEventListener("keydown", escape); doc.removeEventListener("mousedown", outside); view.removeEventListener("scroll", outside, true); view.removeEventListener("resize", onClose); };
  }, [onClose]);
  return <div ref={ref}><MenuPanel items={state.items} x={state.x} y={state.y} onClose={onClose} /></div>;
}

function MenuPanel({ items, x, y, onClose, onBack, anchor }: {
  items: MenuItem[]; x: number; y: number; onClose: () => void; onBack?: () => void; anchor?: DOMRect;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect } | null>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const view = el.ownerDocument.defaultView ?? window;
    const box = el.getBoundingClientRect();
    const left = anchor && x + box.width > view.innerWidth - 8 ? anchor.left - box.width : x;
    setPos({ x: Math.max(8, Math.min(left, view.innerWidth - box.width - 8)), y: Math.max(8, Math.min(y, view.innerHeight - box.height - 8)) });
    buttons.current.find(b => b && !b.disabled)?.focus({ preventScroll: true });
  }, [x, y, anchor]);
  const openSub = (i: number) => {
    const button = buttons.current[i];
    if (items[i]?.children?.length && button) setSub({ index: i, rect: button.getBoundingClientRect() });
  };
  const choose = (i: number) => {
    const item = items[i];
    if (!item || item.disabled) return;
    if (item.children) openSub(i);
    else { item.onSelect?.(); onClose(); }
  };
  return <div ref={ref} className="ctxmenu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={e => e.preventDefault()}
    onKeyDown={e => {
      e.stopPropagation();
      if (e.key === "Escape" || e.key === "ArrowLeft") { e.preventDefault(); (onBack ?? onClose)(); }
      else if (e.key === "Tab") onClose();
      else if (e.key === "ArrowRight") { e.preventDefault(); openSub(active); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        for (let n = 1; n <= items.length; n++) {
          const next = (active + step * n + items.length) % items.length;
          if (!items[next]?.disabled) { setActive(next); setSub(null); buttons.current[next]?.focus(); break; }
        }
      }
    }}>
    <div className="ctxmenu__scroll" onScroll={() => setSub(null)}>
      {items.map((item, i) => <button key={`${item.label}:${i}`} ref={el => { buttons.current[i] = el; }} role="menuitem" className="ctxmenu__item"
        aria-haspopup={item.children ? "menu" : undefined} aria-expanded={item.children ? sub?.index === i : undefined}
        data-separated={item.separated || undefined} data-active={active === i || undefined} disabled={item.disabled}
        onFocus={() => setActive(i)} onMouseEnter={() => { setActive(i); if (item.children) openSub(i); else setSub(null); }} onClick={() => choose(i)}>
        {itemIcon(item)}<span>{item.label}</span>{item.children ? <IconChevronRight size={16} /> : null}
      </button>)}
    </div>
    {sub && items[sub.index]?.children ? <MenuPanel key={sub.index} items={items[sub.index]!.children!}
      x={sub.rect.right} y={sub.rect.top} anchor={sub.rect} onClose={onClose}
      onBack={() => { const i = sub.index; setSub(null); buttons.current[i]?.focus(); }} /> : null}
  </div>;
}
