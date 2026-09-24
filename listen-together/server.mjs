import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { cleanSnapshot, positionAt } from './protocol.mjs';

/** In-memory, metadata-only prototype. Put behind TLS for remote use. */
export function createRoomServer({ maxRooms = 100, maxMembers = 8, lifetimeMs = 6 * 3600000 } = {}) {
  const rooms = new Map();
  const http = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Spotifier Listen Together\n'); });
  const wss = new WebSocketServer({ server: http, maxPayload: 8192, perMessageDeflate: false });
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
  wss.on('connection', ws => {
    if (wss.clients.size > 200) { ws.close(1013, 'Server full'); return; }
    ws.alive = true;
    ws.created = Date.now();
    ws.count = 0;
    ws.window = Date.now();
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    ws.on('message', (raw, binary) => {
      try {
        const now = Date.now();
        if (now - ws.window > 10000) { ws.window = now; ws.count = 0; }
        if (++ws.count > 100 || binary) throw new Error('Message limit exceeded');
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping' && Number.isFinite(msg.sent)) { send(ws, { type: 'pong', sent: msg.sent, at: now }); return; }
        if (msg.type === 'create') {
          if (ws.room || rooms.size >= maxRooms) throw new Error('Cannot create room');
          const room = { id: randomBytes(12).toString('base64url'), token: randomBytes(32).toString('base64url'), host: ws, members: new Set([ws]), expires: now + lifetimeMs, seq: 0, snapshot: null };
          rooms.set(room.id, room); ws.room = room;
          send(ws, { type: 'joined', role: 'host', room: room.id, token: room.token, expires: room.expires, members: 1, at: now });
        } else if (msg.type === 'join') {
          const room = rooms.get(msg.room);
          const token = typeof msg.token === 'string' ? Buffer.from(msg.token) : Buffer.alloc(0);
          if (ws.room || !room || room.expires <= now || token.length !== 43 || !timingSafeEqual(token, Buffer.from(room.token))) throw new Error('Invitation is invalid or expired');
          if (room.members.size >= maxMembers) throw new Error('Room is full');
          room.members.add(ws); ws.room = room;
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
      else { room.members.delete(ws); broadcast(room, { type: 'members', count: room.members.size }); }
    });
  });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) if (room.expires <= now) end(room, 'This room expired.');
    for (const ws of wss.clients) {
      if (!ws.alive || (!ws.room && now - ws.created > 10000)) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
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
  const server = createRoomServer();
  server.http.listen(Number(process.env.PORT || 8765), process.env.HOST || '127.0.0.1', () => console.log('Listen Together server listening', server.http.address()));
  process.on('SIGTERM', () => { void server.close(); });
  process.on('SIGINT', () => { void server.close(); });
}
