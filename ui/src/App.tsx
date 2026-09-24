import { VideoSurface, VideoNotice } from "./components/VideoPlayer";
import { usePlayer } from "./lib/player";
import { useVideo, setVideoEnabled, checkVideoAvailability } from "./lib/video";
import { useEffect, useRef, useState } from "react";
import { PageBoundary } from "./components/PageBoundary";
import { Toast } from "./components/Toast";
import { UpdateNotice } from "./components/UpdateNotice";
import { Tooltips } from "./components/Tooltip";
import { Route, Routes, useLocation } from "react-router-dom";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { TopBar } from "./components/TopBar";
import { QueuePanel } from "./components/QueuePanel";
import { Home } from "./views/Home";
import { lazy, Suspense } from "react";

/**
 * Routes beyond Home are split out.
 *
 * Home and the shell are the first paint and load eagerly; Settings, Stats and
 * the entity pages are only fetched when navigated to, which keeps the startup
 * bundle to what is actually rendered on launch.
 */
const Together = lazy(() => import("./views/Together").then((m) => ({ default: m.Together })));
const Search = lazy(() => import("./views/Search").then((m) => ({ default: m.Search })));
const Stats = lazy(() => import("./views/Stats").then((m) => ({ default: m.Stats })));
const SettingsView = lazy(() => import("./views/Settings").then((m) => ({ default: m.SettingsView })));
const Changelog = lazy(() => import("./views/Changelog").then((m) => ({ default: m.Changelog })));
const AlbumView = lazy(() => import("./views/Entities").then((m) => ({ default: m.AlbumView })));
const MixView = lazy(() => import("./views/Mix").then((m) => ({ default: m.MixView })));
const ArtistView = lazy(() => import("./views/Entities").then((m) => ({ default: m.ArtistView })));
const Browse = lazy(() => import("./views/Entities").then((m) => ({ default: m.Browse })));
const PlaylistView = lazy(() => import("./views/Entities").then((m) => ({ default: m.PlaylistView })));
const PodcastView = lazy(() => import("./views/Entities").then((m) => ({ default: m.PodcastView })));
import { PageState, TrackListSkeleton } from "./components/States";
import { Announcer, SkipLink } from "./components/Announcer";
import { applyPlaybackSettings, installAudioDebug, startPlayback, stopPlayback } from "./lib/playback";
import { installMediaSession } from "./lib/mediasession";
import { TrayBridge } from "./components/TrayBridge";
import { MiniPlayerHost } from "./components/MiniPlayer";
import { useSettings, applyDocumentSettings } from "./lib/settings";
import { PlaybackNotice } from "./components/PlaybackNotice";
import { FullScreenPlayer } from "./components/FullScreenPlayer";
import { LyricsPanel, LyricsView } from "./components/Lyrics";
import { MenuProvider } from "./components/ContextMenu";
import { PromptProvider } from "./components/Prompt";
import { Shortcuts } from "./components/Shortcuts";
import { leaveTogether } from "./lib/together";

/**
 * The shell: library rail, scrolling content, optional right panel, and the
 * transport bar. Each region scrolls independently so the page itself never
 * does and the bar is always reachable.
 */
export function App() {
  const videoEnabled = useVideo(s => s.enabled);
  const videoTrackID = usePlayer(s => s.track?.id);
  useEffect(() => {
    void checkVideoAvailability();
    if (useVideo.getState().enabled && videoTrackID) void setVideoEnabled(true);
    if (!videoTrackID) useVideo.setState({ enabled: false, error: null });
  }, [videoTrackID]);
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [libraryExpanded, setLibraryExpanded] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  // One side panel at a time: they occupy the same column, and showing both
  // would leave nothing for the content.
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsFull, setLyricsFull] = useState(false);

  /*
   * Keep the core and the audio graph in step with the settings screen.
   *
   * Subscribing here rather than in Settings means a change applies whether
   * or not that screen is mounted, and it re-applies after a reconnect —
   * the core forgets nothing, but a restarted core starts from its defaults.
   */
  const crossfadeMs = useSettings((s) => s.crossfadeMs);
  const gapless = useSettings((s) => s.gapless);
  const normalization = useSettings((s) => s.normalization);
  const normalizationLevel = useSettings((s) => s.normalizationLevel);
  const resumeOnLaunch = useSettings((s) => s.resumeOnLaunch);
  const reportToYouTube = useSettings((s) => s.reportToYouTube);
  const eq = useSettings((s) => s.eq);
  const cacheMaxMB = useSettings((s) => s.cacheMaxMB);
  const autoplay = useSettings((s) => s.autoplay);
  useEffect(() => {
    void applyPlaybackSettings({
      crossfadeMs,
      gapless,
      normalization,
      normalizationLevel,
      resumeOnLaunch,
      reportToYouTube,
      cacheMaxMB,
      autoplay,
      eq,
    });
    installAudioDebug();
  }, [crossfadeMs, gapless, normalization, normalizationLevel, resumeOnLaunch, reportToYouTube, cacheMaxMB, autoplay, eq]);

  const settings = useSettings();

  useEffect(() => {
    startPlayback();
    // Hand the OS its now-playing surface: the Windows overlay, the media
    // keys, and the lock-screen controls all read from this.
    const removeMediaSession = installMediaSession();
    return () => {
      removeMediaSession();
      void leaveTogether();
      stopPlayback();
    };
  }, []);

  // Shortcuts are installed by a component inside the providers, because
  // several of them need a prompt and a mutation that only exist there.

  useEffect(() => {
    applyDocumentSettings(settings);
  }, [settings]);

  return (
    <PromptProvider>
    <MenuProvider>
    <div className="app-shell" data-platform={window.spotifier?.platform} data-library-expanded={libraryExpanded || undefined} data-nowplaying={queueOpen || lyricsOpen || undefined}>
      <SkipLink />
      <Announcer />
      {/* One listener for every icon-only control in the app. */}
      <Tooltips />
      <Toast />
      <UpdateNotice />
      {/* The desktop tray, flyout and taskbar buttons. */}
      <TrayBridge />
      {/* Draws into the mini player's own window while it is open. */}
      <MiniPlayerHost />
      <Shortcuts
        onToggleQueue={() => {
          setQueueOpen((q) => !q);
          setLyricsOpen(false);
        }}
        onToggleLyrics={() => {
          setLyricsOpen((l) => !l);
          setQueueOpen(false);
        }}
        onToggleFullScreen={() => setFullScreen((f) => !f)}
      />
      <PlaybackNotice />
      <TopBar scrollRef={scrollRef} onNavigate={() => setLibraryExpanded(false)} />
      <LibrarySidebar expanded={libraryExpanded} onExpand={() => setLibraryExpanded(v => !v)} onNavigate={() => setLibraryExpanded(false)} />

      <main className="main panel">
        <VideoNotice />
        {videoEnabled && !fullScreen ? <VideoSurface className="main-video" onExpand={() => setFullScreen(true)} /> : null}
        <div className="main__scroll scroll" ref={scrollRef}>
          <div className="main__content" id="main-content" tabIndex={-1}>
            <PageBoundary key={location.pathname}>
            <Suspense fallback={<TrackListSkeleton />}>
            <Routes>
              <Route path="/together" element={<Together />} />
              <Route path="/" element={<Home />} />
              <Route path="/search" element={<Search />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/settings" element={<SettingsView />} />
              <Route path="/changelog" element={<Changelog />} />
              <Route path="/browse/:surface" element={<Browse />} />
              <Route path="/album/:id" element={<AlbumView />} />
              <Route path="/mix/:id" element={<MixView />} />
              <Route path="/artist/:id" element={<ArtistView />} />
              <Route path="/playlist/:id" element={<PlaylistView />} />
              <Route path="/podcast/:id" element={<PodcastView />} />
              <Route
                path="*"
                element={<PageState title="Not found" body="That page does not exist." />}
              />
            </Routes>
            </Suspense>
            </PageBoundary>
          </div>
        </div>
      </main>

      {queueOpen ? <QueuePanel onClose={() => setQueueOpen(false)} /> : null}
      {lyricsOpen ? (
        <LyricsPanel
          onClose={() => setLyricsOpen(false)}
          onExpand={() => setLyricsFull(true)}
        />
      ) : null}
      {lyricsFull ? <LyricsView onClose={() => setLyricsFull(false)} /> : null}

      <NowPlayingBar
        queueOpen={queueOpen}
        onToggleQueue={() => {
          setQueueOpen((q) => !q);
          setLyricsOpen(false);
        }}
        onOpenFullScreen={() => setFullScreen(true)}
        lyricsOpen={lyricsOpen}
        onToggleLyrics={() => {
          setLyricsOpen((l) => !l);
          setQueueOpen(false);
        }}
      />
      {fullScreen ? <FullScreenPlayer onClose={() => setFullScreen(false)} /> : null}
    </div>
    </MenuProvider>
    </PromptProvider>
  );
}
