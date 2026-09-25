# Changelog

Every release of Youtube Music Spotified, newest first.

## 0.1.9 — 2026-09-25

### New

- Show copy icon when hovering share actions
- Polish desktop browsing, fullscreen and listening rooms
- Scroll the volume bar with the mouse wheel and use one video toggle everywhere
- Refresh library navigation and contextual controls
- Add music video playback and song switching
- Prototype private listening rooms and add release notes dialog

### Fixed

- Keep repeating playlists to themselves instead of adding radio
- Show the video when a restored track is the video version without its flag
- Draw Windows caption buttons over fullscreen content without a dark box
- Detect silent Listen Together disconnects and retry full rooms
- Keep the fullscreen close button clear of Windows caption controls
- Reduce topbar height and align native window controls
- Align Mac caption controls and simplify navigation arrows
- Harden relay limits, keep focus on busy buttons and let guests retry with Play
- Require a per-launch client token for video routes and address review follow-ups
- Deduplicate Browse all categories by destination
- Avoid carrying already logged playback into another version
- Allow desktop CORS video requests without opening cross-site embeds
- Address playback, relay and navigation review feedback
- Disable unavailable video controls with explanatory tooltips
- Prefer song timings over plain video lyrics
- Separate mini-player modes and recover video lyrics
- Recover from missing route bundles without blanking the app
- Scroll entity headers and load playlist pages on demand


## 0.1.8 — 2026-09-24

### New

- Show profile photos in the account switcher
- Add anchored account menu with quick channel switching
- Add saved Google accounts and YouTube channel switching
- Add native macOS source builds and desktop integration

### Fixed

- Handle saved accounts without YouTube channels
- Measure normalization before user volume attenuation
- Require owned music service readiness before loading the app


## 0.1.7 — 2026-09-23

### Fixed

- Report plays to YouTube Music history instead of YouTube


## 0.1.6 — 2026-09-22

### New

- Generate the changelog from commits and show What's new in the app

### Fixed

- Show music videos saved in a playlist
- Load every track of playlists longer than 100 songs


## 0.1.5 — 2026-09-22

### New

- Make the listening page interactive, with lookup and top albums

### Fixed

- Fetch covers at the size a view needs
- Keep the mini player above other windows
- Ignore partial reads when timing the crossfade


## 0.1.4 — 2026-09-22

### Fixed

- Pass browse params so mood tiles and Show all open


## 0.1.3 — 2026-09-22

### Fixed

- Bundle deno so yt-dlp can resolve streams


## 0.1.2 — 2026-09-22

### Fixed

- Make update downloads work and show version in Settings


## 0.1.1 — 2026-09-22

### New

- Add app log file and problem report export


## 0.1.0 — 2026-09-22

### New

- Auto-update from GitHub releases and release workflow
- Add tray controls, close to tray, and a Spotify-style mini player
- Add Mix, Search, Settings, and Stats views with corresponding components and functionality


