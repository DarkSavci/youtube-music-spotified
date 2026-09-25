// Only this allowlist crosses the room connection. Never serialize a player,
// account, or resolver response directly.
export function cleanSnapshot(value) {
  if (!value || typeof value.playing !== 'boolean' || !Number.isFinite(value.positionMs) || value.positionMs < 0 || value.positionMs > 86400000) throw new Error('Invalid playback state');
  let track = null;
  if (value.track !== null) {
    const t = value.track;
    if (!t || !/^[A-Za-z0-9_-]{11}$/.test(t.id) || typeof t.title !== 'string' || t.title.length > 300 || !Number.isFinite(t.durationMs) || t.durationMs < 0 || t.durationMs > 86400000) throw new Error('Invalid track');
    track = { id: t.id, title: t.title, durationMs: t.durationMs, artists: Array.isArray(t.artists) ? t.artists.slice(0, 10).map(a => ({ name: String(a.name || '').slice(0, 100) })) : [] };
  }
  return { track, playing: track !== null && value.playing, positionMs: value.positionMs };
}
export function positionAt(snapshot, serverNow) {
  const elapsed = snapshot.playing ? Math.max(0, serverNow - snapshot.at) : 0;
  const position = snapshot.positionMs + elapsed;
  return Math.min(position, snapshot.track?.durationMs || 86400000);
}
export function endpointURL(input) {
  const url = new URL(input);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local)) throw new Error('Use wss:// for a remote server, or ws://localhost for local testing.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Server URL must not contain credentials, query parameters, or a fragment.');
  return url.href;
}
export function encodeInvite(server, room, token) {
  return `spotifier-room:${encodeURIComponent(JSON.stringify({ v: 1, server: endpointURL(server), room, token }))}`;
}
export function decodeInvite(input) {
  if (input.length > 4096 || !input.startsWith('spotifier-room:')) throw new Error('Paste a valid Listen Together invitation.');
  const data = JSON.parse(decodeURIComponent(input.slice('spotifier-room:'.length)));
  if (data.v !== 1 || !/^[A-Za-z0-9_-]{16}$/.test(data.room) || !/^[A-Za-z0-9_-]{43}$/.test(data.token)) throw new Error('Invalid invitation.');
  return { server: endpointURL(data.server), room: data.room, token: data.token };
}
