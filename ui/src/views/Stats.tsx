import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageState, ShelfSkeleton } from "../components/States";
import { TrackTable } from "../components/TrackTable";
import { Shelf } from "../components/Shelf";
import { IconClose, IconPlay, IconSearch } from "../components/Icon";
import { artworkAtLeast } from "../lib/types";
import type { Artist, Artwork, Shelf as ShelfData, Track } from "../lib/types";
import { api } from "../lib/api";
import { apiUrl } from "../lib/base";
import { transport } from "../lib/playback";

/**
 * Your listening.
 *
 * Built entirely from the local Play log, which is why it can exist at all:
 * this is data we keep in full and have no reason to ration. Nothing here
 * comes from YouTube Music except the artists' photos, and nothing here is
 * available anywhere else.
 */

interface TrackStat {
  trackId: string;
  title: string;
  artist: string;
  artistId?: string;
  plays: number;
  totalMs: number;
  lastPlayedAt: string;
  artwork?: string;
}

interface ArtistStat {
  /** A channel ID, or the artist's name for plays recorded without one. */
  artistId: string;
  artist: string;
  plays: number;
  distinctTracks: number;
  totalMs: number;
  lastPlayedAt: string;
  artwork?: string;
}

interface AlbumStat {
  key: string;
  albumId?: string;
  album: string;
  artist: string;
  artistId?: string;
  plays: number;
  distinctTracks: number;
  totalMs: number;
  lastPlayedAt: string;
  artwork?: string;
}

interface Summary {
  plays: number;
  totalMs: number;
  distinctTracks: number;
  distinctArtists: number;
  distinctAlbums: number;
}

interface LookupResults {
  tracks: TrackStat[];
  artists: ArtistStat[];
  albums: AlbumStat[];
}

type Kind = "track" | "artist" | "album";

interface Detail {
  kind: Kind;
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  albumId?: string;
  artwork?: string;
  plays: number;
  plays30d: number;
  totalMs: number;
  distinctTracks: number;
  firstPlayedAt?: string;
  lastPlayedAt?: string;
  rank: number;
  months: { month: string; plays: number; totalMs: number }[];
  topTracks: TrackStat[];
}

/** What the detail panel is showing: enough to draw its header at once. */
interface Selection {
  kind: Kind;
  id: string;
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

/** A real YouTube channel, as opposed to a name standing in for one. */
function isChannelId(id: string | undefined): id is string {
  return Boolean(id && /^UC[\w-]{10,}$/.test(id));
}

function art(url: string | undefined): Artwork[] {
  return url ? [{ url, width: 226, height: 226 }] : [];
}

export function Stats() {
  const [days, setDays] = useState(30);
  const [selected, setSelected] = useState<Selection | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const stat = <T,>(path: string) => ({
    queryKey: ["stats", path, days],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      getJSON<T>(`/v1/me/stats/${path}${path.includes("?") ? "&" : "?"}days=${days}`, signal),
  });
  const summary = useQuery(stat<Summary>("summary"));
  const tracks = useQuery(stat<TrackStat[]>("tracks?limit=50"));
  const artists = useQuery(stat<ArtistStat[]>("artists?limit=20"));
  const albums = useQuery(stat<AlbumStat[]>("albums?limit=20"));
  const onRepeat = useQuery({
    queryKey: ["stats", "on-repeat"],
    queryFn: ({ signal }) => getJSON<TrackStat[]>(`/v1/me/stats/on-repeat?limit=20`, signal),
  });

  const open = (s: Selection) => {
    setSelected(s);
    // The panel sits near the top; a row far down the page opens it out of
    // sight, so bring it into view.
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

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
  const topTracks = (tracks.data ?? []).slice(0, 25);

  return (
    <div className="stats">
      <h1 className="stats__title">Your listening</h1>

      <div className="sidebar__chips stats__periods" role="group" aria-label="Time period">
        {PERIODS.map((p) => (
          <button key={p.days} className="chip" aria-pressed={days === p.days} onClick={() => setDays(p.days)}>
            {p.label}
          </button>
        ))}
      </div>

      {summary.data ? <SummaryTiles s={summary.data} /> : null}

      <Lookup onPick={open} />
      <div ref={detailRef}>
        {selected ? <DetailPanel selection={selected} onClose={() => setSelected(null)} onOpen={open} /> : null}
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
              <TrackTable tracks={onRepeat.data.map(toTrack)} origin="On repeat" />
            </section>
          ) : null}

          <TopArtists artists={artists.data ?? []} />

          <section className="shelf">
            <div className="shelf__header">
              <h2 className="shelf__title">Top tracks</h2>
              <button
                className="chip"
                onClick={() => transport.play(topTracks.map(toTrack), 0, "Your top tracks")}
              >
                Play all
              </button>
            </div>
            <TrackTable tracks={topTracks.map(toTrack)} origin="Your top tracks" />
          </section>

          <TopAlbums albums={albums.data ?? []} onOpen={(a) => open({ kind: "album", id: a.key })} />
        </>
      )}
    </div>
  );
}

/* ---------- summary ---------- */

function SummaryTiles({ s }: { s: Summary }) {
  const tiles = [
    { label: "Listening time", value: formatDuration(s.totalMs) },
    { label: "Plays", value: s.plays.toLocaleString() },
    { label: "Songs", value: s.distinctTracks.toLocaleString() },
    { label: "Artists", value: s.distinctArtists.toLocaleString() },
    { label: "Albums", value: s.distinctAlbums.toLocaleString() },
  ];
  return (
    <dl className="stattiles">
      {tiles.map((t) => (
        <div key={t.label} className="stattile">
          <dt className="stattile__label">{t.label}</dt>
          <dd className="stattile__value">{t.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------- top artists ---------- */

/*
 * Artists as cards with their photos.
 *
 * The play log has no artist photos, so each is looked up — under the same
 * query key the artist page uses, which makes opening one afterwards instant.
 * Until a photo arrives, and for an artist that has none, the card shows the
 * cover of one of their songs rather than an empty circle.
 */
function TopArtists({ artists }: { artists: ArtistStat[] }) {
  const lookups = useQueries({
    queries: artists.slice(0, 12).map((a) => ({
      queryKey: ["artist", a.artistId],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.artist(a.artistId, signal),
      enabled: isChannelId(a.artistId),
      staleTime: Infinity,
      retry: 0,
    })),
  });

  const shelf: ShelfData = {
    title: "Top artists",
    items: artists.flatMap((a, i) => {
      if (!isChannelId(a.artistId)) return [];
      const found = lookups[i]?.data;
      const artist: Artist = {
        id: a.artistId,
        name: a.artist,
        artwork: found?.artwork?.length ? found.artwork : art(a.artwork),
        // The card's subtitle slot; here it carries your figures.
        subscribers: `${plural(a.plays, "play")} · ${formatDuration(a.totalMs)}`,
      };
      return [{ kind: "artist" as const, artist }];
    }),
  };

  if (shelf.items.length === 0) return null;
  return <Shelf shelf={shelf} />;
}

/* ---------- top albums ---------- */

function TopAlbums({ albums, onOpen }: { albums: AlbumStat[]; onOpen: (a: AlbumStat) => void }) {
  return (
    <section className="shelf">
      <div className="shelf__header">
        <h2 className="shelf__title">Top albums</h2>
      </div>
      {albums.length === 0 ? (
        <p className="stats__note">
          Albums are counted from now on: plays from before this version did not record which album a song came from.
        </p>
      ) : (
        <div className="stattable" role="table" aria-label="Top albums">
          <div className="stattable__head" role="row">
            <span role="columnheader">#</span>
            <span role="columnheader">Album</span>
            <span role="columnheader" className="stattable__num">Plays</span>
            <span role="columnheader" className="stattable__num">Time</span>
          </div>
          {albums.map((a, i) => (
            <div
              key={a.key}
              className="stattable__row"
              role="row"
              tabIndex={0}
              onClick={() => onOpen(a)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(a);
                }
              }}
            >
              <span className="stattable__rank">{i + 1}</span>
              <span className="stattable__main">
                {a.artwork ? <img className="stattable__art" src={a.artwork} alt="" loading="lazy" /> : <span className="stattable__art" />}
                <span className="stattable__text">
                  <span className="stattable__name truncate">
                    {a.albumId ? (
                      <Link to={`/album/${encodeURIComponent(a.albumId)}`} onClick={(e) => e.stopPropagation()}>
                        {a.album}
                      </Link>
                    ) : (
                      a.album
                    )}
                  </span>
                  <span className="stattable__sub truncate">
                    {isChannelId(a.artistId) ? (
                      <Link to={`/artist/${encodeURIComponent(a.artistId)}`} onClick={(e) => e.stopPropagation()}>
                        {a.artist}
                      </Link>
                    ) : (
                      a.artist
                    )}
                    {` · ${plural(a.distinctTracks, "song")}`}
                  </span>
                </span>
              </span>
              <span className="stattable__num">{a.plays}</span>
              <span className="stattable__num">{formatDuration(a.totalMs)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------- lookup ---------- */

/*
 * Look up any artist, song or album you have played.
 *
 * The search is over your own history, not YouTube's catalogue: it answers
 * "how much have I listened to this", so something never played is simply
 * not found rather than shown with a row of zeros.
 */
function Lookup({ onPick }: { onPick: (s: Selection) => void }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Wait for a pause in typing rather than asking on every keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(text.trim()), 200);
    return () => window.clearTimeout(id);
  }, [text]);

  // Clicking anywhere else closes the results.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const results = useQuery({
    queryKey: ["stats", "lookup", query],
    queryFn: ({ signal }) => getJSON<LookupResults>(`/v1/me/stats/lookup?q=${encodeURIComponent(query)}&limit=6`, signal),
    enabled: query.length > 0,
  });

  const pick = (s: Selection) => {
    onPick(s);
    setOpen(false);
  };

  const r = results.data;
  const empty = r && r.tracks.length + r.artists.length + r.albums.length === 0;

  return (
    <div className="statlookup" ref={boxRef}>
      <label className="searchfield statlookup__field">
        <IconSearch size={18} />
        <span className="sr-only">Look up an artist, song or album in your listening</span>
        <input
          type="search"
          placeholder="Look up an artist, song or album you've played"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        />
      </label>

      {open && query && r ? (
        <div className="statlookup__results" role="listbox" aria-label="Matches in your listening">
          {empty ? <p className="statlookup__empty">Nothing you've played matches "{query}".</p> : null}
          <LookupGroup
            title="Artists"
            items={r.artists.map((a) => ({
              key: a.artistId,
              title: a.artist,
              sub: `${plural(a.plays, "play")} · ${plural(a.distinctTracks, "song")}`,
              artwork: a.artwork,
              round: true,
              pick: () => pick({ kind: "artist", id: a.artistId }),
            }))}
          />
          <LookupGroup
            title="Songs"
            items={r.tracks.map((t) => ({
              key: t.trackId,
              title: t.title,
              sub: `${t.artist} · ${plural(t.plays, "play")}`,
              artwork: t.artwork,
              pick: () => pick({ kind: "track", id: t.trackId }),
            }))}
          />
          <LookupGroup
            title="Albums"
            items={r.albums.map((a) => ({
              key: a.key,
              title: a.album,
              sub: `${a.artist} · ${plural(a.plays, "play")}`,
              artwork: a.artwork,
              pick: () => pick({ kind: "album", id: a.key }),
            }))}
          />
        </div>
      ) : null}
    </div>
  );
}

function LookupGroup({
  title,
  items,
}: {
  title: string;
  items: { key: string; title: string; sub: string; artwork?: string; round?: boolean; pick: () => void }[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="statlookup__group">
      <h3 className="statlookup__grouptitle">{title}</h3>
      {items.map((it) => (
        <button key={it.key} className="statlookup__item" role="option" aria-selected={false} onClick={it.pick}>
          {it.artwork ? (
            <img className={`statlookup__art${it.round ? " statlookup__art--round" : ""}`} src={it.artwork} alt="" loading="lazy" />
          ) : (
            <span className={`statlookup__art${it.round ? " statlookup__art--round" : ""}`} />
          )}
          <span className="statlookup__text">
            <span className="truncate">{it.title}</span>
            <span className="statlookup__sub truncate">{it.sub}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ---------- detail ---------- */

const KIND_LABEL: Record<Kind, string> = { track: "Song", artist: "Artist", album: "Album" };
const RANK_OF: Record<Kind, string> = { track: "songs", artist: "artists", album: "albums" };

function DetailPanel({
  selection,
  onClose,
  onOpen,
}: {
  selection: Selection;
  onClose: () => void;
  onOpen: (s: Selection) => void;
}) {
  const { data, isPending, error } = useQuery({
    queryKey: ["stats", "detail", selection.kind, selection.id],
    queryFn: ({ signal }) =>
      getJSON<Detail>(`/v1/me/stats/detail?kind=${selection.kind}&id=${encodeURIComponent(selection.id)}`, signal),
  });
  // The artist's own photo, when this is an artist with a channel.
  const photo = useQuery({
    queryKey: ["artist", selection.id],
    queryFn: ({ signal }) => api.artist(selection.id, signal),
    enabled: selection.kind === "artist" && isChannelId(selection.id),
    staleTime: Infinity,
    retry: 0,
  });

  if (isPending) return <section className="statdetail statdetail--loading" aria-busy="true" />;
  if (error || !data || data.plays === 0) {
    return (
      <section className="statdetail">
        <button className="iconbtn statdetail__close" aria-label="Close" onClick={onClose}>
          <IconClose size={18} />
        </button>
        <p className="stats__note">No plays of this in your history.</p>
      </section>
    );
  }

  const cover =
    selection.kind === "artist" && photo.data?.artwork?.length ? artworkAtLeast(photo.data.artwork, 300) : data.artwork;
  const round = data.kind === "artist";
  const tracks = data.topTracks.map(toTrack);

  const play = () => {
    if (data.kind === "track") {
      transport.play([toTrack({ ...data, trackId: data.id, title: data.name, artist: data.artist ?? "", lastPlayedAt: "" })], 0, "Your listening");
    } else if (tracks.length > 0) {
      transport.play(tracks, 0, `Your top songs: ${data.name}`);
    }
  };

  const pageLink =
    data.kind === "artist" && isChannelId(data.id)
      ? `/artist/${encodeURIComponent(data.id)}`
      : data.kind === "album" && data.albumId
        ? `/album/${encodeURIComponent(data.albumId)}`
        : null;

  const tiles = [
    { label: "Plays", value: data.plays.toLocaleString() },
    { label: "Listening time", value: formatDuration(data.totalMs) },
    { label: "Last 30 days", value: plural(data.plays30d, "play") },
    { label: `Among your ${RANK_OF[data.kind]}`, value: `#${data.rank}` },
    ...(data.kind !== "track" ? [{ label: "Songs played", value: data.distinctTracks.toLocaleString() }] : []),
  ];

  return (
    <section className="statdetail" aria-label={`Your listening: ${data.name}`}>
      <button className="iconbtn statdetail__close" aria-label="Close" onClick={onClose}>
        <IconClose size={18} />
      </button>

      <header className="statdetail__header">
        {cover ? (
          <img className={`statdetail__art${round ? " statdetail__art--round" : ""}`} src={cover} alt="" />
        ) : (
          <span className={`statdetail__art${round ? " statdetail__art--round" : ""}`} />
        )}
        <div className="statdetail__heading">
          <span className="statdetail__kind">{KIND_LABEL[data.kind]}</span>
          <h2 className="statdetail__name">{pageLink ? <Link to={pageLink}>{data.name}</Link> : data.name}</h2>
          {data.kind !== "artist" && data.artist ? (
            <span className="statdetail__sub">
              {isChannelId(data.artistId) ? (
                <button className="linkbtn" onClick={() => onOpen({ kind: "artist", id: data.artistId! })}>
                  {data.artist}
                </button>
              ) : (
                data.artist
              )}
            </span>
          ) : null}
          <span className="statdetail__dates">
            {data.firstPlayedAt ? `First played ${formatDate(data.firstPlayedAt)}` : null}
            {data.lastPlayedAt ? ` · Last played ${formatDate(data.lastPlayedAt)}` : null}
          </span>
        </div>
        <button className="playbtn playbtn--accent statdetail__play" aria-label={`Play ${data.name}`} onClick={play}>
          <IconPlay size={20} />
        </button>
      </header>

      <dl className="stattiles stattiles--compact">
        {tiles.map((t) => (
          <div key={t.label} className="stattile">
            <dt className="stattile__label">{t.label}</dt>
            <dd className="stattile__value">{t.value}</dd>
          </div>
        ))}
      </dl>

      <MonthsChart months={data.months} />

      {tracks.length > 0 ? (
        <>
          <h3 className="statdetail__subtitle">Your most-played songs</h3>
          <TrackTable tracks={tracks} origin={`Your top songs: ${data.name}`} />
        </>
      ) : null}
    </section>
  );
}

/*
 * Plays per month over the last year.
 *
 * One series, so no legend: the heading names it. Bars in the accent, thin,
 * rounded at the data end and sitting on a shared baseline; each has its own
 * hover target the full height of the plot, and the figures are also in the
 * accessible label so the chart is never the only way to read them.
 */
function MonthsChart({ months }: { months: Detail["months"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...months.map((m) => m.plays));
  const label = (m: Detail["months"][number]) =>
    new Date(`${m.month}-01T00:00:00`).toLocaleDateString(undefined, { month: "short" });
  const summary = months.map((m) => `${label(m)} ${m.plays}`).join(", ");

  return (
    <figure className="monthchart">
      <figcaption className="statdetail__subtitle">Plays per month</figcaption>
      <div className="monthchart__plot" role="img" aria-label={`Plays per month: ${summary}`}>
        {months.map((m, i) => (
          <div
            key={m.month}
            className="monthchart__col"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            {hover === i ? (
              <span className="monthchart__tip" role="tooltip">
                <strong>{m.plays}</strong> {m.plays === 1 ? "play" : "plays"} · {formatDuration(m.totalMs)}
                <br />
                {new Date(`${m.month}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}
              </span>
            ) : null}
            <span
              className="monthchart__bar"
              data-active={hover === i || undefined}
              style={{ height: m.plays ? `${Math.max(4, (m.plays / max) * 100)}%` : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="monthchart__axis" aria-hidden="true">
        {months.map((m) => (
          <span key={m.month}>{label(m)}</span>
        ))}
      </div>
    </figure>
  );
}

/* ---------- helpers ---------- */

/** Adapts a statistics row into the shape the shared track table renders. */
function toTrack(s: TrackStat): Track {
  return {
    id: s.trackId,
    title: s.title,
    artists: [{ id: isChannelId(s.artistId) ? s.artistId : undefined, name: s.artist }],
    // No duration: the table's last column then shows the play count.
    durationMs: 0,
    playCount: String(s.plays),
    listenedMs: s.totalMs,
    artwork: art(s.artwork),
    explicit: false,
    isVideo: false,
    playable: true,
  };
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${n === 1 ? word : `${word}s`}`;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 100 ? `${hours.toFixed(1)} hrs` : `${Math.round(hours).toLocaleString()} hrs`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
