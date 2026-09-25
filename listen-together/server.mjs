import { createServer } from 'node:http';
import { isIPv6 } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { cleanSnapshot, positionAt } from './protocol.mjs';

/** In-memory, metadata-only prototype. Put behind TLS for remote use. */
export function createRoomServer({ maxRooms = 100, maxMembers = 8, lifetimeMs = 6 * 3600000, maxClients = 200, maxConnectionsPerIP = 8, maxRoomsPerIP = 4, emptyRoomMs = 30 * 60000, heartbeatMs = 30000, trustProxy = false, allowedOrigins = [] } = {}) {
  const rooms = new Map();
  const connections = new Map();
  // Per-IP limits key IPv6 clients by /64, since one host usually holds a
  // whole /64 and could otherwise take a fresh address per connection.
  const limitKey = address => {
    const ip = address.startsWith('::ffff:') ? address.slice(7) : address;
    if (!isIPv6(ip)) return ip;
    const [head, tail = ''] = ip.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
    return `${groups.slice(0, 4).map(g => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
  };
  let warnedNoForwardedFor = false;
  const clientIP = req => {
    const address = req.socket.remoteAddress || 'unknown';
    const proxy = trustProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
    const forwarded = req.headers['x-forwarded-for'];
    if (proxy && typeof forwarded !== 'string' && !warnedNoForwardedFor) {
      warnedNoForwardedFor = true;
      console.warn('TRUST_PROXY is set but the proxy sent no X-Forwarded-For; all clients share its per-IP limits.');
    }
    return limitKey(proxy && typeof forwarded === 'string' ? forwarded.split(',').at(-1).trim() : address);
  };
  const originAllowed = req => {
    const origin = req.headers.origin;
    if (!origin || origin === 'null' || allowedOrigins.includes(origin)) return true;
    try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && url.host === req.headers.host; } catch { return false; }
  };
  const http = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Spotifier Listen Together\n'); });
  const wss = new WebSocketServer({ server: http, maxPayload: 8192, perMessageDeflate: false, verifyClient: ({ req }) => originAllowed(req) && (connections.get(clientIP(req)) || 0) < maxConnectionsPerIP });
  const send = (ws, data) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 65536) { ws.close(1008, 'Slow connection'); return; }
    ws.send(JSON.stringify(data));
  };
  const broadcast = (room, data) => { for (const ws of room.members) send(ws, data); };
  const end = (room, reason) => {
    rooms.delete(room.id);
    for (const ws of room.members) { ws.room = null; send(ws, { type: 'ended', reason }); ws.close(1000); }
    room.members.clear();
  };
  wss.on('connection', (ws, req) => {
    ws.ip = clientIP(req);
    connections.set(ws.ip, (connections.get(ws.ip) || 0) + 1);
    ws.on('close', () => { const count = (connections.get(ws.ip) || 1) - 1; if (count) connections.set(ws.ip, count); else connections.delete(ws.ip); });
    if (wss.clients.size > maxClients) { ws.close(1013, 'Server full'); return; }
    ws.lastPong = Date.now();
    ws.created = Date.now();
    ws.count = 0;
    ws.window = Date.now();
    ws.on('pong', () => { ws.lastPong = Date.now(); });
    ws.on('error', () => {});
    ws.on('message', (raw, binary) => {
      try {
        const now = Date.now();
        if (now - ws.window > 10000) { ws.window = now; ws.count = 0; }
        if (++ws.count > 100 || binary) throw new Error('Message limit exceeded');
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping' && Number.isFinite(msg.sent)) { send(ws, { type: 'pong', sent: msg.sent, at: now }); return; }
        if (msg.type === 'create') {
          if (ws.room || rooms.size >= maxRooms || [...rooms.values()].filter(room => room.ip === ws.ip).length >= maxRoomsPerIP) throw new Error('Cannot create room');
          const room = { ip: ws.ip, emptySince: now, id: randomBytes(12).toString('base64url'), token: randomBytes(32).toString('base64url'), host: ws, members: new Set([ws]), expires: now + lifetimeMs, seq: 0, snapshot: null };
          rooms.set(room.id, room); ws.room = room;
          send(ws, { type: 'joined', role: 'host', room: room.id, token: room.token, expires: room.expires, members: 1, at: now });
        } else if (msg.type === 'join') {
          const room = rooms.get(msg.room);
          const token = typeof msg.token === 'string' ? Buffer.from(msg.token) : Buffer.alloc(0);
          if (ws.room || !room || room.expires <= now || token.length !== 43 || !timingSafeEqual(token, Buffer.from(room.token))) throw new Error('Invitation is invalid or expired');
          if (room.members.size >= maxMembers) throw new Error('Room is full');
          room.members.add(ws); room.emptySince = null; ws.room = room;
          send(ws, { type: 'joined', role: 'guest', room: room.id, expires: room.expires, members: room.members.size, at: now });
          if (room.snapshot) send(ws, { type: 'snapshot', ...room.snapshot });
          broadcast(room, { type: 'members', count: room.members.size });
        } else if (msg.type === 'publish') {
          const room = ws.room;
          if (!room || room.host !== ws) throw new Error('Only the host can control playback');
          const state = cleanSnapshot(msg);
          const sampledAt = Number.isFinite(msg.at) && Math.abs(msg.at - now) < 30000 ? msg.at : now;
          room.snapshot = { ...state, positionMs: positionAt({ ...state, at: sampledAt }, now), at: now, seq: ++room.seq };
          broadcast(room, { type: 'snapshot', ...room.snapshot });
        } else throw new Error('Unknown message');
      } catch (err) { send(ws, { type: 'error', message: err.message }); ws.close(1008, 'Invalid request'); }
    });
    ws.on('close', () => {
      const room = ws.room;
      if (!room) return;
      if (room.host === ws) end(room, 'The host left. Create a new room to listen together again.');
      else { room.members.delete(ws); if (room.members.size === 1) room.emptySince = Date.now(); broadcast(room, { type: 'members', count: room.members.size }); }
    });
  });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) if (room.expires <= now || (room.emptySince !== null && now - room.emptySince > emptyRoomMs)) end(room, 'This room expired.');
    for (const ws of wss.clients) {
      if (now - ws.lastPong > heartbeatMs || (!ws.room && now - ws.created > 10000)) { ws.terminate(); continue; }
      ws.ping();
    }
  }, 5000);
  timer.unref();
  return { http, close: async () => {
    clearInterval(timer);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    if (http.listening) await new Promise(resolve => http.close(resolve));
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const number = (name, fallback) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : fallback; };
  const server = createRoomServer({
    trustProxy: process.env.TRUST_PROXY === "1",
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean),
    maxClients: number("MAX_CLIENTS", 200),
    maxConnectionsPerIP: number("MAX_CONNECTIONS_PER_IP", 8),
  });
  server.http.listen(Number(process.env.PORT || 8765), process.env.HOST || '127.0.0.1', () => console.log('Listen Together server listening', server.http.address()));
  process.on('SIGTERM', () => { void server.close(); });
  process.on('SIGINT', () => { void server.close(); });
}
