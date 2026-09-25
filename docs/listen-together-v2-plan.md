# Listen Together v2 plan

Status: v2 preview implemented and tested locally on `codex/listen-together-v2`. See `listen-together/README-v2.md` for implemented behavior, isolated preview commands, and rollout limits. The installed app and live relays remain untouched.

## Work boundary

Keep the installed application, its Spotifier profile, current playback and running relays untouched. Develop separately from PR #35. Any test application must have a distinct bundle identity and user-data directory; test relays use separate ports and synthetic rooms. The user has now authorized testing. Prefer isolated tests and keep the installed app available; installing the redesign or changing the live relay is still a separate rollout step. The daily updater is restricted to read-only checks until this constraint is lifted.

## Findings in v1

- `Together.tsx` stores the server address only in component state and defaults to localhost on remount.
- `protocol.mjs` deliberately strips artwork and the guest coordinator in `ui/src/lib/together.ts` constructs tracks with `artwork: []`. Player image elements have no missing/failed-image fallback. This explains absent artwork on guests; other image failures should still be tested separately.
- The relay has an anonymous member count, a single host socket and a host-published current-track snapshot. Host disconnection destroys the room.
- `follow_room` replaces the local queue with the current track and rejects guest transport/queue commands. Merely enabling guest buttons would not implement shared control.
- Packaged Electron sends `Origin: file://`; relay defaults currently accept `null` but require explicit configuration for `file://`. Deployment and diagnostics need to cover the actual desktop handshake.

## User flow

1. A compact server selector remembers named server entries and the last selection across restarts. Add/Edit opens a URL field, optional friendly name and connection check. Removing an entry removes only the saved configuration. Changing servers while in a room requires leaving first; editing an entry does not silently move an active connection.
2. With a server selected, show Create room and Join with PIN. Hide the raw URL behind server management, but keep the selected server name visible. A PIN is scoped to that server: friends must select the same server. Copy invitation can include the server label/address and PIN for convenience; importing an unfamiliar server never connects silently.
3. Creating a room offers Collaborative (default) and Host controls. The room view shows PIN/copy, current track, shared queue and participant avatars/names/status. The owner gets room settings, lock joining, rotate PIN, transfer ownership, kick and end room.
4. Normal player/queue controls work inside the room according to permissions. A persistent room indicator makes it clear that controls affect the shared session. Volume, output device and local mute remain personal.

## Room identity, PIN and moderation

- Generate an eight-digit numeric PIN with a cryptographic RNG, display it as `1234 5678`, retain leading zeroes, and enforce uniqueness among active PINs on each relay.
- A PIN authorizes initial admission only. Joining exchanges it for a strong, room-scoped member/resume credential. Owner privileges use a separate capability; the owner role is never accepted from a client-supplied field.
- Rotate PIN atomically replaces the admission code. The old code stops admitting newcomers immediately. Room ID, connected members, queue, playback and existing valid resume credentials remain unchanged. Serialize joins and rotation so their ordering is well-defined.
- Joining may be locked independently of playback. Rate-limit failed joins per source and across the relay, cap rooms/members, use uniform invalid/expired-code errors and avoid logging PINs or credentials. A short code does not replace a strong resume credential.
- Kicking disconnects the member and revokes their resume credentials. Offer Kick and rotate PIN as the default moderation action so the removed guest cannot immediately rejoin using the known code. Anonymous guests cannot be permanently identified: if someone shares the new PIN with them they may return. Do not claim a durable identity ban or block a whole shared household IP.
- Retain the existing bounded room lifetime initially (six hours); empty rooms expire after a short reconnect grace. Expiration must be visible and distinct from PIN rotation.

## Participants and attribution

- Use server-assigned member IDs and room-scoped, reconnectable sessions, not email addresses or claimed Google identities.
- Show the display name/avatar that will be shared before joining; allow a nickname and initials instead. Existing channel artwork may be used with the user's selection, but Google cookies, credentials and email addresses never cross the relay.
- Show connection/playback reports such as listening, buffering, reconnecting or unavailable. A connected socket alone does not prove that somebody can hear audio; local mute remains personal.
- Each queue insertion creates a unique entry ID plus server-stamped `addedByMemberId` and `addedAt`. Duplicate songs are separate entries. The now-playing item retains the same entry ID and attribution.
- Display the contributor avatar next to each queue row and the current track, with an accessible "Added by NAME" tooltip/label. Retain a small room-scoped profile snapshot after a contributor leaves so attribution does not disappear. Release this data when the room expires.

## Authoritative room state and commands

The relay owns the canonical queue, current queue-entry ID, repeat/shuffle policy, playback intent, position anchor, anchor timestamp and monotonically increasing revision. Clients resolve and play media through their own accounts. No audio streams or resolver URLs pass through the relay.

- Commands include play, pause, seek, next, previous, enqueue, remove and reorder. Use explicit play/pause commands instead of a non-idempotent toggle on the wire.
- Each command has a member-scoped operation ID for retry deduplication and a base revision. Validate permissions, sizes and numeric ranges on the relay. Return an acknowledgement or a recoverable command rejection instead of disconnecting a healthy member for a normal edit conflict.
- Process commands in one server order. Queue edits address entry IDs and before/after entry IDs rather than mutable array indexes. Concurrent additions may both succeed; stale seek/skip commands tied to an old current entry are rejected. Structural conflicts return the latest revision for retry.
- Broadcast accepted state revisions and timing anchors. Clients discard old revisions, estimate server-clock offset and correct meaningful drift. Async media resolution is generation-guarded so a slow result cannot replace a newer song or apply after leaving.
- The server advances the room once when the shared timeline reaches the current entry's validated duration. Member end notifications are observations, not unconditional skip commands. Do not wait for every listener to buffer: a late listener catches up; a locally unavailable track shows a clear state and waits for the next room item.
- Collaborative mode allows members to control playback and add/remove/reorder the shared queue. Host-controls mode permits only the owner to mutate playback/queue. Ownership/moderation is owner-only in both modes. Room-mode changes are validated and take effect at a revision boundary.
- Route all command entry points through this permission layer: player, queue, mini player, context menus, keyboard shortcuts and native media controls. Applying a room snapshot must not emit another outgoing command.
- Extend the local playback integration to mirror room queue metadata while keeping room advancement authoritative. Preserve each listener's pre-room queue/preferences separately; leaving pauses room playback and restores the personal queue without unexpectedly starting it.

## Disconnects and owner absence

Ordinary disconnects retain a member seat for a bounded grace period and reconnect with the resume credential, even after PIN rotation. A kicked/expired credential never resumes. On reconnect fetch a full snapshot before applying newer commands; do not replay stale offline transport actions.

The room must not depend on the owner's socket. During a short owner reconnect grace, the relay keeps the room and timeline alive. If the owner does not return, randomly select an eligible connected member on the server, transfer ownership atomically and announce it. In Host-controls mode, controls wait for the returning/new owner; already playing music can continue. An explicit End room still ends the room for everybody; ordinary Leave offers Choose next leader or Leave now; Leave now randomly assigns an eligible connected member without ending the room. Cancel remains available. Voluntary departure transfers leadership immediately; reconnect grace applies to unexpected disconnections. For the first v2 release relay restarts end rooms cleanly; persistence across server restarts is a separate scope.

## Artwork repair

Resolve track metadata locally by canonical track ID where supported and cache it per account context. Additionally allow validated public YouTube artwork metadata in the bounded room track schema for prompt rendering. Never share account cookies, local paths, stream URLs or arbitrary remote image URLs. Avatar/artwork hosts and payload sizes must be constrained; arbitrary relay-side image fetching is not needed.

Render a neutral artwork placeholder when the source is missing or fails, including the now-playing bar, queue, fullscreen and mini player. A metadata refresh must not restart playback, change track identity or reset timing. Apply fetched metadata only if it still matches the current entry/generation. Verify video-track art, expired images, slow resolution and account switching.

## Shared video version, personal video display

These are separate states. All listeners follow the same canonical media version and timeline; displaying its video is a per-listener preference.

- Add a persisted Listen Together checkbox, **Follow others’ video display changes**, off by default. Explain: everyone still hears the same version; this setting controls whether other members show/hide video on your screen. It does not grant extra room permissions.
- When an authorized member enables video for an audio-only room item, resolve and propose its matching video version. Commit the selected ID, duration and timing anchor as one server revision. All clients then play that version's audio, including clients with the checkbox off. Preserve the queue entry and contributor attribution.
- Share a separate, revisioned video-display intent with its initiating member. Opted-in listeners follow that intent; opted-out listeners keep their local visibility preference. Applying remote visibility must never emit another room command. Do not open fullscreen or change window mode remotely.
- Once the room is on a video version, hiding the picture only changes presentation. It must not switch the room back to the song version, stop audio, reset position or advance the queue. An explicit switch to the song version remains a distinct, permission-checked room operation.
- A listener can manually show/hide pictures for the current video without needing playback-control permission. Only permitted members can change the room's media version or publish room display intent. In host-controls mode a guest cannot use the video button to bypass the owner.
- With local video hidden, keep the audio engine on the same media version and do not fetch the picture stream. If picture loading fails, keep audio playing and show a retry/fallback. If the shared media itself cannot play on an account, report unavailable instead of silently selecting a different-length version.
- Reuse validated song/video pairing and current timing rules: similar durations can retain timing; materially different edits need a deliberate shared position decision and cannot inherit inaccurate synchronized lyrics. Maintain the original song metadata reference for lyric lookup, using synchronized lyrics only when timing is compatible.
- Mini player retains mutually exclusive video/lyrics/queue views. Following a video-show intent may select video only with opt-in; merely receiving a video-version track must not displace an opted-out user's lyrics or queue. Normal view can still show lyrics beside video.
- Late joins and reconnects receive media state and latest display intent together, then apply local preferences. Do not treat missing display intent from an older protocol as a request to close an existing panel.

Current code combines version switching and visibility in `setVideoEnabled()`: disabling video can switch a standalone/host session back to audio. Split those responsibilities before wiring collaborative commands.

Acceptance: one listener watches while another hears the video version with lyrics visible; hide/show leaves ID/position/queue unchanged; opt-in follows display intent without echo loops; opt-out never auto-opens video; stale variant resolution cannot replace a newer entry; host-only permissions hold; missing videos and video-stream failures preserve valid audio playback.

## Protocol and deployment

Introduce a versioned v2 hello/capability handshake and reject incompatible client/relay combinations with actionable messages. Do not interpret v1 invitation tokens as PINs. Coordinate deployment and document the minimum app/relay versions rather than silently replacing the live v1 relay.

Connection checks distinguish malformed URL, DNS/network failure, TLS failure where observable, rejected handshake and protocol incompatibility. Browser WebSocket APIs hide some failure details, so do not invent a precise HTTP/TLS diagnosis in the renderer; a bounded desktop diagnostic may provide that detail. Preserve certificate validation and explicitly document `file://` origin support behind the deployed reverse proxy.

## Delivery order and acceptance

1. Saved servers, versioned handshake/diagnostics, artwork hydration and graceful image fallbacks.
2. PIN admission, independent member credentials, roster, owner controls, lock, rotation, kick and reconnect lifecycle.
3. Canonical room queue/timeline, permissions and deduplicated collaborative commands; all transport entry points follow the same rules.
4. Contributor avatars, participant states, leaving/restoring personal queues, owner transfer and UX polish.
5. Isolated Mac/Windows end-to-end tests and coordinated relay rollout. Install into the user's normal app only after explicit permission.

Acceptance tests should cover concurrent skips/seeks/additions/reorders, duplicate command delivery, one advancement at track end, owner disconnect/return/transfer, leaving during an in-flight request, PIN rotation without playback interruption, old-PIN rejection, kick plus credential revocation, guessed-code throttling, full rooms, unavailable media, artwork failures, old/new protocol mismatch and zero outgoing credentials/media URLs. Testing is now authorized by the user. Start with isolated unit/fixture and integration tests; do not replace the current installed app or deploy a relay redesign as part of a test.

## Product research — 2026-09-25

These are product references and proposed refinements, not a claim that the features are implemented or that every suggestion is committed scope.

| Official reference | Documented behavior | Proposed adaptation |
| --- | --- | --- |
| [Spotify Jam](https://support.spotify.com/au/article/jam/) | Guests can still add songs when the host disables playback control; invitations support links and QR codes. | Separate permission to contribute songs from permission to interrupt playback. Add a Contributions mode between host-only and fully collaborative. Keep PINs as the basic join path; links/QR can follow. |
| [YouTube collaborative playlists](https://support.google.com/youtube/answer/6109639?hl=en-uk) | Contributor pictures appear on additions; contributors can remove their own additions, while the owner can remove others. Voting is configurable. | Contributor-level queue editing by default in Contributions mode. Offer voting explicitly, not as a hidden automatic queue reorder. |
| [Apple Music SharePlay](https://support.apple.com/en-us/108767) | The speaker/car flow uses QR invitation plus host approval and distinguishes leaving from ending the session. | Optional waiting room with a preview of the joining person's name/avatar. Keep Leave and End room visibly separate. This shared-speaker flow is not equivalent to our independent remote playback model. |
| [Watch2Gether](https://community.w2g.tv/t/how-to-use-watch2gether/736) | Player and playlist permissions are separate; people can suggest content without immediately playing it. | Allow Add/request without interruption; show who requested a track. A leader can approve a request when queue editing is restricted. Avoid adding a whole chat system just to support requests. |
| [Syncplay](https://syncplay.pl/guide/client/) | Supports readiness, a countdown when everyone is ready, duration-mismatch warnings and undoing a seek. | Optional Start together for deliberate album/video sessions; ordinary music rooms keep playing through individual buffering. Add an Undo affordance for accidental edits, guarded by room revision so it cannot undo newer work. |

### Recommended refinements

1. Offer three understandable presets: Collaborative (shared control), Contributions (leader controls transport; guests add and manage their own entries), and Listen only. Keep Leader/DJ/Listener capabilities internal or in advanced member settings rather than requiring a permission matrix at room creation.
2. Separate queue policy from permissions: FIFO by default, optional Take turns, optional voting later. Take turns preserves each contributor's order, skips empty contributor lists, and does not interrupt the current song. Show the projected next order. Popularity should not silently override fairness.
3. Distinguish Add to queue from Play now; Play now is a room interruption requiring transport permission. Provide a brief Undo for removals/reorders when their revision is still current.
4. Add a room history with contributor attribution and Save as playlist. This preserves discoveries without needing a chat/social feed. Saving remains a deliberate local-account action, never an automatic mutation of everyone's libraries.
5. Optional readiness/countdown is a separate room setting, not the normal handling of slow clients. Include a leader override and timeout so an absent person cannot deadlock playback.
6. Add optional join approval and keep invitation management on the room page. Defer public rooms, friend graphs, voice/chat and notifications outside active sessions.

The above are recommendations derived from the references, not direct copies of those products. Keep user-requested random/chosen leadership handover, independent audio volume and opt-in shared video display even where another product behaves differently.

### Additional accepted details

- Show In sync, Catching up, Buffering and Track unavailable; Resync me affects only the local player. These are client reports, not proof of audible sound.
- Distinguish Added by from Last controlled by; keep a bounded activity feed and opt-in notifications within the app.
- Offer contribution limits and duplicate prevention; skip voting counts connected members, requires a strict majority and resets on a new current entry.
- Leader moderation is separate from DJ transport capability. Contributions mode allows guests to add/remove their own upcoming songs; changing overall queue order requires transport control.

## Preview validation — 2026-09-25

- 18 relay/protocol tests and 35 desktop/coordinator/video tests pass; the Go suite and production UI build pass.
- UI checked against an isolated Go fixture catalog and v2 relay: create/join by PIN, contributor artwork, three-member roster, leadership handover, PIN rotation without removing participants, settings, and paused shared skip.
- Preview uses sample catalog results and explicitly labelled test participants. It does not prove real macOS-to-Windows audio synchronization, signed-in video/lyrics behavior, or production reverse-proxy compatibility. Those are rollout checks, not claims of this preview.
- No changes to the installed application, its account/profile, or `listen.hisarops.com`. No v2 PR or relay deployment published.
