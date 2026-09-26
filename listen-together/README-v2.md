# Listen Together v2 preview

V2 is a new protocol. Deploy it alongside v1 while testing; the existing `server.mjs` remains the v1 relay. **Do not point a v2 app at the existing production v1 relay.** A v2 client reports a compatibility/handshake error instead of silently using the old invitation format.

```sh
cd listen-together
npm ci
PORT=8766 HOST=127.0.0.1 npm run start:v2
```

For remote access, put this listener behind an HTTPS reverse proxy that forwards WebSocket upgrades. Enter its `wss://` URL in the app. TLS verification must remain enabled. Desktop `file://` and opaque `null` origins are accepted explicitly; a browser preview must be listed in `ALLOWED_ORIGINS` (comma separated, exact origins). Origin checks are not authentication: the PIN admits a member and a separate unguessable credential authorizes reconnecting.

`TRUST_PROXY=1` accepts the rightmost X-Forwarded-For value **only from a loopback peer**. Configure the local reverse proxy to overwrite/append the real peer address, and do not expose the Node port directly. Without this setting, all clients of a local proxy share its address limits. Limits: 100 rooms and 12 seats per room (the `maxRooms` and `maxMembers` options of `createRoomServerV2`); the rest are fixed in `server-v2.mjs`: 200 connections, 24 connections/address, four created rooms/address, and 30 create/join attempts/address/minute (600 across the relay). Reconnecting with a room credential has its own limit of 60/address/minute and does not count toward the create/join limits. IPv6 addresses are grouped by /64. Each room sends at most one state update every 200 ms; a listener whose connection falls behind skips to the latest state instead of being disconnected. The canonical queue holds at most 500 entries; additions are limited to 100 songs per command. Rooms expire after six hours; a disconnected seat has 20 seconds to resume, and an empty room expires after a minute. Restarting the relay ends rooms.

## Implemented preview

- Persisted named server entries and selected server; 8-digit server-scoped PINs.
- Collaborative, Contributions and Listen-only presets; leader/DJ/listener permissions.
- Song requests in Contributions ("Take requests") rooms: a guest's additions wait in `requests` until the leader or a DJ accepts them (play next or add to queue) or declines them; guests may cancel their own. At most 50 requests wait per room and 10 per guest, and a guest may make 10 requests a minute (cancelling does not refund one), so request-and-cancel loops cannot flood the leader. Waiting requests count toward the per-guest limit and duplicate rule when asked; on accept duplicates and the 500-song cap are rechecked, but the per-guest limit is not: an explicit accept by the leader or a DJ is an intentional override. Requests do not move the room revision, and leave with their requester. `autoAccept` restores direct additions; switching to Collaborative accepts waiting requests and Listen-only clears them. A plain `enqueue` from a guest is treated as a request, so older apps keep working.
- Shared canonical queue/timing, operation deduplication, stale command rejection and single server-side track advancement.
- Songs end on the relay's clock or on the first member report (`ended {current}`, accepted within 10 s of the length, or at any time for a song without one); members who can control playback report measured lengths (`duration {entry, durationMs}`), accepted once per song and within 15 s of the length it was added with, to fill missing or slightly wrong catalogue lengths. When every connected member reports the current song unavailable (`status` with its `entry`), the room moves on after 10 s. `previous` carries `restart` (the sender's intent) so simultaneous presses restart once. Skips are pinned to the current song rather than the room revision. A song added after the queue ran out (`finished`) starts playing.
- Member roster, contributor identity, playback reports, local resync and optional in-app activity notifications.
- Lock joining, optional approval, kick plus PIN rotation, PIN rotation without interruption.
- Leave with a selected/random next leader; separate End for everyone; reconnect grace.
- FIFO or contributor turns, contribution limits, duplicate prevention, majority skip voting, guarded queue-edit undo.
- History and deliberate save to a personal playlist; optional ready check/countdown with override and timeout.
- Shared song/video selection and independent picture visibility, with opt-in remote display changes.
- Public artwork metadata allowlist and broken/missing artwork fallback.
- Leaving or a room ending carries on with the room's queue (same song, position and play state); the queue from before the room comes back only when switching to another room or when the room had nothing queued. While a room is active the room's queue is the saved resume point, so quitting mid-room reopens where the room was, paused.

Every listener needs their own playable YouTube session; rooms transmit no audio or signed stream URLs. Profile names/pictures are display choices, not verified identities. Kick revokes the seat's credential and rotates the PIN, but does not permanently identify/ban an anonymous person who is given a new PIN.

## Local preview without touching the installed app

Use a separate data directory and core port. The fixture catalog is recorded test data, not a live account; searches return fixtures and are intended for UI/protocol testing.

```sh
mkdir -p /tmp/spotifier-room-v2-preview
go build -o /tmp/spotifier-room-v2-preview/spotifier ./cmd/spotifier
/tmp/spotifier-room-v2-preview/spotifier -addr 127.0.0.1:18674 -catalog fixture -fixtures testdata/fixtures -credentials /tmp/spotifier-room-v2-preview/credentials.json -db /tmp/spotifier-room-v2-preview/preview.db -cache /tmp/spotifier-room-v2-preview/cache
# In separate terminals:
PORT=18766 ALLOWED_ORIGINS=http://127.0.0.1:15219 node listen-together/server-v2.mjs
cd ui
VITE_ROOM_PREVIEW=1 SPOTIFIER_DEV_CORE=http://127.0.0.1:18674 npm run dev -- --port 15219 --strictPort
```

Open `http://127.0.0.1:15219/#/together` and save `ws://127.0.0.1:18766` as a server. For a second independent audio client, run another core with its own database/credentials and a separate browser origin/profile. Two tabs sharing a core are not two independent playback devices.

## Verification and remaining rollout

```sh
node --test listen-together/test/*.test.mjs
node --test desktop/test/*.test.js
go test ./...
cd ui && npm run build
```

Production relay rollout, packaged macOS/Windows audio synchronization testing, and installation into the regular app remain separate from this isolated preview. QR invitations, relay restart persistence and public-room/social discovery are not part of this preview.
