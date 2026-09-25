# Listen Together prototype

Private rooms synchronize **track identity, play/pause, seeking and track changes**. Each listener resolves and plays the track using their own local app/account. The host's existing queue drives the room; guests see the current track, not a copy of the whole queue. Volume is always local.

This is an opt-in prototype, not a hosted service or a guarantee of frame-accurate synchronization. No audio, Google cookies, credentials, resolved media URLs, artwork URLs, or account identifiers are sent to the room server. Track titles and artist names are visible to the server and room participants. The server has no persistent storage or request-body logging.

## Try locally

Requires Node.js 22+ and a current source build of the app.

```sh
npm ci --prefix listen-together
npm start --prefix listen-together
```

In the app, click the headphones button next to Settings, then **Create room** using `ws://127.0.0.1:8765`. Copy the invitation. Another client can paste it into **Join a friend**, review the server address, and explicitly join. A localhost invitation works only on the same computer.

For friends on different computers, run the room service on a machine reachable by everyone, put it behind a TLS reverse proxy supporting WebSocket upgrades, and enter its `wss://` URL when creating the room. The service defaults to loopback; `HOST` and `PORT` configure its bind address. Do not expose the local music core (port 8674) or any account files. Only the separate coordination server is shared.

There is **no deployment or paid service provisioned by this change**. Existing hosting can run this small Node service; it still has hosting and bandwidth requirements. A Cloudflare Durable Objects/Workers adapter could be evaluated separately for free-tier use. This Node server is not directly deployable as a Worker. Unlimited free operation is not promised.

## Behavior and limits

- The host can use normal player controls, playlists, queue, media keys, and the mini-player. Guests keep their own volume but cannot override the room's transport/queue until leaving.
- Joining replaces a guest's queue with the host's current track. Leaving pauses that track and restores local control; it does not restore the previous queue.
- Clock offset is estimated with ping/pong. Snapshots arrive every two seconds, with faster updates on meaningful host changes. Guests correct drift over 800 ms, at most once every four seconds; loading/stalled playback waits before correcting. This is a practical starting point, not a measured accuracy guarantee.
- Host buffering pauses the room. A guest with an unavailable track or an explicit playback error waits for a new host track or **Retry playback**; restrictions are not bypassed.
- Late joiners receive the current snapshot. A disconnected guest can rejoin using the invitation. Automatic reconnect and host migration are not implemented.
- Host departure, server restart, or expiration ends the room. Rooms last at most six hours, hold at most eight connections, and are not restored after an app/account restart.
- Invitations are bearer secrets: anyone possessing one can join. They are sent in a WebSocket message, not a URL query. No invitation history is persisted by the app.
- The server limits payload size, message rate, connections, rooms, members and outbound buffering, and checks host authority. Internet deployment still needs operational abuse controls (including connection/IP rate limits), TLS, and monitoring. It is not production-hardened or end-to-end encrypted against the relay operator.
- YouTube's terms and the existing unofficial playback integration still apply. Private synchronization is not a guarantee against account enforcement. This does not implement public rebroadcasting, account sharing, or artificial play reports.

## Validation

```sh
npm test --prefix listen-together
go test ./internal/session ./internal/api
npm test --prefix desktop
npm run build --prefix ui
```

Room tests use independent WebSocket clients: invitation validation/expiration, host-only publishing, late joining, host departure, field allowlisting, clock calculations, and the shared app transport. Session tests cover atomic guest synchronization, local volume, rejection of guest transport edits, paused loading, end/failure behavior, and stale engine reports.

Before treating this as ready for release, test two real accounts on different networks and operating systems, measure audible drift/traffic, and exercise slow buffering, sleep/wake, disconnect/rejoin and unavailable tracks.

### Relay limits and deployment

Each IP may hold at most 16 connections and four rooms. Rooms with only their host expire after 30 minutes; active rooms retain the six-hour maximum. WebSocket pong grace is 30 seconds to tolerate brief network interruptions. Host loss still ends a prototype room; invitations do not reconnect a host automatically.

Browser origins must match the relay host or be listed in comma-separated `ALLOWED_ORIGINS`. Desktop file origins (`null`) and clients without an Origin header are accepted. `TRUST_PROXY=1` trusts the last X-Forwarded-For hop only when the TCP peer is loopback. Set it only behind a loopback TLS proxy that overwrites/appends the client address; forwarded headers are otherwise ignored.

The UI allows arbitrary `wss:` endpoints in CSP to support user-selected self-hosted relays. This is a deliberate prototype trade-off: CSP cannot contain exfiltration over WebSockets after a renderer compromise. Deployments needing a fixed relay should restrict `connect-src` in `ui/vite.config.ts` to that relay. Invitations contain room credentials, not account tokens, and the protocol accepts only playback metadata.

The core has one shared playback session: a guest room locks transport for every controller, while volume remains local. Only the playback owner clears a stale room on reload; opening a second controller does not interrupt it. Blocked guests have a Retry playback button in the visible notice.
