import { useCallback, useEffect, useRef, useState } from "react";
import { signInLabel, useSignIn } from "../lib/signin";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import type { LibraryItem } from "../lib/types";
import { artworkAtLeast } from "../lib/types";
import { useMenu, type MenuItem } from "./ContextMenu";
import {
  useCreateFolder, useCreatePlaylist, useDeleteFolder, useDeletePlaylist, useFolders,
  useOrganise,
} from "../lib/playlists";
import { usePrompt } from "./Prompt";
import {
  IconExpand, IconCollapse, IconChevronLeft, IconChevronRight, IconGrid, IconLibrary, IconList,
  IconPlus, IconSearch,
} from "./Icon";

type Filter = "" | "playlists" | "artists" | "albums";
type Sort = "alphabetical" | "creator" | "recents" | "recently_added";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "playlists", label: "Playlists" },
  { id: "artists", label: "Artists" },
  { id: "albums", label: "Albums" },
];

const SORTS: { id: Sort; label: string }[] = [
  { id: "recents", label: "Recents" },
  { id: "recently_added", label: "Recently added" },
  { id: "alphabetical", label: "Alphabetical" },
  { id: "creator", label: "Creator" },
];

/**
 * The merged library rail.
 *
 * One sorted list of everything saved, which YouTube Music does not provide —
 * the Go `library` module fans out across four separate surfaces and merges
 * them. This component only renders the result.
 *
 * Width is user-draggable, and the contents respond to the *container* rather
 * than the viewport, so the rail can collapse to artwork-only independently of
 * the window size.
 */
export function LibrarySidebar({ expanded, onExpand, onNavigate }: { expanded: boolean; onExpand: () => void; onNavigate: () => void }) {
  const menu = useMenu();
  const prompt = usePrompt();
  const createPlaylist = useCreatePlaylist();
  const createFolder = useCreateFolder();
  const organise = useOrganise();
  const deletePlaylist = useDeletePlaylist();
  const deleteFolder = useDeleteFolder();
  const folders = useFolders();

  /*
   * What a right-click on a library row offers.
   *
   * Pinning and filing are ours rather than YouTube's, which is why they are
   * here and not in the track menu: they arrange the sidebar, and the sidebar
   * is the only place they mean anything.
   */
  const itemMenu = (item: LibraryItem): MenuItem[] => {
    const out: MenuItem[] = [
      {
        label: item.pinned ? "Unpin" : "Pin to top",
        onSelect: () =>
          organise.mutate({ kind: item.kind, itemId: item.id, pinned: !item.pinned }),
      },
    ];
    for (const f of folders) {
      if (f.id === item.folderId) continue;
      out.push({
        label: `Move to ${f.name}`,
        separated: out.length === 1,
        onSelect: () =>
          organise.mutate({ kind: item.kind, itemId: item.id, folderId: f.id }),
      });
    }
    if (item.folderId) {
      out.push({
        label: "Remove from folder",
        onSelect: () => organise.mutate({ kind: item.kind, itemId: item.id, folderId: "" }),
      });
    }
    // Deleting is offered only for playlists, and only with a confirmation:
    // it is the one action here that cannot be undone.
    if (item.kind === "playlist" && item.id !== "LM") {
      out.push({
        label: "Delete playlist",
        separated: true,
        onSelect: () => {
          void (async () => {
            const sure = await prompt.confirm({
              title: `Delete ${item.title}?`,
              body: "This removes the playlist from your YouTube Music account. It cannot be undone.",
              confirmLabel: "Delete",
              danger: true,
            });
            if (sure) deletePlaylist.mutate(item.id);
          })();
        },
      });
    }
    return out;
  };

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("");
  const [sort, setSort] = useState<Sort>("recents");
  const [compact, setCompact] = useState(false);
  const [width, setWidth] = useState(() => readStoredWidth());
  const dragging = useRef(false);
  const asideRef = useRef<HTMLElement>(null);

  const { data, isPending, error } = useQuery({
    queryKey: ["library", filter, sort],
    queryFn: ({ signal }) => api.library(filter, sort, signal),
    retry: (count, err) => !(err instanceof ApiError && err.reauth) && count < 2,
  });

  // Drag to resize. Pointer events are captured on the window so the drag
  // survives the cursor leaving the thin handle.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startWidth = asideRef.current?.offsetWidth ?? width;

    const onMove = (ev: PointerEvent) => {
      if (!dragging.current) return;
      const next = clampWidth(startWidth + (ev.clientX - startX));
      setWidth(next);
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try {
        localStorage.setItem("sidebar.width", String(asideRef.current?.offsetWidth ?? ""));
      } catch {
        /* private mode or blocked storage; the width simply is not remembered */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [width]);

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  }, [width]);

  const query = search.trim().toLocaleLowerCase();
  const items = (data ?? []).filter(item => !query || `${item.title} ${item.subtitle ?? ""} ${folders.find(f => f.id === item.folderId)?.name ?? ""}`.toLocaleLowerCase().includes(query));

  return (
    <aside ref={asideRef} className="sidebar panel" data-expanded={expanded || undefined} data-grid={expanded && !compact || undefined} aria-label="Your library" onClick={e => { if ((e.target as HTMLElement).closest("a")) onNavigate(); }}>
      <div className="sidebar__header">
        <button
          className="sidebar__title"
          onClick={() => { const next = width <= 170 ? 280 : 72; setWidth(next); try { localStorage.setItem("sidebar.width", String(next)); } catch {} }}
          aria-label="Toggle library width"
        >
          {/* The library is always the surface it sits on, so it is always
              the one you are looking at. */}
          <span className="sidebar__toggle"><IconLibrary className="sidebar__library-icon" size={22} filled />{width <= 170 ? <IconChevronRight className="sidebar__collapse-icon" size={22} /> : <IconChevronLeft className="sidebar__collapse-icon" size={22} />}</span>
          <span>Your Library</span>
        </button>
        <div className="sidebar__actions">
          <button
            className="iconbtn"
            aria-label="Create playlist or folder"
            onClick={(e) =>
              menu.open(e, [
                {
                  label: "Create a playlist",
                  onSelect: () => {
                    void (async () => {
                      const name = await prompt.text({
                        title: "New playlist",
                        label: "Name",
                        initial: "My playlist",
                      });
                      if (name) createPlaylist.mutate({ title: name });
                    })();
                  },
                },
                {
                  label: "Create a folder",
                  onSelect: () => {
                    void (async () => {
                      const name = await prompt.text({
                        title: "New folder",
                        label: "Name",
                        initial: "New folder",
                      });
                      if (name) createFolder.mutate(name);
                    })();
                  },
                },
              ])
            }
          >
            <IconPlus size={18} />
          </button>
          <button className="iconbtn" aria-label={expanded ? "Collapse library view" : "Expand library view"} title={expanded ? "Collapse library view" : "Expand library view"} onClick={onExpand}>{expanded ? <IconCollapse size={18} /> : <IconExpand size={18} />}</button>
        </div>
      </div>

      <div className="sidebar__chips" role="group" aria-label="Filter library">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className="chip"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(filter === f.id ? "" : f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <label className="sidebar__search"><IconSearch size={16} /><input type="search" aria-label="Search in your library" placeholder="Search in your library" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="sidebar__tools">
        <select
          className="sidebar__sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          aria-label="Sort library"
          style={{ background: "transparent", border: "none" }}
        >
          {SORTS.map((s) => (
            <option key={s.id} value={s.id} style={{ background: "var(--surface-card)" }}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          className="iconbtn"
          aria-label={compact ? "Show as grid" : "Show as list"}
          onClick={() => setCompact((c) => !c)}
        >
          {compact ? <IconGrid size={16} /> : <IconList size={16} />}
        </button>
      </div>

      <div className="sidebar__list scroll">
        <LibraryList
          artworkSize={expanded ? 320 : 96}
          searching={Boolean(query)}
          items={items}
          folders={folders}
          isPending={isPending}
          error={error}
          onItemMenu={(e, item) => menu.open(e, itemMenu(item))}
          onFolderMenu={(e, folder) =>
            menu.open(e, [
              {
                label: "Delete folder",
                onSelect: () => {
                  void (async () => {
                    const sure = await prompt.confirm({
                      title: `Delete ${folder.name}?`,
                      body: "Anything inside returns to the top level. Nothing is removed from your library.",
                      confirmLabel: "Delete folder",
                      danger: true,
                    });
                    if (sure) deleteFolder.mutate(folder.id);
                  })();
                },
              },
            ])
          }
        />
      </div>

      <div
        className="sidebar__resizer"
        onPointerDown={onPointerDown}
        data-dragging={dragging.current || undefined}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize library"
      />
    </aside>
  );
}

/**
 * Every state the list can be in gets an explicit branch. A list that is
 * loading, empty, failed or signed-out must each say so and offer the action
 * that resolves it — silence reads as breakage.
 */
function LibraryList({
  artworkSize,
  searching,
  items,
  folders,
  isPending,
  error,
  onItemMenu,
  onFolderMenu,
}: {
  artworkSize: number;
  searching: boolean;
  items: LibraryItem[];
  folders: { id: string; name: string }[];
  isPending: boolean;
  error: unknown;
  onFolderMenu: (e: React.MouseEvent, folder: { id: string; name: string }) => void;
  /** Opens the row's menu. Passed down because the actions need the
      sidebar's hooks, and the rows are rendered here. */
  onItemMenu: (e: React.MouseEvent, item: LibraryItem) => void;
}) {
  if (isPending) {
    return (
      <ul aria-busy="true" aria-label="Loading library">
        {Array.from({ length: 7 }, (_, i) => (
          <li key={i} className="libitem">
            <div className="libitem__art skeleton" />
            <div className="libitem__text">
              <div className="skeleton skeleton--line" style={{ width: "70%" }} />
              <div className="skeleton skeleton--line" style={{ width: "45%" }} />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (error instanceof ApiError && error.reauth) {
    return (
      <SignedOutState />
    );
  }
  if (error instanceof ApiError && error.status === 0) {
    return <EmptyState title="Offline" body="Cannot reach the player core." action="Retry" />;
  }
  if (error) {
    return <EmptyState title="Could not load your library" body={String(error)} action="Retry" />;
  }
  if (items.length === 0 && searching) return <p className="library-no-results">No matches in your library.</p>;
  if (items.length === 0) {
    return (
      <EmptyState
        title="Nothing saved yet"
        body="Albums, artists and playlists you save will appear here."
        action="Browse"
      />
    );
  }

  /*
   * Rows are grouped under the folder they were filed into.
   *
   * Folders could be created and filed into long before this, which made them
   * invisible: the only way to see one was to open an item's menu. Grouping
   * keeps the chosen sort inside each group rather than sorting the groups
   * themselves, so "alphabetical" still means what it says.
   */
  const byFolder = new Map<string, LibraryItem[]>();
  for (const item of items) {
    const key = item.folderId ?? "";
    const list = byFolder.get(key);
    if (list) list.push(item);
    else byFolder.set(key, [item]);
  }
  const named = folders.filter((f) => (byFolder.get(f.id) ?? []).length > 0);
  const loose = byFolder.get("") ?? [];

  return (
    <ul>
      {named.map((folder) => (
        <li key={folder.id}>
          <div
            className="libfolder"
            onContextMenu={(e) => onFolderMenu(e, folder)}
          >
            <IconLibrary size={14} />
            <span className="truncate">{folder.name}</span>
            <span className="libfolder__count">
              {(byFolder.get(folder.id) ?? []).length}
            </span>
          </div>
          <ul className="libfolder__items">
            {(byFolder.get(folder.id) ?? []).map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                <NavLink
                  to={routeFor(item)}
                  className="libitem"
                  data-pinned={item.pinned || undefined}
                  onContextMenu={(e) => onItemMenu(e, item)}
                >
                  <img
                    className={`libitem__art ${item.kind === "artist" ? "libitem__art--round" : ""}`}
                    src={artworkAtLeast(item.artwork, artworkSize)}
                    alt=""
                    loading="lazy"
                  />
                  <span className="libitem__text">
                    <span className="libitem__title truncate">{item.title}</span>
                    <span className="libitem__sub truncate">{item.subtitle}</span>
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        </li>
      ))}
      {loose.map((item) => (
        <li key={`${item.kind}:${item.id}`}>
          <NavLink
            to={routeFor(item)}
            className="libitem"
            data-pinned={item.pinned || undefined}
            onContextMenu={(e) => onItemMenu(e, item)}
          >
            <img
              className={`libitem__art ${item.kind === "artist" ? "libitem__art--round" : ""}`}
              src={artworkAtLeast(item.artwork, artworkSize)}
              alt=""
              loading="lazy"
            />
            <span className="libitem__text">
              <span className="libitem__title truncate">{item.title}</span>
              <span className="libitem__sub truncate">
                {labelFor(item)}
              </span>
            </span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

/*
 * The signed-out state signs in.
 *
 * It used to share EmptyState's button, which reloads the page — right for
 * "Retry", and a button that did nothing for "Sign in".
 */
function SignedOutState() {
  const { signingIn, signIn, problem } = useSignIn();
  return (
    <div className="emptystate">
      <p className="emptystate__title">Signed out</p>
      <p className="emptystate__body">
        {signingIn
          ? "Sign in in the browser window. It closes by itself once you are in."
          : problem ?? "Sign in to see your library."}
      </p>
      <button className="chip" onClick={() => void signIn()} disabled={signingIn}>
        {signInLabel(signingIn)}
      </button>
    </div>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action: string }) {
  return (
    <div className="emptystate">
      <p className="emptystate__title">{title}</p>
      <p className="emptystate__body">{body}</p>
      <button className="chip" onClick={() => window.location.reload()}>
        {action}
      </button>
    </div>
  );
}

function labelFor(item: LibraryItem): string {
  const kind = item.kind[0]!.toUpperCase() + item.kind.slice(1);
  return item.subtitle ? `${kind} · ${item.subtitle}` : kind;
}

function routeFor(item: LibraryItem): string {
  switch (item.kind) {
    case "album":
      return `/album/${encodeURIComponent(item.id)}`;
    case "artist":
      return `/artist/${encodeURIComponent(item.id)}`;
    default:
      return `/playlist/${encodeURIComponent(item.id)}`;
  }
}

function clampWidth(px: number): number {
  return Math.min(420, Math.max(72, px));
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem("sidebar.width");
    if (raw) return clampWidth(Number(raw));
  } catch {
    /* storage unavailable; fall back to the default */
  }
  return 280;
}
