import { useEffect, useRef, useState, type RefObject } from "react";
import { WindowControls } from "./WindowControls";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { signInLabel, useSignIn } from "../lib/signin";
import { IconBrowse, IconHome, IconChevronLeft, IconChevronRight, IconSearch, IconSettings } from "./Icon";
import { useTogether } from "../lib/together";
import { WhatsNew } from "./WhatsNew";
import { AccountMenu } from "./AccountMenu";

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
  const roomStatus = useTogether(s => s.status);
  const location = useLocation();
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

  const { signingIn, signIn } = useSignIn();

  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: ({ signal }) => api.me(signal),
    staleTime: 60_000,
  });

  return (
    <header className="topbar" data-scrolled={scrolled || undefined}>
      <div className="topbar__nav">
        <button className="iconbtn topbar__history" aria-label="Go back" onClick={() => navigate(-1)}>
          <IconChevronLeft size={30} />
        </button>
        <button
          className="iconbtn topbar__history"
          aria-label="Go forward"
          onClick={() => navigate(1)}
        >
          <IconChevronRight size={30} />
        </button>
      </div>

      <div className="topbar__search-group">
      <button className="iconbtn topbar__home" aria-label="Home" onClick={() => navigate("/")}><IconHome size={24} filled={location.pathname === "/"} /></button>
      <div className="searchfield" onClick={() => inputRef.current?.focus()}>
        {/* On the search page already, only focus: navigating would drop ?q=. */}
        <button className="iconbtn" aria-label="Search" onClick={() => { if (location.pathname !== "/search") navigate("/search"); inputRef.current?.focus(); }}><IconSearch size={20} /></button>
        <input
          aria-label="Search music"
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
        <button className="iconbtn searchfield__browse" aria-label="Browse all" onClick={e => { e.stopPropagation(); setLocal(""); navigate("/search"); }}><IconBrowse size={22} /></button>
      </div>
      </div>

      <div className="topbar__spacer" />
      <WhatsNew />
      <button className="iconbtn" aria-label={roomStatus === "connected" ? "Listen Together — connected" : "Listen Together"} onClick={() => navigate("/together")} data-room-active={roomStatus === "connected" || undefined}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 14v-3a9 9 0 0 1 18 0v3M3 13h3v8H3zM18 13h3v8h-3z" /></svg>
      </button>

      <button
        className="iconbtn"
        aria-label="Settings"
        onClick={() => navigate("/settings")}
      >
        <IconSettings size={20} />
      </button>

      {me?.state === "signed_in" && me.account ? (
        <AccountMenu account={me.account} />
      ) : me?.state === "logged_out" ? (
        <button className="chip" onClick={() => void signIn()} disabled={signingIn}>
          {signInLabel(signingIn)}
        </button>
      ) : null}

      <WindowControls />
    </header>
  );
}
