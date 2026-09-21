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
  onSelect: () => void;
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

function Menu({ state, onClose }: { state: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });
  const [active, setActive] = useState(0);

  /*
   * Keep the menu on screen.
   *
   * Measured after mount rather than estimated, because the height depends on
   * how many items the caller passed. A menu opened near the bottom edge
   * otherwise runs off it, which is where right-clicks in a long list land.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      x: Math.min(state.x, window.innerWidth - width - pad),
      y: Math.min(state.y, window.innerHeight - height - pad),
    });
  }, [state]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => {
          const step = e.key === "ArrowDown" ? 1 : -1;
          const n = state.items.length;
          // Skip disabled entries, or the keyboard stops on dead rows.
          for (let k = 1; k <= n; k += 1) {
            const next = (i + step * k + n * k) % n;
            if (!state.items[next]?.disabled) return next;
          }
          return i;
        });
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = state.items[active];
        if (item && !item.disabled) {
          item.onSelect();
          onClose();
        }
      }
    };
    // A scroll under an open menu leaves it pointing at nothing.
    const onScroll = () => onClose();

    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose, state.items, active]);

  return (
    <div
      ref={ref}
      className="ctxmenu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      // A second right-click inside the menu should not open another one.
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.items.map((item, i) => (
        <button
          key={item.label}
          role="menuitem"
          className="ctxmenu__item"
          data-separated={item.separated || undefined}
          data-active={i === active || undefined}
          disabled={item.disabled}
          onMouseEnter={() => setActive(i)}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
