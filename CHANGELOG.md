# Changelog

Every release of Youtube Music Spotified, newest first.

## 0.2.1 — 2026-09-27

### New

- Artist radio, full-catalogue play and an all-songs view (#47, #48)
- Ask the leader before a guest's song joins a Take requests room

### Fixed

- Say when signing in is needed for every library change, and strip stream error URLs
- Show YouTube's wait, say when signing in is needed, and keep request keys out of errors
- No false skip after a brief outage, and a temporary resolver fallback
- Polish the liked reads, retry menu entry and liked count
- Menus, likes, video and playing keep working with fewer requests
- Keep the mixes through a signed-out start, and never show kept likes to a signed-out session
- Clearing the cache for an account change starts no edit lag window
- Never keep a failed or signed-out answer, and forget an account's cache on sign-out
- Recover from a lost connection faster and more surely
- A success ends a cooldown only if it began after the cooldown did
- Only the empty state reads as no likes, and follow the live session
- An account with no likes gets an empty Liked Music, not an error
- Tell signed-out and message-page Liked Music apart from throttling
- Treat header-less Liked Music the same everywhere, and keep artist pins
- Read Liked Music without its header, and open library artists
- Close the gaps the request governor left
- Tighten connection-loss handling after review
- Wait out a lost connection instead of skipping the queue
- Give every keyboard shortcut its own id
- A track played from a warmed deck ends a run of failures
- Never let an older projection overwrite a stall, and re-report it after a seek
- Keep a stall honest through retries, creep and stale reports
- Show buffering at once and give up on a dead stream in seconds
- Keep the Songs page's opened releases, and retry the ones that failed
- Open every release on the artist Songs page, albums first
- Say when a radio batch had only songs the room already had
- Radio never brings back a song the room jumped past
- Say what closing the window does with Close to tray off on Windows
- Closing the window quits when close to tray is off
- Radio only from playback controllers, and it gives way
- A failed preload backs off, and a new list is never mistaken for the current one
- People's songs go ahead of the room's radio
- A track that fails while paused stays put instead of skipping ahead
- Artist Play replaces a queue that merely starts on the same song
- Take only the artist's own songs from releases, one per song
- Keep artist shuffle to the artist and the songs page complete
- Report failures the engines were still able to drop
- Don't panic when the stream retry after a 403 cannot connect
- Give YouTube's embedded player the Referer it requires
- Make the embedded fallback play, and fail instead of hanging
- Report a dead track once, and never sit on a silent "playing"
- Stop Listen Together length reports from cutting songs short or stalling the room
- Make Listen Together move to the next song reliably and play radio from a song
- Keep a refused accept from trimming the room's played songs
- Tighten song requests after review
- Keep the saved queue in an empty room, and shuffle a kept room queue
- Say that leaving a room keeps its music playing
- Keep the room's queue when leaving Listen Together
- Drop the leading dot on a mix with no description
- Keep long album titles from breaking the page header (#46)
- Read album release type, unlinked artists, description and shelves

### Faster

- Make far fewer requests from the UI
- Keep YouTube's answers, so repeat views and restarts don't ask again
- Remember failed stream lookups and bound speculative prefetches
- Pace autoplay's radio pages and stop on a radio with nothing new
- Pace every YouTube call and back off when YouTube says to


## 0.2.0 — 2026-09-25

### New

- Choose playback speed on a slider with presets, as YouTube does
- Playback speed
- Open at login, off by default
- Right-click the playing track in the bar for its menu
- Play library items straight from the sidebar

### Fixed

- Make the speed panel's steps and focus work, and remote position hold
- Stop the mini player shrinking past what its layouts can show
- Give the mini player's speed control room in every shape
- Interpolate at 1x while another device is playing
- Repoint a login entry left by a moved install
- Retry the liked list instead of giving up on the first failure
- Keep the lyrics view's close button visible and its caption clear
- Show media controls in the taskbar thumbnail
- Align the Share label with the other context menu items
- Give the What's new dialog a single, themed scrollbar


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


