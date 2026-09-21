import { useEffect, useRef, useState, type RefObject } from "react";
import { WindowControls } from "./WindowControls";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { desktop } from "../lib/desktop";
import { signInLabel, useSignIn } from "../lib/signin";
import { IconChevronLeft, IconChevronRight, IconSearch, IconSettings } from "./Icon";
import { useMenu } from "./ContextMenu";
import { usePrompt } from "./Prompt";

/**
 * The header fades in a background once the panel beneath it scrolls, so the
 * artwork gradient on an entity page reads as continuous at rest.
 */
export function TopBar({
  scrollRef,
  query,
  onQueryChange,
}: {
  scrollRef: RefObject<HTMLElement>;
  query?: string;
  onQueryChange?: (value: string) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const menu = useMenu();
  const prompt = usePrompt();
  const [scrolled, setScrolled] = useState(false);
  const [params] = useSearchParams();

  /*
   * The box mirrors the query in the URL.
   *
   * It used to hold purely local state, so arriving at a search from anywhere
   * but the box itself — a recent search, a mood tile, the back button — left
   * results on screen and the field empty, which reads as a search nobody
   * asked for.
   */
  const urlQuery = location.pathname === "/search" ? (params.get("q") ?? "") : "";
  const [local, setLocal] = useState(query ?? urlQuery);
  useEffect(() => {
    if (!onQueryChange) setLocal(urlQuery);
  }, [urlQuery, onQueryChange]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setScrolled(el.scrollTop > 8);
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef]);

  // "/" focuses search from anywhere, unless the caret is already in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        navigate("/search");
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const queryClient = useQueryClient();
  const { signingIn, signIn } = useSignIn();

  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: ({ signal }) => api.me(signal),
    staleTime: 60_000,
  });

  return (
    <header className="topbar" data-scrolled={scrolled || undefined}>
      <div className="topbar__nav">
        <button className="iconbtn iconbtn--round" aria-label="Go back" onClick={() => navigate(-1)}>
          <IconChevronLeft size={20} />
        </button>
        <button
          className="iconbtn iconbtn--round"
          aria-label="Go forward"
          onClick={() => navigate(1)}
        >
          <IconChevronRight size={20} />
        </button>
      </div>

      <label className="searchfield">
        <IconSearch size={18} />
        <span className="sr-only">Search</span>
        <input
          ref={inputRef}
          type="search"
          placeholder="What do you want to listen to?"
          value={onQueryChange ? (query ?? "") : local}
          onChange={(e) => {
            const value = e.target.value;
            if (onQueryChange) onQueryChange(value);
            else {
              setLocal(value);
              // Clearing the box returns to browse. Leaving the old query in
              // the URL made an emptied field look like a stuck search, and
              // kept recent searches — which only show with nothing typed —
              // permanently out of reach.
              if (value) navigate(`/search?q=${encodeURIComponent(value)}`);
              else if (location.pathname === "/search") navigate("/search", { replace: true });
            }
          }}
        />
      </label>

      <div className="topbar__spacer" />

      <button
        className="iconbtn"
        aria-label="Settings"
        onClick={() => navigate("/settings")}
      >
        <IconSettings size={20} />
      </button>

      {me?.state === "signed_in" && me.account ? (
        <button
          className="topbar__account"
          aria-label={`Account: ${me.account.name}`}
          title={me.account.handle ?? ""}
          onClick={(e) =>
            menu.open(e, [
              {
                label: "Settings",
                onSelect: () => navigate("/settings"),
              },
              {
                label: "Sign out",
                separated: true,
                onSelect: () => {
                  void (async () => {
                    const sure = await prompt.confirm({
                      title: "Sign out?",
                      body: "Youtube Music Spotified will forget this account until you sign in again. Your listening history stays on this machine.",
                      confirmLabel: "Sign out",
                      danger: true,
                    });
                    if (!sure) return;
                    await desktop.signOut();
                    await queryClient.invalidateQueries();
                  })();
                },
              },
            ])
          }
        >
          {me.account.avatarUrl ? (
            <img className="topbar__avatar" src={me.account.avatarUrl} alt="" />
          ) : null}
          <span className="truncate">{me.account.name}</span>
        </button>
      ) : me?.state === "logged_out" ? (
        <button className="chip" onClick={() => void signIn()} disabled={signingIn}>
          {signInLabel(signingIn)}
        </button>
      ) : null}

      <WindowControls />
    </header>
  );
}
