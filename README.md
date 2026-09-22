# Youtube Music Spotified

A Windows desktop client that plays YouTube Music through a Spotify-style interface.

[![Release](https://img.shields.io/github/v/release/DarkSavci/youtube-music-spotified)](https://github.com/DarkSavci/youtube-music-spotified/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/DarkSavci/youtube-music-spotified/release.yml?label=build)](https://github.com/DarkSavci/youtube-music-spotified/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![Album page with a track playing](docs/screenshots/album.jpg)

Sign in with your YouTube Music account to get your library, likes and
playlists in Spotify's layout, with its shortcuts and now-playing view.

Unofficial personal project. Not affiliated with Spotify or YouTube.

## Download

Get the installer from the
[latest release](https://github.com/DarkSavci/youtube-music-spotified/releases/latest).
The app then updates itself.

The installer is not code-signed, so Windows SmartScreen warns on first run:
choose **More info → Run anyway**.

## Features

- **Spotify's layout:** library sidebar, album and artist pages, queue, full-screen now playing
- **Premium audio quality** for YouTube Music Premium accounts, through a bundled [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- **Timed lyrics** that follow the song
- **Crossfade, equaliser and volume normalisation**
- **Your listening:** stats built from your own play history
- **Resume where you left off**, even after a restart
- **Mini player, tray controls and media keys**; closing the window keeps the music playing
- **Automatic updates** from GitHub releases

## Screenshots

| Artist | Lyrics |
| --- | --- |
| ![Artist page](docs/screenshots/artist.jpg) | ![Full-screen lyrics](docs/screenshots/lyrics.jpg) |

![Full-screen now playing](docs/screenshots/now-playing.jpg)

## Build from source

Requires [Go](https://go.dev) 1.26+ and [Node.js](https://nodejs.org) 20+.

```bash
cd ui && npm install
cd ../desktop && npm install
npm run installer
```

This writes the installer to
`dist-installer/Youtube-Music-Spotified-Setup-<version>.exe`, and the unpacked
app to `dist-desktop/`. For the app folder alone, run `node build.js` instead.

The build downloads the latest yt-dlp and checks it against the release's
checksum. The app then keeps yt-dlp up to date on its own.

### Run in development

```bash
go build -o bin/spotifier.exe ./cmd/spotifier
cd ui && npm run dev        # leave running
cd desktop && npm start     # in a second terminal
```

### Test

```bash
go test ./...
```

### Screenshots

```bash
cd desktop && node build.js && npx electron readme-shots.js
```

The app is captured signed out, so no account data ends up in them.

## Releasing

Bump `version` in `desktop/package.json` and push to `master`, or run the
**Release** workflow from the Actions tab, which bumps the version for you.
GitHub Actions builds the installer and publishes the release, and installed
copies update to it.

## License

[MIT](LICENSE)
