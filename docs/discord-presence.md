# Discord Rich Presence

Desktop builds can publish opt-in listening activity through the locally running Discord desktop client on macOS, Windows and Linux. No Discord user token, client secret, bot, or OAuth login is used.

## Application setup

Create a Discord application in the [Developer Portal](https://discord.com/developers/applications) and copy its public application ID. Set its name/icon to the project branding. Enter the ID in the app's Settings → Discord and enable activity sharing. A maintainer-owned application is recommended for releases; individual IDs allow testing without shipping someone else's identity. There is deliberately no borrowed or invented default ID.

Enable activity visibility in Discord itself. Play a song, check presence from a second Discord account, then pause, seek, change songs, leave a room, disable sharing, restart Discord, and quit the music app. Presence clears when paused, stopped, playing on another device, or disabled. It reconnects when Discord becomes available. Windows named pipes and macOS/Linux runtime sockets are searched locally.

Current scope: song/artist, public artwork where supported, progress adjusted for playback speed, a Listen on YouTube Music button, and separately opt-in room-name sharing. Names are visible to the audience allowed by the user's Discord settings. The room preference is also available under Listen Together → Your experience. No PIN, server address, participant identity, signed stream URL or account credential is sent.

## Joining rooms from Discord

A Join button is not yet implemented. It needs a complete invitation flow: leader permission, listener opt-in, revocable invitation credentials, supported platform protocol registration, confirmation before joining/replacing playback, and enforcement of capacity/lock/approval/kick rules. PIN rotation must invalidate old invitations. This remains tracked in issue #39 rather than presenting a nonfunctional toggle.

## Validation

`node --test desktop/test/discord-presence.test.js` covers metadata boundaries, opt-in, framed IPC parsing, handshake, heartbeat responses, clearing, disconnect/reconnect cancellation, platform socket paths, status changes pushed to Settings, and a refused application ID (close code 4000) reporting an error without retrying while rate limits still retry. Live display requires a real application ID and a second Discord account; mocked IPC tests do not prove Discord's rendering or approval of external artwork.

Protocol references: [Discord RPC](https://github.com/discord/discord-api-docs/blob/main/developers/topics/rpc.mdx), [local IPC framing](https://github.com/discord/discord-rpc/blob/master/documentation/hard-mode.md).

Live macOS verification (2026-09-25): a user-owned test application completed the local IPC handshake; Discord acknowledged SET_ACTIVITY, displayed “Listening to Youtube Music Spotified Test” on the user profile, and acknowledged clearing activity on pause. This verifies the local integration and listening type. On Windows (2026-09-25), the named pipe `\\?\pipe\discord-ipc-0` connected to a running Discord, which refused a well-formed but unregistered ID with close code 4000; the app now shows that as an application ID error. Publishing activity on Windows and a second-account check of artwork/buttons remain outstanding. The test application ID is not shipped as a default.
