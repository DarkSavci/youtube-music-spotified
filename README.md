# Youtube Music Spotified

A desktop client that plays YouTube Music through a Spotify-style interface.

Sign in with your YouTube Music account and get Spotify's layout, shortcuts and
now-playing view, plus crossfade, an equaliser, volume normalisation, timed
lyrics, listening stats and resume-where-you-left-off.

Unofficial personal project. Not affiliated with Spotify or YouTube.

## Requirements

- [Go](https://go.dev) 1.26+
- [Node.js](https://nodejs.org) 20+

[yt-dlp](https://github.com/yt-dlp/yt-dlp) is bundled: the build downloads
the latest release and verifies its checksum, and the app keeps it updated.

## Build

```bash
cd ui && npm install
cd ../desktop && npm install
npm run installer
```

This writes the app to `dist-desktop/` and the installer to
`dist-installer/Youtube-Music-Spotified-Setup-<version>.exe`. For the app
folder alone, run `node build.js` instead.

The installer is not code-signed, so Windows SmartScreen warns on first run:
choose **More info → Run anyway**.

## Run in development

```bash
go build -o bin/spotifier.exe ./cmd/spotifier
cd ui && npm run dev        # leave running
cd desktop && npm start     # in a second terminal
```

## Test

```bash
go test ./...
```

## License

MIT
