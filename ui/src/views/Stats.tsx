import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageState, ShelfSkeleton } from "../components/States";
import { TrackTable } from "../components/TrackTable";
import { artworkAtLeast } from "../lib/types";
import type { Track } from "../lib/types";
import { apiUrl } from "../lib/base";

/**
 * Your listening.
 *
 * Built entirely from the local Play log, which is why it can exist at all:
 * this is data we keep in full and have no reason to ration. Nothing here
 * comes from YouTube Music, and nothing here is available anywhere else.
 */

interface TrackStat {
  trackId: string;
  title: string;
  artist: string;
  artistId?: string;
  plays: number;
  totalMs: number;
  lastPlayedAt: string;
}

interface ArtistStat {
  artistId: string;
  artist: string;
  plays: number;
  distinctTracks: number;
  totalMs: number;
  lastPlayedAt: string;
}

const PERIODS = [
  { days: 7, label: "Last week" },
  { days: 30, label: "Last month" },
  { days: 365, label: "Last year" },
  { days: 3650, label: "All time" },
];

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiUrl(url), { signal });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json() as Promise<T>;
}

export function Stats() {
  const [days, setDays] = useState(30);

  const tracks = useQuery({
    queryKey: ["stats", "tracks", days],
    queryFn: ({ signal }) => getJSON<TrackStat[]>(`/v1/me/stats/tracks?days=${days}&limit=50`, signal),
  });
  const artists = useQuery({
    queryKey: ["stats", "artists", days],
    queryFn: ({ signal }) => getJSON<ArtistStat[]>(`/v1/me/stats/artists?days=${days}&limit=20`, signal),
  });
  const onRepeat = useQuery({
    queryKey: ["stats", "on-repeat"],
    queryFn: ({ signal }) => getJSON<TrackStat[]>(`/v1/me/stats/on-repeat?limit=20`, signal),
  });

  const loading = tracks.isPending || artists.isPending;
  const failed = tracks.error || artists.error;

  if (loading) {
    return (
      <div aria-busy="true">
        <ShelfSkeleton />
        <ShelfSkeleton />
      </div>
    );
  }
  if (failed) {
    return (
      <PageState
        title="Statistics unavailable"
        body="The local history database could not be read."
        action={{ label: "Try again", onClick: () => void tracks.refetch() }}
      />
    );
  }

  const hasHistory = (tracks.data?.length ?? 0) > 0;

  return (
    <>
      <h1 className="entityheader__title" style={{ margin: "var(--space-6) 0 var(--space-4)", fontSize: "var(--text-2xl)" }}>
        Your listening
      </h1>

      <div className="sidebar__chips" style={{ padding: 0, marginBottom: "var(--space-5)" }} role="group" aria-label="Time period">
        {PERIODS.map((p) => (
          <button
            key={p.days}
            className="chip"
            aria-pressed={days === p.days}
            onClick={() => setDays(p.days)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {!hasHistory ? (
        /* An empty history is expected on a fresh install rather than an
           error, and it says what will fill it. */
        <PageState
          title="Nothing tracked yet"
          body="Play something and it will show up here. Your listening history stays on this machine."
        />
      ) : (
        <>
          {onRepeat.data && onRepeat.data.length > 0 ? (
            <section className="shelf">
              <div className="shelf__header">
                <h2 className="shelf__title">On repeat</h2>
                <span className="shelf__showall">LAST 30 DAYS</span>
              </div>
              <TrackTable tracks={onRepeat.data.map(toTrack)} origin="On repeat" showArtwork={false} />
            </section>
          ) : null}

          <section className="shelf">
            <div className="shelf__header">
              <h2 className="shelf__title">Top artists</h2>
            </div>
            <ol className="statlist">
              {(artists.data ?? []).map((a, i) => (
                <li key={a.artistId || a.artist} className="statrow">
                  <span className="statrow__rank">{i + 1}</span>
                  <span className="statrow__main">
                    {a.artistId ? (
                      <Link to={`/artist/${encodeURIComponent(a.artistId)}`}>{a.artist}</Link>
                    ) : (
                      a.artist
                    )}
                  </span>
                  <span className="statrow__meta">
                    {a.plays} {a.plays === 1 ? "play" : "plays"}
                    {" · "}
                    {a.distinctTracks} {a.distinctTracks === 1 ? "track" : "tracks"}
                  </span>
                  <span className="statrow__meta">{formatHours(a.totalMs)}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="shelf">
            <div className="shelf__header">
              <h2 className="shelf__title">Top tracks</h2>
            </div>
            <ol className="statlist">
              {(tracks.data ?? []).slice(0, 25).map((t, i) => (
                <li key={t.trackId} className="statrow">
                  <span className="statrow__rank">{i + 1}</span>
                  <span className="statrow__main">
                    <span className="trackrow__title">{t.title}</span>
                    <span className="trackrow__artist"> {t.artist}</span>
                  </span>
                  <span className="statrow__meta">
                    {t.plays} {t.plays === 1 ? "play" : "plays"}
                  </span>
                  <span className="statrow__meta">{formatHours(t.totalMs)}</span>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </>
  );
}

/** Adapts a statistics row into the shape the shared track table renders. */
function toTrack(s: TrackStat): Track {
  return {
    id: s.trackId,
    title: s.title,
    artists: [{ id: s.artistId, name: s.artist }],
    durationMs: 0,
    artwork: [],
    explicit: false,
    isVideo: false,
    playable: true,
  };
}

function formatHours(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)} hrs`;
}

export { artworkAtLeast };
