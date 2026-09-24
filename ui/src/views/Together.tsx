import { useState } from "react";
import { connectTogether, leaveTogether, retryTogetherPlayback, useTogether } from "../lib/together";
import { decodeInvite } from "../../../listen-together/protocol.mjs";
import { toast } from "../lib/toast";

export function Together() {
  const room = useTogether();
  const [server, setServer] = useState("ws://127.0.0.1:8765");
  const [invitation, setInvitation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  let destination = "";
  try { destination = new URL(decodeInvite(invitation.trim()).server).host; } catch { /* incomplete invitation */ }
  const connect = async (join: boolean) => {
    setBusy(true); setError(null);
    try { await connectTogether(join ? { invitation: invitation.trim() } : { server }); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not join the room."); }
    finally { setBusy(false); }
  };
  return <div className="together-page">
    <h1>Listen Together <span className="together-badge">Prototype</span></h1>
    <p>Listen in sync with friends. Everyone plays through their own account and keeps their own volume.</p>
    {room.status !== "disconnected" ? <section className="together-card">
      <h2>{room.status === "connecting" ? "Connecting…" : room.role === "host" ? "You’re hosting" : "Following the host"}</h2>
      {room.status === "connected" && <p>{room.members} {room.members === 1 ? "listener" : "listeners"} · The host chooses music, pauses, seeks, and skips.</p>}
      {room.role === "host" && <>
        <label>Private invitation<input readOnly value={room.invitation} onFocus={e => e.currentTarget.select()} /></label>
        <button className="chip chip--primary" onClick={() => void navigator.clipboard.writeText(room.invitation).then(() => toast("Invitation copied"), () => setError("Select and copy the invitation above."))}>Copy invitation</button>
        <p>Share with people you trust. Anyone with this invitation can join. Rooms last up to six hours and end when the host leaves.</p>
      </>}
      {room.role === "guest" && <>
        <p>Your current queue is replaced by the host’s current track. Unavailable tracks wait for the next selection. Leaving pauses playback.</p>
        <button className="chip" onClick={retryTogetherPlayback}>Retry playback</button>
      </>}
      <button className="chip" onClick={() => void leaveTogether()}>{room.role === "host" ? "End room" : "Leave room"}</button>
    </section> : <div className="together-grid">
      <section className="together-card">
        <h2>Create a room</h2>
        <label>Room server<input value={server} onChange={e => setServer(e.target.value)} placeholder="wss://your-room-server" spellCheck={false} /></label>
        <p>This prototype needs a room server. Use localhost for testing on this computer; friends need the same reachable server with a secure connection.</p>
        <button className="chip chip--primary" disabled={busy} onClick={() => void connect(false)}>Create room</button>
      </section>
      <section className="together-card">
        <h2>Join a friend</h2>
        <label>Invitation<textarea value={invitation} onChange={e => { setInvitation(e.target.value); setConfirmed(false); }} placeholder="Paste your friend’s invitation" spellCheck={false} /></label>
        {destination && <label className="together-consent"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Connect to {destination} and follow this room’s playback.</label>}
        <p>Joining replaces your queue and lets the host control playback until you leave. Your volume stays yours.</p>
        <button className="chip chip--primary" disabled={busy || !destination || !confirmed} onClick={() => void connect(true)}>Join room</button>
      </section>
    </div>}
    {(error || room.error) && <p role="alert" className="together-error">{error || room.error}</p>}
    <p className="together-footnote">Only track details and playback timing are shared with the room server and participants. Audio and Google credentials stay in each listener’s own session. Account changes and closing the app leave the room.</p>
  </div>;
}
