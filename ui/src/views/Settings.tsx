import { apiUrl } from "../lib/base";
import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { signInLabel, useSignIn } from "../lib/signin";
import { useSettings, applyDocumentSettings, type Settings as Prefs } from "../lib/settings";
import { SHORTCUTS, describeKeys } from "../lib/shortcuts";
import { engineCapabilities, engineName, transport } from "../lib/playback";
import { usePlayer } from "../lib/player";
import { desktop, type UpdateStatus } from "../lib/desktop";
import { pendingCount } from "../lib/playlog";
import { diagnostics } from "../lib/diagnostics";
import { Equaliser } from "../components/Equaliser";

/**
 * Settings.
 *
 * Controls are gated on what the running engine can actually do. Offering an
 * equaliser that silently does nothing is worse than not offering one, because
 * the user cannot tell the difference between a broken control and a broken
 * ear.
 */
export function SettingsView() {
  const prefs = useSettings();
  const caps = engineCapabilities();
  const [signedOut, setSignedOut] = useState(false);
  const { signingIn, signIn } = useSignIn();

  useEffect(() => {
    applyDocumentSettings(prefs);
  }, [prefs]);

  const canCrossfade = caps ? caps.crossfade !== "none" : true;
  const canNormalize = caps ? caps.normalization : true;

  return (
    <div className="settings">
      <h1 className="settings__title">Settings</h1>

      <Section title="Playback">
        <Row
          label="Crossfade"
          hint={
            canCrossfade
              ? "Overlap the end of one track with the start of the next."
              : "The current playback engine cannot crossfade."
          }
        >
          <div className="settings__inline">
            <input
              type="range"
              min={0}
              max={12}
              step={1}
              value={Math.round(prefs.crossfadeMs / 1000)}
              disabled={!canCrossfade}
              aria-label="Crossfade seconds"
              onChange={(e) => prefs.set("crossfadeMs", Number(e.target.value) * 1000)}
            />
            <span className="settings__value">
              {prefs.crossfadeMs === 0 ? "Off" : `${Math.round(prefs.crossfadeMs / 1000)}s`}
            </span>
          </div>
        </Row>

        <Toggle
          label="Gapless playback"
          hint="Start the next track without a pause between them."
          checked={prefs.gapless}
          onChange={(v) => prefs.set("gapless", v)}
        />

        <Toggle
          label="Volume normalization"
          hint={
            canNormalize
              ? "Even out loudness differences between tracks."
              : "Unavailable with the current playback engine."
          }
          checked={prefs.normalization && canNormalize}
          disabled={!canNormalize}
          onChange={(v) => prefs.set("normalization", v)}
        />

        {prefs.normalization && canNormalize ? (
          <Row
            label="Volume level"
            hint="Louder settings leave less headroom, so dynamic tracks have less room to breathe."
          >
            <select
              className="settings__select"
              value={prefs.normalizationLevel}
              aria-label="Volume level"
              onChange={(e) =>
                prefs.set("normalizationLevel", e.target.value as Prefs["normalizationLevel"])
              }
            >
              <option value="quiet">Quiet</option>
              <option value="normal">Normal</option>
              <option value="loud">Loud</option>
            </select>
          </Row>
        ) : null}

        <Toggle
          label="Autoplay"
          hint="When your queue runs low, keep playing similar songs from YouTube Music's radio."
          checked={prefs.autoplay}
          onChange={(v) => prefs.set("autoplay", v)}
        />

        <Toggle
          label="Volume boost"
          hint="Let the volume go up to 200% for quiet tracks. A limiter keeps it from distorting, but loud passages are flattened past 100%."
          checked={prefs.volumeBoost}
          onChange={(v) => {
            prefs.set("volumeBoost", v);
            // Turning it off brings a boosted level back to 100%.
            if (!v && usePlayer.getState().volume > 1) transport.setVolume(1);
          }}
        />

        <Row label="Playback engine" hint="Automatic picks the best available for your account.">
          <select
            className="settings__select"
            value={prefs.enginePreference}
            aria-label="Playback engine"
            onChange={(e) => prefs.set("enginePreference", e.target.value as Prefs["enginePreference"])}
          >
            <option value="auto">Automatic</option>
            <option value="native">Native (higher quality)</option>
            <option value="embedded">Embedded (most compatible)</option>
          </select>
        </Row>

        <Toggle
          label="Resume on launch"
          hint="Restore the last queue when the app starts."
          checked={prefs.resumeOnLaunch}
          onChange={(v) => prefs.set("resumeOnLaunch", v)}
        />

        {desktop.available && (
          <Toggle
            label="Close to tray"
            hint="The close button hides the window and the music keeps playing. Open it again, or quit, from the icon in the notification area."
            checked={prefs.closeToTray}
            onChange={(v) => prefs.set("closeToTray", v)}
          />
        )}

        {/* The only setting here that writes to the account, so it says so
            plainly rather than describing only the benefit. */}
        <Toggle
          label="Send listening to YouTube"
          hint="Counts plays towards your YouTube history and recommendations, and lets a track started on another device carry on here. This is the only setting that writes to your account — everything else only reads."
          checked={prefs.reportToYouTube}
          onChange={(v) => prefs.set("reportToYouTube", v)}
        />
      </Section>

      <Section title="Content">
        <Toggle
          label="Show music videos"
          hint="Off by default. This is an audio-first player; videos appear in their own shelves when enabled."
          checked={prefs.showMusicVideos}
          onChange={(v) => prefs.set("showMusicVideos", v)}
        />
        <Toggle
          label="Show audio quality badge"
          hint="Display the codec and bitrate of the current stream."
          checked={prefs.showQualityBadge}
          onChange={(v) => prefs.set("showQualityBadge", v)}
        />
      </Section>

      <Section title="Equaliser">
        <Equaliser />
      </Section>

      <Section title="Lyrics">
        <Toggle
          label="Timed lyrics"
          hint="Follow the words line by line. YouTube Music never returns timings, so these come from LRCLIB — the one service outside YouTube this app contacts. It receives the track title, artist and duration, nothing about you, and only while the lyrics view is open."
          checked={prefs.timedLyrics}
          onChange={(v) => prefs.set("timedLyrics", v)}
        />
      </Section>

      <Section title="Appearance">
        <Toggle
          label="Reduce motion"
          hint="Minimise animation. Your system setting is already respected; this forces it on."
          checked={prefs.reduceMotion}
          onChange={(v) => prefs.set("reduceMotion", v)}
        />
      </Section>

      <Section title="Account">
        <Row
          label="YouTube Music session"
          hint={
            desktop.available
              ? "Sign-in opens your browser on a separate, temporary profile, and the session is moved into this app."
              : "Sign-in requires the desktop app."
          }
        >
          <div className="settings__inline">
            <button
              className="chip"
              disabled={!desktop.available || signingIn}
              onClick={() => void signIn()}
            >
              {signInLabel(signingIn)}
            </button>
            <button
              className="chip"
              disabled={!desktop.available || signedOut}
              onClick={async () => {
                await desktop.signOut();
                setSignedOut(true);
              }}
            >
              {signedOut ? "Signed out" : "Sign out"}
            </button>
          </div>
        </Row>
      </Section>

      <Section title="Keyboard shortcuts">
        {["Playback", "Navigation", "Interface"].map((group) => (
          <div key={group} className="settings__shortcuts">
            <h3 className="settings__grouptitle">{group}</h3>
            {SHORTCUTS.filter((s) => s.group === group).map((s) => (
              <div key={s.id} className="settings__shortcut">
                <span>{s.label}</span>
                <kbd>{describeKeys(s.keys)}</kbd>
              </div>
            ))}
          </div>
        ))}
      </Section>

      <Section title="Storage">
        <Row
          label="Song cache"
          hint="Songs you play, and the ones about to play, are kept on disk so they start instantly. The least recently played are removed first."
        >
          <select
            className="settings__select"
            value={prefs.cacheMaxMB}
            aria-label="Song cache size"
            onChange={(e) => prefs.set("cacheMaxMB", Number(e.target.value))}
          >
            <option value={512}>512 MB</option>
            <option value={1024}>1 GB</option>
            <option value={2048}>2 GB</option>
            <option value={5120}>5 GB</option>
            <option value={10240}>10 GB</option>
          </select>
        </Row>
        <CacheUsage />
      </Section>

      <Section title="Diagnostics">
        {desktop.available && <AppVersion />}
        {diagnostics.available && <ProblemReport />}
        <Row label="Playback engine" hint="Which engine is currently producing sound.">
          <span className="settings__value">
            {engineName() === "native"
              ? "Native (Web Audio)"
              : engineName() === "embedded"
                ? "Embedded (fallback)"
                : "Not started"}
          </span>
        </Row>
        <Row label="Unsent listening events" hint="Queued locally and retried; nothing is lost offline.">
          <span className="settings__value">{pendingCount()}</span>
        </Row>
        <Row label="Reset preferences" hint="Restore every setting on this page to its default.">
          <button className="chip" onClick={() => prefs.reset()}>
            Reset
          </button>
        </Row>
      </Section>
    </div>
  );
}

/** Which release this is, a way to look for a newer one, and to take it. */
function AppVersion() {
  const [info, setInfo] = useState<{ version: string; update: UpdateStatus } | null>(null);
  const refresh = () => desktop.version().then(setInfo);
  useEffect(() => {
    void refresh();
  }, []);

  // While the updater is busy, follow it; it has no way to tell the page.
  const busy = info?.update.status === "checking" || info?.update.status === "downloading";
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  if (!info) return null;
  const u = info.update;
  const hint =
    u.status === "checking"
      ? "Checking for updates…"
      : u.status === "downloading"
        ? `Downloading ${u.version}… ${u.percent}%`
        : u.status === "ready"
          ? `Version ${u.version} is downloaded and installs when you quit.`
          : u.status === "none"
            ? "You're on the latest version."
            : u.status === "error"
              ? `Could not check for updates: ${u.error}`
              : u.status === "unavailable"
                ? "Updates are not available in a development build."
                : "Updates download in the background and install when you quit.";

  return (
    <Row label="Version" hint={hint}>
      <div className="settings__inline">
        <span className="settings__value">{info.version}</span>
        <Link className="chip" to="/changelog">
          What's new
        </Link>
        {u.status === "ready" ? (
          <button className="chip" onClick={() => desktop.installUpdate()}>
            Restart to update
          </button>
        ) : (
          <button
            className="chip"
            disabled={busy || u.status === "unavailable"}
            onClick={async () => {
              const update = await desktop.checkForUpdate();
              if (update) setInfo({ ...info, update });
            }}
          >
            {busy ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>
    </Row>
  );
}

/**
 * The one thing to do when something breaks: save the log and send it.
 *
 * The hint says what is in the file and what is not, because "send us your
 * logs" is only a reasonable ask when people can see it is safe to.
 */
function ProblemReport() {
  const [status, setStatus] = useState<"idle" | "working" | { path: string } | { error: string }>("idle");
  const hint =
    typeof status === "object"
      ? "path" in status
        ? `Saved to ${status.path}. Send that file along with what happened and roughly when.`
        : `Could not create the report: ${status.error}`
      : "Saves a zip to your Downloads folder with the app's log and a short system summary, for sending with a bug report. It lists the songs that played, but never your cookies, sign-in or email address.";
  return (
    <Row label="Problem report" hint={hint}>
      <div className="settings__inline">
        <button
          className="chip"
          disabled={status === "working"}
          onClick={async () => {
            setStatus("working");
            const res = await diagnostics.exportBundle();
            setStatus(res.ok && res.path ? { path: res.path } : { error: res.reason ?? "unknown error" });
          }}
        >
          {status === "working" ? "Saving…" : "Save report"}
        </button>
        <button className="chip" onClick={() => diagnostics.openFolder()}>
          Open log folder
        </button>
      </div>
    </Row>
  );
}

/** What the song cache holds, and a way to empty it. */
function CacheUsage() {
  const [usage, setUsage] = useState<{ bytes: number; tracks: number } | null>(null);
  const load = (method: "GET" | "DELETE" = "GET") =>
    fetch(apiUrl("/v1/cache"), { method })
      .then((r) => (r.ok ? r.json() : null))
      .then(setUsage)
      .catch(() => setUsage(null));
  useEffect(() => {
    void load();
  }, []);

  const mb = usage ? usage.bytes / (1 << 20) : 0;
  return (
    <Row
      label="Cached songs"
      hint={usage ? `${usage.tracks} songs, ${mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`}` : "Unavailable"}
    >
      <button className="chip" disabled={!usage || usage.tracks === 0} onClick={() => void load("DELETE")}>
        Clear
      </button>
    </Row>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="settings__section">
      <h2 className="settings__sectiontitle">{title}</h2>
      {children}
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings__row">
      <div className="settings__label">
        <span>{label}</span>
        {hint ? <span className="settings__hint">{hint}</span> : null}
      </div>
      <div className="settings__control">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <button
        className="switch"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__thumb" />
      </button>
    </Row>
  );
}
