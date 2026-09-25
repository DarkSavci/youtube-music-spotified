# Listen Together v2 preview

V2 is a new protocol. Deploy it alongside v1 while testing; the existing `server.mjs` remains the v1 relay. **Do not point a v2 app at the existing production v1 relay.** A v2 client reports a compatibility/handshake error instead of silently using the old invitation format.

```sh
cd listen-together
npm ci
PORT=8766 HOST=127.0.0.1 node server-v2.mjs
```

For remote access, put this listener behind an HTTPS reverse proxy that forwards WebSocket upgrades. Enter its `wss://` URL in the app. TLS verification must remain enabled. Desktop `file://` and opaque `null` origins are accepted explicitly; a browser preview must be listed in `ALLOWED_ORIGINS` (comma separated, exact origins). Origin checks are not authentication: the PIN admits a member and a separate unguessable credential authorizes reconnecting.

`TRUST_PROXY=1` accepts the rightmost X-Forwarded-For value **only from a loopback peer**. Configure the local reverse proxy to overwrite/append the real peer address, and do not expose the Node port directly. Without this setting, all clients of a local proxy share its address limits. Defaults are 100 rooms, 12 seats per room, 200 connections, 24 connections/address, four created rooms/address, and 30 admission attempts/address/minute (600 globally). The canonical queue holds at most 500 entries; additions are limited to 100 songs per command. Rooms expire after six hours; a disconnected seat has 20 seconds to resume, and an empty room expires after a minute. Restarting the relay ends rooms.

## Implemented preview

- Persisted named server entries and selected server; 8-digit server-scoped PINs.
- Collaborative, Contributions and Listen-only presets; leader/DJ/listener permissions.
- Shared canonical queue/timing, operation deduplication, stale command rejection and single server-side track advancement.
- Member roster, contributor identity, playback reports, local resync and optional in-app activity notifications.
- Lock joining, optional approval, kick plus PIN rotation, PIN rotation without interruption.
- Leave with a selected/random next leader; separate End for everyone; reconnect grace.
- FIFO or contributor turns, contribution limits, duplicate prevention, majority skip voting, guarded queue-edit undo.
- History and deliberate save to a personal playlist; optional ready check/countdown with override and timeout.
- Shared song/video selection and independent picture visibility, with opt-in remote display changes.
- Public artwork metadata allowlist and broken/missing artwork fallback.
- Personal queue restoration, paused on leave, and persistence of the personal queue while a room is active.

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
