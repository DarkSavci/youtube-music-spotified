import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { releases } from "../lib/changelog";
import { Changelog } from "../views/Changelog";

const READ_KEY = "spotifier.releaseNotesRead";

export function WhatsNew() {
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const latest = releases[0]?.version;
  const [unread, setUnread] = useState(() => {
    try { return Boolean(latest && localStorage.getItem(READ_KEY) !== latest); }
    catch { return Boolean(latest); }
  });
  const close = () => { dialog.current?.close(); button.current?.focus(); };
  return <>
    <button ref={button} className="iconbtn whats-new-button" aria-label={unread ? "What's new — unread release notes" : "What's new"} aria-haspopup="dialog" onClick={() => {
      dialog.current?.showModal();
      setUnread(false);
      try { if (latest) localStorage.setItem(READ_KEY, latest); } catch { /* optional read marker */ }
    }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 8h18v4H3zM5 12v9h14v-9M12 8v13M12 8H7.5A2.5 2.5 0 1 1 10 5.5L12 8Zm0 0h4.5A2.5 2.5 0 1 0 14 5.5L12 8Z" />
      </svg>
      {unread && <span className="whats-new-button__dot" aria-hidden="true" />}
    </button>
    {createPortal(<dialog ref={dialog} className="whats-new-dialog" aria-labelledby="whats-new-title"
      onClick={event => { if (event.target === event.currentTarget) close(); }}
      onKeyDown={event => event.stopPropagation()}
      onClose={() => button.current?.focus()}>
      <div className="whats-new-dialog__body">
        <header className="whats-new-dialog__header">
          <h2 id="whats-new-title">What's new</h2>
          <button className="iconbtn" aria-label="Close release notes" onClick={close} autoFocus>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
          </button>
        </header>
        <div className="whats-new-dialog__scroll scroll"><Changelog limit={3} hideTitle /></div>
        <footer><button className="chip" onClick={() => { close(); navigate("/changelog"); }}>View all releases</button></footer>
      </div>
    </dialog>, document.body)}
  </>;
}
