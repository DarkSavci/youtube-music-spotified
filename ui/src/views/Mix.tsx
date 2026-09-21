import { useParams } from "react-router-dom";
import { useMixes } from "../lib/mixes";
import { transport } from "../lib/playback";
import { artworkAtLeast, formatDuration } from "../lib/types";
import { EntityHeader } from "../components/EntityHeader";
import { TrackTable } from "../components/TrackTable";
import { PageState, TrackListSkeleton } from "../components/States";
import { IconPlay } from "../components/Icon";

/**
 * A generated mix's own page: what is in it, before playing it.
 *
 * Like an album or a playlist, a click on a mix opens it, and only its play
 * button plays. It used to start playing the moment it was clicked, with no
 * way to see what it held.
 */
export function MixView() {
  const { id = "" } = useParams();
  const { data, isPending } = useMixes();

  if (isPending) return <TrackListSkeleton />;
  const mix = data?.find((m) => m.id === id);
  if (!mix) return <PageState title="Mix not found" body="It may have changed since you last listened." />;

  const total = mix.tracks.reduce((sum, t) => sum + (t.durationMs || 0), 0);
  // The cover is the mix's first track, as the mosaic's first tile is.
  const cover = mix.tracks.find((t) => artworkAtLeast(t.artwork, 300))?.artwork;
  return (
    <>
      <EntityHeader
        kind="Mix"
        title={mix.title}
        artwork={cover}
        meta={
          <>
            <span>{mix.description}</span>
            <span>{`· ${mix.tracks.length} songs`}</span>
            {total > 0 ? <span>{`· ${formatDuration(total)}`}</span> : null}
          </>
        }
      />
      <div className="entityactions">
        <button
          className="playbtn playbtn--accent playbtn--lg"
          aria-label={`Play ${mix.title}`}
          disabled={mix.tracks.length === 0}
          onClick={() => transport.play(mix.tracks, 0, mix.title)}
        >
          <IconPlay size={24} />
        </button>
      </div>
      {mix.tracks.length > 0 ? (
        <TrackTable tracks={mix.tracks} origin={mix.title} />
      ) : (
        <PageState title="No tracks" body="This mix is empty for now." />
      )}
    </>
  );
}
