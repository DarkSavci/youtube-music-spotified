import { cleanSnapshot, decodeInvite, encodeInvite, endpointURL } from './protocol.mjs';

// Transport only: no accounts, audio, DOM, or player access.
export class RoomClient {
  constructor({ onStatus, onSnapshot, getSnapshot, WebSocketImpl = globalThis.WebSocket }) {
    Object.assign(this, { onStatus, onSnapshot, getSnapshot, WebSocketImpl });
    this.offset = 0; this.bestRTT = Infinity; this.seq = 0;
  }
  serverNow() { return Date.now() + this.offset; }
  connect({ server, invitation }) {
    if (this.socket) throw new Error('Already connected');
    const join = invitation ? decodeInvite(invitation) : null;
    this.server = endpointURL(join?.server || server);
    this.onStatus({ status: 'connecting', error: null });
    const ws = this.socket = new this.WebSocketImpl(this.server);
    this.timeout = setTimeout(() => this.stop('The room server did not respond.'), 10000);
    ws.onopen = () => {
      this.send({ type: 'ping', sent: Date.now() });
      this.send(join ? { type: 'join', room: join.room, token: join.token } : { type: 'create' });
    };
    ws.onmessage = event => {
      if (this.socket !== ws) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > 16384) throw new Error('Invalid server response');
        const msg = JSON.parse(event.data);
        if (msg.type === 'pong') {
          const rtt = Date.now() - msg.sent;
          if (Number.isFinite(msg.at) && rtt >= 0 && rtt < this.bestRTT) {
            this.bestRTT = rtt; this.offset = msg.at - (msg.sent + Date.now()) / 2;
          }
        } else if (msg.type === 'joined') {
          if (this.role || !['host', 'guest'].includes(msg.role)) throw new Error('Invalid room role');
          clearTimeout(this.timeout);
          this.role = msg.role;
          this.onStatus({ status: 'connected', role: this.role, members: msg.members, invitation: this.role === 'host' ? encodeInvite(this.server, msg.room, msg.token) : invitation, error: null });
          this.interval = setInterval(() => {
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
        } else if (msg.type === 'ended' || msg.type === 'error') {
          this.stop(String(msg.reason || msg.message || 'The room ended.').slice(0, 300));
        }
      } catch { this.stop('The server sent an invalid room message.'); }
    };
    ws.onerror = () => this.stop('Could not connect to the room server. Check its address and availability.');
    ws.onclose = () => { if (this.socket === ws) this.stop('Disconnected. Rejoin with your invitation; if the host left, create a new room.'); };
  }
  send(msg) { if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(msg)); }
  publish() {
    if (this.role !== 'host') return;
    try { this.send({ type: 'publish', ...cleanSnapshot(this.getSnapshot()), at: this.serverNow() }); }
    catch { this.stop('This track cannot be shared in a listening room. Choose a YouTube music track and create a new room.'); }
  }
  stop(error = null) {
    const ws = this.socket; this.socket = null;
    clearTimeout(this.timeout); clearInterval(this.interval);
    if (ws) { ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null; ws.close(); }
    this.onStatus({ status: 'disconnected', error, role: null, members: 0 });
  }
}
