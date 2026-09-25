import { endpointURL } from "./protocol.mjs";
export class RoomClientV2 {
  constructor({ onState, onStatus, onError, onEnded, onJoined }) {
    Object.assign(this, { onState, onStatus, onError, onEnded, onJoined });
    this.offset = 0;
    this.stopped = true;
    this.attempts = 0;
    this.pending = new Map();
  }
  serverNow() {
    return Date.now() + this.offset;
  }
  connect(options) {
    // A second connect replaces the first rather than leaving its socket
    // and timers running.
    clearTimeout(this.retry);
    clearTimeout(this.timeout);
    this.socket?.close();
    this.server = endpointURL(options.server);
    this.options = options;
    this.stopped = false;
    this.open();
  }
  open() {
    if (this.stopped) return;
    this.onStatus(this.credential ? "reconnecting" : "connecting");
    const ws = (this.socket = new WebSocket(this.server));
    let ready = false;
    let connectionError = "";
    const noHandshake = () => {
      connectionError =
        "No v2 handshake received. Check the server address and upgrade the relay to v2.";
      this.onError(connectionError);
      ws.close();
    };
    // Connecting may be slow, but a v2 relay greets as soon as the socket is
    // open, so a v1 relay is recognised a few seconds after that.
    this.timeout = setTimeout(noHandshake, 10000);
    ws.onopen = () => {
      if (this.socket !== ws || ready) return;
      clearTimeout(this.timeout);
      this.timeout = setTimeout(noHandshake, 3000);
    };
    ws.onmessage = ({ data }) => {
      if (this.socket !== ws || this.stopped) return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type === "hello") {
        if (msg.version !== 2) {
          this.fail("This server is not compatible with Listen Together v2.");
          return;
        }
        this.send({ type: "hello", version: 2 });
      } else if (msg.type === "ready") {
        ready = true;
        clearTimeout(this.timeout);
        this.send({ type: "ping", sent: Date.now() });
        this.send(
          this.credential
            ? { type: "resume", ...this.credential }
            : {
                type: this.options.pin ? "join" : "create",
                pin: this.options.pin,
                mode: this.options.mode,
                roomName: this.options.roomName,
                profile: this.options.profile,
              },
        );
      } else if (msg.type === "waiting") {
        this.onStatus("waiting");
      } else if (msg.type === "joined") {
        this.credential = { roomId: msg.roomId, token: msg.token };
        this.member = msg.member;
        this.attempts = 0;
        this.onJoined?.(msg.member);
        this.onStatus("connected");
        clearInterval(this.ping);
        this.ping = setInterval(
          () => this.send({ type: "ping", sent: Date.now() }),
          10000,
        );
      } else if (msg.type === "state") {
        this.state = msg.room;
        this.onState(msg.room);
      } else if (msg.type === "pong")
        this.offset = msg.at - (msg.sent + Date.now()) / 2;
      else if (msg.type === "ack") {
        const pending = this.pending.get(msg.op);
        clearTimeout(pending?.timer);
        pending?.resolve(true);
        this.pending.delete(msg.op);
      } else if (msg.type === "error") {
        const pending = this.pending.get(msg.op);
        clearTimeout(pending?.timer);
        pending?.resolve(false);
        this.pending.delete(msg.op);
        this.onError(msg.message);
        if (msg.fatal || !this.credential) this.fail(msg.message);
      } else if (msg.type === "ended") {
        this.stop();
        this.onEnded(msg.reason);
      }
    };
    ws.onerror = () => {
      if (!ready) {
        connectionError =
          "Could not connect. Check the address, network, and server’s desktop-origin configuration.";
        this.onError(connectionError);
      }
    };
    ws.onclose = () => {
      if (this.socket !== ws || this.stopped) return;
      clearTimeout(this.timeout);
      clearInterval(this.ping);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.resolve(false);
      }
      this.pending.clear();
      if (this.credential && this.attempts < 5) {
        this.onStatus("reconnecting");
        this.retry = setTimeout(
          () => this.open(),
          Math.min(4000, 500 * 2 ** this.attempts++),
        );
      } else
        this.fail(
          connectionError ||
            "Disconnected from the room. Check the server and join again.",
        );
    };
  }
  send(msg) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(msg));
  }
  command(data) {
    if (this.socket?.readyState !== 1 || !this.state)
      return Promise.resolve(false);
    const op = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(op);
        this.onError(
          "The server did not confirm the action. Check the room before trying again.",
        );
        resolve(false);
      }, 8000);
      this.pending.set(op, { resolve, timer });
      this.send({
        type: "command",
        command: {
          base: this.state.revision,
          current: this.state.current,
          ...data,
          op,
        },
      });
    });
  }
  leave(next) {
    this.send({ type: "leave", next });
    this.stop();
  }
  fail(message) {
    this.stop();
    this.onEnded(message);
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.timeout);
    clearInterval(this.ping);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    this.pending.clear();
    this.socket?.close();
    this.credential = null;
  }
}

/** Read-only handshake probe: it never creates or joins a room. */
export async function checkRoomServer(input) {
  const url = endpointURL(input);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      error ? reject(new Error(error)) : resolve(true);
    };
    const timeout = setTimeout(
      () => finish("No v2 handshake. Check the address and the relay version."),
      8000,
    );
    ws.onmessage = ({ data }) => {
      try {
        const message = JSON.parse(data);
        if (message.type === "hello")
          finish(
            message.version === 2
              ? null
              : "This relay does not support Listen Together v2.",
          );
        else if (message.type === "error")
          finish(message.message || "Connection rejected.");
      } catch {
        finish("The server returned an invalid response.");
      }
    };
    ws.onerror = () =>
      finish(
        "Could not connect. Check the address, network and allowed origins.",
      );
    ws.onclose = () =>
      finish("The server closed the connection before the v2 handshake.");
  });
}
