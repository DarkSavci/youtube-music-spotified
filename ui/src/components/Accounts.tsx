import { useEffect, useState } from "react";
import { desktop, type SavedAccounts } from "../lib/desktop";
import { useSignIn } from "../lib/signin";
import { usePrompt } from "./Prompt";

export function Accounts() {
  const prompt = usePrompt();
  const [saved, setSaved] = useState<SavedAccounts>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signIn, signingIn, problem } = useSignIn();
  const bridge = window.spotifier?.auth;
  const load = async () => {
    if (!bridge?.accounts) return;
    setSaved(await bridge.accounts());
  };
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const state = await bridge?.accounts?.();
        if (!current || !state) return;
        setSaved(state);
        if (state.activeId) {
          const channels = await bridge?.channels?.();
          if (current && channels) setSaved(channels);
        }
      } catch { if (current) setError("Could not refresh channels. Check your connection; if the session expired, remove it and add the account again."); }
    })();
    return () => { current = false; };
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); await load(); }
    catch { setError("Could not change accounts. Check your connection and try again."); }
    finally { setBusy(false); }
  };
  const disabled = busy || signingIn;
  if (!bridge?.accounts) return <button className="chip" disabled={!desktop.available || signingIn} onClick={() => void signIn()}>Sign in</button>;
  return <div className="accounts">
    <p>Google accounts and their YouTube channels are separate choices. Choose the channel whose library you want to use.</p>
    {saved?.accounts.map(account => {
      const active = saved.activeId === account.id;
      return <div className="accounts__item" key={account.id}>
        <div className="accounts__heading"><strong>{account.name}</strong>{active && <span>Active account</span>}</div>
        <div className="settings__inline">
          {!active && <button className="chip" disabled={disabled} onClick={() => void run(() => bridge.switchAccount!(account.id))}>Use account</button>}
          {active && account.channels.length > 0 && <label>YouTube channel <select className="settings__select" aria-label="YouTube channel" value={account.channel} disabled={disabled} onChange={e => void run(() => bridge.selectChannel!(e.target.value))}>
            {account.channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}{channel.handle ? ` (${channel.handle})` : ""}</option>)}
          </select></label>}
          <button className="chip" disabled={disabled} onClick={() => void (async () => {
            if (!await prompt.confirm({ title: "Remove saved account?", body: "This signs this Google account out of the app. Other saved accounts remain available. Local listening history stays on this computer.", confirmLabel: "Remove", danger: true })) return;
            await run(() => bridge.removeAccount!(account.id));
          })()}>Remove account</button>
        </div>
      </div>;
    })}
    {!saved?.activeId && <p>No account is active. Add an account or choose a saved one.</p>}
    <div className="settings__inline">
      <button className="chip" disabled={disabled} onClick={() => void signIn()}>{signingIn ? "Finish in your browser…" : "Add Google account"}</button>
      {saved?.activeId && <button className="chip" disabled={disabled} onClick={() => void run(async () => { setSaved(await bridge.channels!()); })}>Refresh channels</button>}
    </div>
    {(error || problem) && <p role="alert">{error || problem}</p>}
  </div>;
}
