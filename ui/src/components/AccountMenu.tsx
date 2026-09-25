import { IconEqualizerStatic, IconSettings, IconLibrary } from "./Icon";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { desktop, type AuthResult, type SavedAccounts } from "../lib/desktop";
import { useSignIn } from "../lib/signin";
import { usePrompt } from "./Prompt";

function Avatar({ name, url }: { name: string; url?: string }) {
  const [failed, setFailed] = useState<string>();
  return <span className="account-menu__avatar" aria-hidden="true">
    {url && failed !== url ? <img src={url} alt="" onError={() => setFailed(url)} /> : name.slice(0, 1)}
  </span>;
}

/** Anchored to the account chip, regardless of where inside it was clicked. */
export function AccountMenu({ account }: { account: { name: string; handle?: string; avatarUrl?: string } }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<SavedAccounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 8 });
  const navigate = useNavigate();
  const prompt = usePrompt();
  const { signIn, signingIn, problem } = useSignIn();
  const auth = window.spotifier?.auth;
  const active = saved?.accounts.find((item) => item.id === saved.activeId);
  const close = () => { setOpen(false); anchor.current?.focus(); };

  useEffect(() => {
    if (!open || !auth?.accounts) return;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const value = await auth.accounts!();
        if (!cancelled) setSaved(value);
        if (value.activeId && auth.channels) {
          const refreshed = await auth.channels();
          if (!cancelled) setSaved(refreshed);
        }
      } catch { if (!cancelled) setError("Could not load accounts. Try again in Settings."); }
    })();
    return () => { cancelled = true; };
  }, [open, auth]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current!.getBoundingClientRect();
      setPosition({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) });
    };
    place();
    panel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);

  async function run(action: () => Promise<AuthResult>) {
    if (busy || signingIn) return;
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) setError(result.reason || "Could not switch accounts. Try again.");
    } catch { setError("Could not complete the account change. Try again."); }
    finally { setBusy(false); }
  }

  return <>
    <button ref={anchor} className="topbar__account" aria-label={`Account: ${account.name}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? "account-menu" : undefined}
      title={account.handle ?? ""} onClick={() => setOpen(!open)}>
      {account.avatarUrl && <img className="topbar__avatar" src={account.avatarUrl} alt="" />}
      <span className="truncate">{account.name}</span>
    </button>
    {open && createPortal(<div ref={panel} id="account-menu" className="account-menu" role="menu" aria-label="Accounts and settings"
      tabIndex={-1} style={{ ...position, maxHeight: `calc(100vh - ${position.top + 8}px)` }}
      onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== anchor.current) setOpen(false); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); close(); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const buttons = Array.from(panel.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : (event.key === "End" || (event.key === "ArrowUp" && index < 0)) ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
      <div className="account-menu__heading">Switch account or channel</div>
      <div className="account-menu__list" aria-busy={busy}>
        {active?.channels.map((channel) => <button key={channel.id} role="menuitemradio" aria-checked={channel.id === active.channel}
          disabled={busy || signingIn || !auth?.selectChannel} onClick={() => channel.id === active.channel ? close() : void run(() => auth!.selectChannel!(channel.id))}>
          <Avatar name={channel.name} url={channel.avatarUrl || (channel.id === active.channel ? account.avatarUrl : undefined)} />
          <span className="account-menu__identity"><strong>{channel.name}</strong><small>{channel.handle || active.name}</small></span>
          {channel.id === active.channel && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}
        </button>)}
        {!active?.channels.length && <div className="account-menu__hint account-menu__current"><Avatar name={account.name} url={account.avatarUrl} />{account.name}{!saved && auth?.accounts && !error ? " · Loading…" : ""}</div>}
        {saved?.accounts.filter((item) => item.id !== saved.activeId).map((item) => <button key={item.id} role="menuitem"
          disabled={busy || signingIn || !auth?.switchAccount} onClick={() => void run(() => auth!.switchAccount!(item.id))}>
          <Avatar name={item.name} url={item.channels.find((c) => c.id === item.channel)?.avatarUrl || item.avatarUrl} />
          <span className="account-menu__identity"><strong>{item.name}</strong><small>{item.channels.find((c) => c.id === item.channel)?.name || "Google account"}</small></span>
        </button>)}
      </div>
      <div className="account-menu__actions">
        {desktop.available && <button role="menuitem" disabled={busy || signingIn} onClick={() => void signIn()}>{signingIn ? "Finish in your browser…" : "Add Google account"}</button>}
        <button role="menuitem" disabled={busy || signingIn} onClick={() => { close(); navigate("/settings"); }}><IconLibrary size={18} /> Accounts and channels</button>
        <button role="menuitem" onClick={() => { close(); navigate("/stats"); }}><IconEqualizerStatic size={18} /> Your listening</button>
        <button role="menuitem" disabled={busy || signingIn} onClick={() => { close(); navigate("/settings"); }}><IconSettings size={18} /> Settings</button>
        {desktop.available && <button role="menuitem" disabled={busy || signingIn} onClick={() => {
          close();
          void (async () => {
            if (await prompt.confirm({ title: "Sign out?", body: "Youtube Music Spotified will forget this account until you sign in again. Your listening history stays on this machine.", confirmLabel: "Sign out", danger: true })) { setOpen(true); await run(() => desktop.signOut()); }
          })();
        }}>Sign out</button>}
      </div>
      {(error || problem) && <div className="account-menu__error" role="alert">{error || problem}</div>}
    </div>, document.body)}
  </>;
}
