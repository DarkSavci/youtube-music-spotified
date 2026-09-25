import { createServer } from "node:http";
import { isIPv6 } from "node:net";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  VERSION,
  profile,
  makeRoom,
  addMember,
  snapshot,
  command,
  event,
  transfer,
  tick,
} from "./v2.mjs";

// Per-IP limits key IPv6 clients by /64, since one host usually holds a
// whole /64 and could otherwise take a fresh address per connection.
export function limitKey(address) {
  const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (!isIPv6(ip)) return ip;
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [
    ...left,
    ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"),
    ...right,
  ];
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g || "0", 16).toString(16))
    .join(":")}::/64`;
}
export function createRoomServerV2({
  maxRooms = 100,
  maxMembers = 12,
  graceMs = 20000,
  emptyMs = 60000,
  allowedOrigins = [],
  intervalMs = 500,
  trustProxy = false,
} = {}) {
  const rooms = new Map(),
    pins = new Map(),
    attempts = new Map(),
    resumes = new Map(),
    pending = new Map();
  const http = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ name: "Spotifier Listen Together", version: VERSION }),
    );
  });
  const wss = new WebSocketServer({
    server: http,
    maxPayload: 262144,
    perMessageDeflate: false,
    verifyClient: ({ req }) => {
      const origin = req.headers.origin;
      return (
        !origin ||
        ["null", "file://", ...allowedOrigins].includes(origin) ||
        ["http:", "https:"].some(
          (scheme) => origin === `${scheme}//${req.headers.host}`,
        )
      );
    },
  });
  const send = (ws, data) => {
    if (ws?.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 2 * 1024 * 1024)
        ws.close(1008, "Slow connection");
      else ws.send(JSON.stringify(data));
    }
  };
  // Each state replaces the last, so a listener who cannot keep up skips
  // states and is sent the latest once their connection drains, instead of
  // being disconnected by another member's burst of changes.
  const sendState = (ws, text) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) {
      ws.behind = true;
      return;
    }
    ws.behind = false;
    ws.send(text);
  };
  // A full queue makes the snapshot large and any member can change the
  // room several times a second, so a room sends at most one state every
  // 200 ms, serialized once for everyone. Acknowledgements wait for the
  // state they depend on, so a client never acts on an older revision.
  const outbox = new Map(),
    sentAt = new WeakMap();
  const flush = (room) => {
    const box = outbox.get(room);
    clearTimeout(box?.timer);
    outbox.delete(room);
    sentAt.set(room, Date.now());
    if (rooms.has(room.id)) {
      const text = JSON.stringify({ type: "state", room: snapshot(room) });
      for (const m of room.members.values()) sendState(m.socket, text);
    }
    for (const [ws, message] of box?.acks ?? []) send(ws, message);
  };
  const broadcast = (room, ack) => {
    let box = outbox.get(room);
    if (!box) outbox.set(room, (box = { timer: null, acks: [] }));
    if (ack) box.acks.push(ack);
    if (box.timer) return;
    const wait = 200 - (Date.now() - (sentAt.get(room) ?? 0));
    if (wait <= 0) flush(room);
    else box.timer = setTimeout(() => flush(room), wait);
  };
  const acknowledge = (room, ws, message) => {
    if (outbox.has(room)) outbox.get(room).acks.push([ws, message]);
    else send(ws, message);
  };
  const pin = () => {
    let value;
    do value = String(randomInt(100000000)).padStart(8, "0");
    while (pins.has(value));
    return value;
  };
  const rotate = (room) => {
    pins.delete(room.pin);
    room.pin = pin();
    pins.set(room.pin, room.id);
  };
  const end = (room, reason) => {
    rooms.delete(room.id);
    pins.delete(room.pin);
    clearTimeout(outbox.get(room)?.timer);
    outbox.delete(room);
    for (const m of room.members.values()) {
      const socket = m.socket;
      m.socket = null;
      if (socket) {
        socket.room = null;
        send(socket, { type: "ended", reason });
        socket.close();
      }
    }
  };
  const detach = (ws, deliberate = false, next) => {
    const room = ws.room,
      member = ws.member;
    if (!room || !member || member.socket !== ws) return;
    // A handover to someone who just left falls back to a random listener
    // below instead of leaving this member stuck in the room.
    if (deliberate && room.owner === member.id && next)
      try {
        transfer(room, next);
      } catch {}
    member.connected = false;
    member.socket = null;
    member.status = "reconnecting";
    member.disconnectedAt = Date.now();
    if (deliberate) {
      room.members.delete(member.id);
      if (room.owner === member.id) transfer(room);
      event(room, `${member.name} left.`);
    }
    ws.room = null;
    broadcast(room);
  };
  const joined = (ws, room, member) => {
    if (member.socket && member.socket !== ws) {
      member.socket.room = null;
      member.socket.close(1000);
    }
    ws.room = room;
    ws.member = member;
    member.socket = ws;
    member.connected = true;
    member.disconnectedAt = null;
    if (!room.owner) room.owner = member.id;
    send(ws, {
      type: "joined",
      member: member.id,
      token: member.token,
      roomId: room.id,
    });
    broadcast(room);
  };
  let globalAttempts = 0,
    globalWindow = Date.now();
  wss.on("connection", (ws, req) => {
    const address = req.socket.remoteAddress || "unknown";
    const trusted =
      trustProxy && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
    const forwarded = req.headers["x-forwarded-for"];
    const ip = limitKey(
      trusted && typeof forwarded === "string"
        ? forwarded.split(",").at(-1).trim()
        : address,
    );
    if (
      wss.clients.size > 200 ||
      [...wss.clients].filter((s) => s.ip === ip).length >= 24
    ) {
      ws.close(1013, "Server full");
      return;
    }
    ws.ip = ip;
    ws.created = Date.now();
    ws.pongAt = Date.now();
    ws.window = Date.now();
    ws.count = 0;
    send(ws, { type: "hello", version: VERSION, at: Date.now() });
    ws.on("pong", () => {
      ws.pongAt = Date.now();
    });
    ws.on("error", () => {});
    ws.on("message", (raw, binary) => {
      let msg;
      try {
        const now = Date.now();
        if (now - ws.window > 10000) {
          ws.count = 0;
          ws.window = now;
        }
        if (++ws.count > 100 || binary) {
          ws.close(1008, "Message limit");
          return;
        }
        msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== "object")
          throw new Error("Invalid request.");
        if (msg.type === "hello") {
          if (msg.version !== VERSION) {
            send(ws, {
              type: "error",
              fatal: true,
              message:
                "This server requires Listen Together v2. Update your app.",
            });
            ws.close();
            return;
          }
          ws.compatible = true;
          send(ws, { type: "ready" });
          return;
        }
        if (!ws.compatible) {
          // Older app versions skip the v2 handshake entirely.
          send(ws, {
            type: "error",
            fatal: true,
            message:
              "This Listen Together server needs a newer version of the app. Update the app, then join again.",
          });
          ws.close();
          return;
        }
        if (msg.type === "ping" && Number.isFinite(msg.sent)) {
          send(ws, { type: "pong", sent: msg.sent, at: now });
          return;
        }
        if (["create", "join", "resume"].includes(msg.type)) {
          if (ws.room || ws.waiting)
            throw new Error("Leave your current room first.");
          // Creating and joining are limited per source and across the
          // relay, which is what makes guessing PINs slow. Reconnecting
          // carries an unguessable credential, so it has its own per-source
          // limit and cannot be starved by other people's guessing.
          const resuming = msg.type === "resume";
          if (now - globalWindow > 60000) {
            globalWindow = now;
            globalAttempts = 0;
          }
          const buckets = resuming ? resumes : attempts;
          const bucket = buckets.get(ip) || { at: now, count: 0 };
          if (now - bucket.at > 60000) {
            bucket.at = now;
            bucket.count = 0;
          }
          buckets.set(ip, bucket);
          if (
            resuming
              ? ++bucket.count > 60
              : ++bucket.count > 30 || ++globalAttempts > 600
          )
            throw new Error("Too many room attempts. Try again in a minute.");
          if (msg.type === "create") {
            if (
              rooms.size >= maxRooms ||
              [...rooms.values()].filter((r) => r.creatorIP === ip).length >= 4
            )
              throw new Error("Room limit reached.");
            const room = makeRoom(pin(), msg);
            room.creatorIP = ip;
            const member = addMember(room, msg.profile);
            rooms.set(room.id, room);
            pins.set(room.pin, room.id);
            event(room, `${member.name} started the room.`);
            joined(ws, room, member);
          } else if (msg.type === "join") {
            const room = rooms.get(
              pins.get(String(msg.pin).replace(/\s/g, "")),
            );
            // One answer for every refusal, so probing PINs cannot tell a
            // locked or full room from one that does not exist.
            if (
              !room ||
              room.expires <= now ||
              room.locked ||
              room.members.size >= maxMembers ||
              (room.joinApproval && room.pending.length >= maxMembers)
            )
              throw new Error(
                "PIN is invalid or expired, or the room is not taking listeners. Check the selected server.",
              );
            if (room.joinApproval) {
              const request = {
                id: randomUUID(),
                ...profile(msg.profile),
                at: now,
              };
              room.pending.push(request);
              pending.set(request.id, { ws, room, request });
              ws.waiting = request.id;
              send(ws, { type: "waiting" });
              broadcast(room);
            } else {
              const member = addMember(room, msg.profile);
              event(room, `${member.name} joined.`);
              joined(ws, room, member);
            }
          } else {
            const room = rooms.get(msg.roomId);
            const member =
              room &&
              [...room.members.values()].find(
                (m) =>
                  typeof msg.token === "string" &&
                  Buffer.byteLength(msg.token) === Buffer.byteLength(m.token) &&
                  timingSafeEqual(Buffer.from(m.token), Buffer.from(msg.token)),
              );
            if (!member || room.expires <= now) {
              send(ws, {
                type: "error",
                fatal: true,
                message: "Your room session has expired or was removed.",
              });
              ws.close();
              return;
            }
            joined(ws, room, member);
          }
          return;
        }
        const room = ws.room,
          member = ws.member;
        if (!room || !member) throw new Error("Join a room first.");
        if (msg.type === "leave") {
          detach(ws, true, msg.next);
          send(ws, { type: "ended", reason: "" });
          ws.close();
          return;
        }
        if (msg.type === "status") {
          const status = [
            "listening",
            "paused",
            "buffering",
            "unavailable",
            "ready",
            "catching up",
          ].includes(msg.status)
            ? msg.status
            : "connecting";
          if (member.status !== status) {
            member.status = status;
            broadcast(room);
          }
          return;
        }
        if (msg.type !== "command") throw new Error("Unknown request.");
        const c = msg.command;
        // A retry of an operation that already succeeded (its ack was lost)
        // is acknowledged, not re-checked against a member or request that
        // it has itself removed.
        if (typeof c?.op === "string" && member.operations.has(c.op)) {
          acknowledge(room, ws, {
            type: "ack",
            op: c.op,
            revision: room.revision,
          });
          return;
        }
        if (
          ["approve", "deny"].includes(c?.kind) &&
          (!pending.has(c.request) ||
            pending.get(c.request).room !== room ||
            (c.kind === "approve" && room.members.size >= maxMembers))
        )
          throw new Error("That request expired or the room is full.");
        if (
          c?.kind === "kick" &&
          (!room.members.has(c.member) || c.member === room.owner)
        )
          throw new Error("Choose another listener.");
        const changed = command(room, member, c);
        if (changed) {
          if (c.kind === "approve" || c.kind === "deny") {
            const request = pending.get(c.request);
            pending.delete(c.request);
            request.ws.waiting = null;
            room.pending = room.pending.filter((p) => p.id !== c.request);
            if (c.kind === "approve") {
              const admitted = addMember(room, request.request);
              event(room, `${admitted.name} joined.`);
              joined(request.ws, room, admitted);
            } else {
              send(request.ws, {
                type: "ended",
                reason: "The leader declined your request.",
              });
              request.ws.close();
            }
          }
          if (c.kind === "rotate") {
            rotate(room);
            event(room, `${member.name} rotated the PIN.`);
          }
          if (c.kind === "kick") {
            const target = room.members.get(c.member),
              socket = target.socket;
            room.members.delete(target.id);
            if (socket) {
              socket.room = null;
              send(socket, {
                type: "ended",
                reason: "You were removed from the room.",
              });
              socket.close();
            }
            rotate(room);
            event(room, `${target.name} was removed. The PIN was rotated.`);
          }
          if (c.kind === "end") {
            end(room, "The leader ended the room.");
            return;
          }
          broadcast(room, [
            ws,
            { type: "ack", op: c.op, revision: room.revision },
          ]);
        } else
          acknowledge(room, ws, {
            type: "ack",
            op: c.op,
            revision: room.revision,
          });
      } catch (error) {
        send(ws, {
          type: "error",
          op: msg?.command?.op,
          message: error.message,
        });
      }
    });
    ws.on("close", () => {
      if (ws.waiting) {
        const item = pending.get(ws.waiting);
        if (item) {
          item.room.pending = item.room.pending.filter(
            (p) => p.id !== ws.waiting,
          );
          pending.delete(ws.waiting);
          broadcast(item.room);
        }
      }
      detach(ws);
    });
  });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, item] of pending)
      if (now - item.request.at > 60000 || !rooms.has(item.room.id)) {
        pending.delete(id);
        item.room.pending = item.room.pending.filter((p) => p.id !== id);
        item.ws.waiting = null;
        send(item.ws, { type: "ended", reason: "The join request expired." });
        item.ws.close();
        broadcast(item.room);
      }
    for (const buckets of [attempts, resumes])
      for (const [ip, bucket] of buckets)
        if (now - bucket.at > 60000) buckets.delete(ip);
    for (const room of rooms.values()) {
      if (room.expires <= now) {
        end(room, "This room expired.");
        continue;
      }
      let changed = tick(room, now);
      for (const m of room.members.values())
        if (!m.connected && now - m.disconnectedAt > graceMs) {
          room.members.delete(m.id);
          if (room.owner === m.id) transfer(room);
          changed = true;
        }
      if (![...room.members.values()].some((m) => m.connected)) {
        room.emptySince ??= now;
        if (now - room.emptySince > emptyMs) {
          end(room, "This room is empty.");
          continue;
        }
      } else room.emptySince = null;
      if (changed) broadcast(room);
      else if (
        [...room.members.values()].some(
          (m) => m.socket?.behind && m.socket.bufferedAmount < 256 * 1024,
        )
      )
        broadcast(room);
    }
    for (const ws of wss.clients) {
      if (
        now - ws.pongAt > 45000 ||
        (!ws.room && !ws.waiting && now - ws.created > 15000)
      )
        ws.terminate();
      else if (now - (ws.pingAt || 0) > 15000) {
        ws.pingAt = now;
        ws.ping();
      }
    }
  }, intervalMs);
  timer.unref();
  return {
    http,
    close: async () => {
      clearInterval(timer);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => wss.close(r));
      if (http.listening) await new Promise((r) => http.close(r));
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createRoomServerV2({
    trustProxy: process.env.TRUST_PROXY === "1",
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .filter(Boolean),
  });
  server.http.listen(
    Number(process.env.PORT || 8766),
    process.env.HOST || "127.0.0.1",
    () => console.log("Listen Together v2", server.http.address()),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => void server.close());
}
