import { cleanSnapshot, decodeInvite, encodeInvite, endpointURL } from './protocol.mjs';

// A guest retries a dropped connection this many times, backing off from 1s
// with jitter. Five tries span ~30s, long enough for the server's heartbeat to
// drop the guest's stale socket and free its slot in a full room.
const MAX_RETRIES = 5;
// Pongs normally arrive every 2s; this long without one means the link is gone
// even if the socket has not reported closing (sleep, Wi-Fi change).
const SILENCE_MS = 8000;

// Transport only: no accounts, audio, DOM, or player access.
export class RoomClient {
  constructor({ onStatus, onSnapshot, getSnapshot, WebSocketImpl = globalThis.WebSocket }) {
    Object.assign(this, { onStatus, onSnapshot, getSnapshot, WebSocketImpl });
    this.offset = 0; this.bestRTT = Infinity; this.seq = 0;
  }
  serverNow() { return Date.now() + this.offset; }
  connect({ server, invitation }, reconnecting = false) {
    if (this.socket) throw new Error('Already connected');
    if (!reconnecting) { this.retries = 0; this.retryInvite = null; }
    const join = invitation ? decodeInvite(invitation) : null;
    this.server = endpointURL(join?.server || server);
    this.onStatus({ status: reconnecting ? 'reconnecting' : 'connecting', error: null });
    const ws = this.socket = new this.WebSocketImpl(this.server);
    this.timeout = setTimeout(() => this.failed('The room server did not respond.'), 10000);
    ws.onopen = () => {
      this.send({ type: 'ping', sent: Date.now() });
      this.send(join ? { type: 'join', room: join.room, token: join.token } : { type: 'create' });
    };
    ws.onmessage = event => {
      if (this.socket !== ws) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > 16384) throw new Error('Invalid server response');
        const msg = JSON.parse(event.data);
        this.lastHeard = Date.now();
        if (msg.type === 'pong') {
          const rtt = Date.now() - msg.sent;
          if (Number.isFinite(msg.at) && rtt >= 0 && rtt < this.bestRTT) {
            this.bestRTT = rtt; this.offset = msg.at - (msg.sent + Date.now()) / 2;
          }
        } else if (msg.type === 'joined') {
          if (this.role || !['host', 'guest'].includes(msg.role)) throw new Error('Invalid room role');
          clearTimeout(this.timeout);
          this.role = msg.role;
          this.retries = 0;
          if (this.role === 'guest') this.retryInvite = invitation;
          this.onStatus({ status: 'connected', role: this.role, members: msg.members, invitation: this.role === 'host' ? encodeInvite(this.server, msg.room, msg.token) : invitation, error: null });
          this.interval = setInterval(() => {
            if (Date.now() - this.lastHeard > SILENCE_MS) { this.failed('Connection lost.'); return; }
            if (this.role === 'host') this.publish();
            this.send({ type: 'ping', sent: Date.now() });
          }, 2000);
          if (this.role === 'host') this.publish();
        } else if (msg.type === 'snapshot') {
          if (this.role !== 'guest' || !Number.isSafeInteger(msg.seq) || msg.seq <= this.seq || !Number.isFinite(msg.at)) return;
          this.seq = msg.seq;
          this.onSnapshot({ ...cleanSnapshot(msg), at: msg.at, seq: msg.seq });
        } else if (msg.type === 'members') {
          if (Number.isInteger(msg.count) && msg.count > 0 && msg.count <= 200) this.onStatus({ members: msg.count });
        } else if (msg.type === 'error' && !this.role && this.retryInvite && /full/i.test(String(msg.message ?? msg.reason ?? ''))) {
          // Rejoining a full room: our previous connection may still hold a
          // slot until the server's heartbeat drops it. Keep retrying.
          this.failed('The room is full. Retrying…');
        } else if (msg.type === 'ended' || msg.type === 'error') {
          this.stop(String(msg.reason || msg.message || 'The room ended.').slice(0, 300));
        }
      } catch { this.stop('The server sent an invalid room message.'); }
    };
    ws.onerror = () => this.failed('Could not connect to the room server. Check its address and availability.');
    ws.onclose = () => { if (this.socket === ws) this.failed('Disconnected. Rejoin with your invitation; if the host left, create a new room.'); };
  }
  failed(error) {
    if (!this.retryInvite || this.retries >= MAX_RETRIES) { this.stop(error); return; }
    const ws = this.socket; this.socket = null; this.role = null; this.seq = 0;
    clearTimeout(this.timeout); clearInterval(this.interval);
    if (ws) { ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null; ws.close(); }
    this.onStatus({ status: 'reconnecting', role: 'guest', error: 'Connection interrupted. Reconnecting…' });
    // Exponential backoff capped at 10s, with ±30% jitter so guests of a room
    // that blipped do not all reconnect at the same instant.
    const delay = Math.min(10000, 1000 * 2 ** this.retries++) * (0.7 + Math.random() * 0.6);
    this.retryTimer = setTimeout(() => this.connect({ invitation: this.retryInvite }, true), delay);
  }
  send(msg) { if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(msg)); }
  publish() {
    if (this.role !== 'host') return;
    try { this.send({ type: 'publish', ...cleanSnapshot(this.getSnapshot()), at: this.serverNow() }); }
    catch { this.stop('This track cannot be shared in a listening room. Choose a YouTube music track and create a new room.'); }
  }
  stop(error = null) {
    clearTimeout(this.retryTimer); this.retryInvite = null;
    const ws = this.socket; this.socket = null;
    clearTimeout(this.timeout); clearInterval(this.interval);
    if (ws) { ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null; ws.close(); }
    this.onStatus({ status: 'disconnected', error, role: null, members: 0 });
  }
}
