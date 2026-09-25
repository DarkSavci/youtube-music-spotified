// Command spotifier runs the Go core.
//
// One binary, two modes:
//
//	spotifier                    # local: all planes in-process, the desktop sidecar
//	spotifier -catalog fixture   # local, offline: serves recorded responses
//
// Server mode, which lifts the Catalog and Control planes out while leaving
// Identity on the Device, is not implemented yet and is deliberately a later
// milestone rather than a different program.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"spotifier/internal/audiocache"
	"strings"
	"syscall"
	"time"

	"spotifier/internal/account"
	"spotifier/internal/api"
	"spotifier/internal/catalog"
	"spotifier/internal/control"
	"spotifier/internal/domain"
	"spotifier/internal/innertube"
	"spotifier/internal/loudness"
	"spotifier/internal/lyrics"
	"spotifier/internal/mixes"
	"spotifier/internal/obs"
	"spotifier/internal/report"
	"spotifier/internal/resolver"
	"spotifier/internal/session"
)

func main() {
	var (
		addr         = flag.String("addr", "127.0.0.1:8674", "listen address")
		catalogMode  = flag.String("catalog", "auto", "catalog source: auto | innertube | fixture")
		fixtureDir   = flag.String("fixtures", "testdata/fixtures", "fixture directory")
		accountScope = flag.String("account-scope", "", "desktop account scope for delayed play reports")
		credPath     = flag.String("credentials", "credentials.json", "path to credentials")
		dbPath       = flag.String("db", "spotifier.db", "control-plane database")
		verbose      = flag.Bool("v", false, "debug logging")
		resolverMode = flag.String("resolver", "auto", "stream resolver: auto | ytdlp | library")
		ytdlpBin     = flag.String("ytdlp", "", "path to yt-dlp (default: found on PATH)")
		denoBin      = flag.String("deno", "", "path to deno, the JavaScript runtime yt-dlp needs (default: found on PATH)")
		cacheDir     = flag.String("cache", "", "song cache directory (default: beside the credentials)")
	)
	flag.Parse()

	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	rec := obs.NewRecorder()
	// The token comes through the environment rather than a flag, so it does
	// not show up in process listings.
	deps := api.Deps{AccountScope: *accountScope, ClientToken: os.Getenv("SPOTIFIER_CLIENT_TOKEN"), Recorder: rec, Log: log}
	// Keep it out of the environment yt-dlp and deno inherit.
	_ = os.Unsetenv("SPOTIFIER_CLIENT_TOKEN")

	// The Control plane is ours and needs no credentials. If it cannot open,
	// browsing and playback still work; only the statistics surfaces and the
	// history-backed library sorts go missing.
	ctrl, err := control.Open(context.Background(), *dbPath)
	if err != nil {
		log.Warn("control plane unavailable; stats and added/recents sorts disabled", "err", err)
	} else {
		defer ctrl.Close()
		deps.Control = ctrl
		// Resolved URLs outlive a restart, so replaying within their six
		// hours skips yt-dlp.
		deps.URLs = ctrl
	}

	// Credentials are optional and may arrive later: signing in happens while
	// this process is running. The store re-reads the file on demand, which is
	// what lets a sign-in take effect without restarting playback.
	acct := account.New(*credPath, rec, ctrl)
	credErr := acct.Reload()
	deps.Account = acct

	// The catalog client is built from whatever credentials exist now. It is
	// separate from the Identity plane on purpose: public metadata does not
	// need an account, so browsing keeps working while signed out.
	creds, _ := innertube.LoadCredentials(*credPath)

	/*
	 * Choose a stream resolver.
	 *
	 * yt-dlp is preferred where it exists because it applies account cookies
	 * the way a browser does and so reaches the subscriber-only audio tiers.
	 * The pure-Go library drives its own client identity and cannot be handed
	 * those cookies — doing so turns a working stream into a 403 — so it
	 * serves standard tiers and stands as the fallback.
	 */
	deps.Resolver = buildResolver(*resolverMode, *ytdlpBin, *denoBin, *credPath, creds, log)

	// Audio on disk beside the rest of the app's data, so a track played or
	// prefetched once starts without resolving. The cap is the client's to
	// set; this default holds a few hundred songs.
	if *cacheDir == "" {
		*cacheDir = filepath.Join(filepath.Dir(*credPath), "audio-cache")
	}
	if cache, err := audiocache.New(*cacheDir, 2<<30); err != nil {
		log.Warn("audio cache unavailable; every play streams from upstream", "err", err)
	} else {
		deps.Audio = cache
	}

	switch *catalogMode {
	case "fixture":
		deps.Catalog = mustFixture(*fixtureDir, rec, log)
	case "innertube":
		deps.Catalog = catalog.NewInnerTube(innertubeClient(creds), rec)
	default: // auto
		deps.Catalog = catalog.NewInnerTube(innertubeClient(creds), rec)
	}

	/*
	 * Lyrics.
	 *
	 * The YouTube source needs the credentialed client, so it exists only
	 * while signed in. The timed source is a third party and is constructed
	 * unconditionally but contacted only when the client asks for timings,
	 * which the user controls in Settings.
	 */
	if client := acct.Current().Client; client != nil {
		deps.Lyrics = &lyrics.Service{
			Primary: lyrics.NewInnerTube(client, rec),
			Timed:   lyrics.NewLRCLib(),
		}
	} else {
		deps.Lyrics = &lyrics.Service{Timed: lyrics.NewLRCLib()}
	}

	/*
	 * Loudness.
	 *
	 * Signed in only, because the figure comes from a player response and an
	 * anonymous one carries no Premium formats worth normalising. Absent, the
	 * client measures as it plays, which is what it did before.
	 */
	if client := acct.Current().Client; client != nil {
		deps.Loudness = &loudness.Service{Client: client}
	}

	// Mixes need both halves: our history for the seeds, the catalog for the
	// radio that expands them.
	if deps.Control != nil && deps.Catalog != nil {
		deps.Mixes = mixes.New(deps.Control, deps.Catalog)
	}

	// Playback state is authoritative here rather than in the UI, so it
	// survives the window closing and can move between devices.
	var sink session.LogSink
	if ctrl != nil {
		sink = control.NewSink(ctrl, log)
	}
	deps.Session = session.NewHub(nil, session.DefaultSettings(), sink)

	/*
	 * Pick the listener up where they left off.
	 *
	 * Restored before the server starts listening, so the first client to
	 * connect receives the restored queue in its very first projection and
	 * never renders an empty player that then fills in.
	 *
	 * Paused, always — see internal/session/resume.go.
	 */
	var keeper *session.Keeper
	if ctrl != nil {
		keeper = &session.Keeper{Store: ctrl, UserID: control.DefaultUserID, Log: log}
		if snap := session.LoadSnapshot(context.Background(), ctrl, control.DefaultUserID); snap != nil {
			deps.Session.Restore(snap)
			log.Info("resumed where you left off",
				"track", snap.Tracks[snap.Index].Title,
				"at", time.Duration(snap.PositionMs)*time.Millisecond,
				"queued", len(snap.Tracks))
		}
	}

	deps.Resume = keeper

	/*
	 * Telling YouTube what was played.
	 *
	 * Off unless asked for, and the only thing in this program that writes to
	 * the account: it is what buys watch history, recommendations, and
	 * picking a track back up on another device — and it is also the one
	 * thing that stops Spotifier being invisible.
	 */
	if client := acct.Current().Client; client != nil {
		deps.Report = &report.Reporter{Client: client, Log: log}
	}

	apiServer := api.New(deps)
	srv := &http.Server{
		Addr:              *addr,
		Handler:           apiServer,
		ReadHeaderTimeout: 10 * time.Second,
	}

	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Error("listen", "err", err)
		os.Exit(1)
	}
	defer listener.Close()

	log.Info("spotifier listening",
		"addr", *addr,
		"catalog", *catalogMode,
		"resolver", deps.Resolver.Name(),
		"signedIn", acct.SignedIn(),
	)
	if credErr != nil {
		log.Warn("no credentials; identity routes disabled", "err", credErr)
	}

	// Shut down cleanly so the desktop shell never leaves an orphaned sidecar.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen", "err", err)
			os.Exit(1)
		}
	}()

	// Reports playback upstream while it is switched on. Subscribed like any
	// other consumer, so neither the Hub nor the reporter knows about the
	// other — main is the only place that knows both exist.
	if deps.Report != nil {
		go watchAndReport(ctx, deps.Session, deps.Report, log)
	}
	if deps.Audio != nil {
		go prefetchQueue(ctx, deps.Session, apiServer)
	}
	// Keeps the queue from running out, from YouTube's own radio.
	go apiServer.RunAutoplay(ctx)

	// Records where the listener is as they go, and once more on the way out.
	// That last write is the one that matters: it captures the position at
	// the moment of closing, which is the one anybody would notice being
	// wrong.
	if keeper != nil {
		saved := make(chan struct{})
		go func() {
			keeper.Run(ctx, deps.Session)
			close(saved)
		}()
		defer func() { <-saved }()
	}

	<-ctx.Done()
	log.Info("shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
}

func innertubeClient(creds *innertube.Credentials) *innertube.Client {
	opts := []innertube.Option{innertube.WithLocale("en", "US")}
	if creds != nil {
		opts = append(opts, innertube.WithCredentials(creds))
	}
	return innertube.New(opts...)
}

func mustFixture(dir string, rec *obs.Recorder, log *slog.Logger) catalog.Catalog {
	f := catalog.NewFixture(dir, rec)
	names, err := f.Available()
	if err != nil {
		fmt.Fprintf(os.Stderr, "fixture mode needs recordings: %v\n(run: go run ./cmd/record)\n", err)
		os.Exit(1)
	}
	log.Info("fixture catalog", "recordings", len(names))
	return f
}

/*
buildResolver picks the stream resolver and prepares what it needs.

"auto" prefers yt-dlp when the binary is present and falls back to the pure-Go
library otherwise, so a machine without yt-dlp still plays standard tiers
rather than failing to start.

Cookies reach yt-dlp as a file because that is the only form it takes. It is a
live session in plain text, so it goes to a per-process temporary directory
that is removed on exit, never beside the binary or into the project.
*/
func buildResolver(mode, ytdlpBin, denoBin, credPath string, creds *innertube.Credentials, log *slog.Logger) resolver.Resolver {
	library := resolver.NewLibrary()
	if mode == "library" {
		return library
	}

	/*
	 * yt-dlp reads cookies from a file, so the session is exported to one.
	 *
	 * It lives beside credentials.json under one fixed name, overwritten on
	 * every start. It used to go in a fresh folder in the system temp
	 * directory, removed on a clean exit — but a process that is killed never
	 * exits cleanly, and every such run left another plain-text copy of a live
	 * session behind: over a hundred had accumulated. Next to the credentials
	 * it is the same secret in the same protected place, and there is only
	 * ever one.
	 */
	removeLegacyCookieDirs(log)
	cookiePath := ""
	if creds != nil && credPath != "" {
		path := filepath.Join(filepath.Dir(credPath), "yt-dlp-cookies.txt")
		if n, err := innertube.WriteCookieFile(creds, path); err != nil {
			log.Warn("could not export cookies for yt-dlp; it will resolve anonymously", "err", err)
		} else {
			cookiePath = path
			log.Debug("exported cookies for yt-dlp", "count", n)
		}
	}

	yt := resolver.NewYtdlp(ytdlpBin, cookiePath)
	yt.Deno = denoBin
	if denoBin == "" {
		log.Warn("no JavaScript runtime given to yt-dlp; playback works only if deno is on PATH")
	} else {
		log.Info("yt-dlp will solve player challenges with deno", "path", denoBin)
	}
	if mode == "ytdlp" {
		return resolver.NewChain(yt, nil, log)
	}
	if !yt.Available() {
		log.Info("yt-dlp not found; using the pure-Go resolver (standard tiers only)")
		return library
	}
	return resolver.NewChain(yt, library, log)
}

/*
watchAndReport pings YouTube as the listener plays.

Projections say what is playing and where; this turns that into the cadence
YouTube's own players use. The position is read from the projection rather
than interpolated, so a paused player reports the same figure and the reporter
drops it — pausing stops the reporting without needing to be told.
*/
func watchAndReport(ctx context.Context, hub *session.Hub, rep *report.Reporter, log *slog.Logger) {
	updates, cancel := hub.Subscribe()
	defer cancel()

	tick := time.NewTicker(report.Interval)
	defer tick.Stop()

	var latest domain.Session
	for {
		select {
		case <-ctx.Done():
			return

		case p, ok := <-updates:
			if !ok {
				return
			}
			latest = p.State
			// A track change needs its tracking URLs before anything can be
			// reported against it, so fetch them as soon as it changes.
			if !rep.Enabled() {
				continue
			}
			if t := current(latest); t != "" {
				if err := rep.Track(ctx, t); err != nil {
					log.Debug("report: could not prepare", "err", err)
				}
			}

		case <-tick.C:
			if latest.State != domain.StatePlaying {
				continue
			}
			if t := current(latest); t != "" {
				rep.Progress(ctx, t, latest.PositionMs)
			}
		}
	}
}

// current is the Track the session is on, or "" when the queue is empty.
/*
prefetchQueue keeps what is about to play on disk.

Spotify starts downloading the next track while the current one is still
playing, and YouTube Music preloads the next track's player. This does both
for the playing track and the three after it, so a skip, a crossfade or the
queue simply moving on never waits for a resolution. The session restored at
launch comes through here too, so pressing play after opening the app is
immediate.
*/
func prefetchQueue(ctx context.Context, hub *session.Hub, srv *api.Server) {
	updates, cancel := hub.Subscribe()
	defer cancel()

	// Every projection would otherwise re-ask; only a change in what is
	// coming up is worth acting on.
	last := ""
	handle := func(s domain.Session) {
		items, at := s.Queue.Items, s.Queue.Index
		if at < 0 || at >= len(items) {
			return
		}
		ids := make([]string, 0, 4)
		for i := at; i < len(items) && len(ids) < 4; i++ {
			ids = append(ids, items[i].ID)
		}
		key := strings.Join(ids, ",")
		if key == last {
			return
		}
		last = key
		srv.PrefetchQueue(ids)
	}
	handle(hub.Projection().State)
	for {
		select {
		case <-ctx.Done():
			return
		case p, ok := <-updates:
			if !ok {
				return
			}
			handle(p.State)
		}
	}
}

func current(s domain.Session) string {
	if s.Queue.Index < 0 || s.Queue.Index >= len(s.Queue.Items) {
		return ""
	}
	return s.Queue.Items[s.Queue.Index].ID
}

// removeLegacyCookieDirs deletes the per-run cookie folders earlier versions
// left in the system temp directory — each one a plain-text copy of a live
// session, left behind whenever the process was killed rather than exited.
func removeLegacyCookieDirs(log *slog.Logger) {
	matches, _ := filepath.Glob(filepath.Join(os.TempDir(), "spotifier-cookies-*"))
	removed := 0
	for _, dir := range matches {
		if err := os.RemoveAll(dir); err == nil {
			removed++
		}
	}
	if removed > 0 {
		log.Info("removed cookie copies left in temp by earlier versions", "count", removed)
	}
}
