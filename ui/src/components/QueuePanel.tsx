import { useEffect, useRef, useState } from "react";
import { usePlayer } from "../lib/player";
import { ArtistLinks } from "./EntityLinks";
import { transport } from "../lib/playback";
import { artistNames, artworkAtLeast } from "../lib/types";
import { IconClose, IconEqualizer, IconQueue } from "./Icon";
import { useMenu } from "./ContextMenu";

/**
 * The queue panel.
 *
 * What has played, what is sounding now, and what follows, with the upcoming
 * section labelled by where the queue came from. Played songs stay in the
 * queue, as in YouTube Music: they can be gone back to, or moved up to play
 * next again.
 */
export function QueuePanel({ onClose }: { onClose: () => void }) {
  return (
    <aside className="nowplaying panel" aria-label="Queue">
      <div className="nowplaying__head">
        <span>Queue</span>
        <button className="iconbtn" aria-label="Close queue" onClick={onClose}>
          <IconClose size={18} />
        </button>
      </div>

      <div className="nowplaying__body scroll">
        <QueueList />
      </div>
    </aside>
  );
}

/**
 * The queue itself, without the panel around it — so the mini player can show
 * the same list, with the same reordering and menus.
 *
 * `onNavigate` runs when an artist link is followed: from the mini player,
 * that has to bring the main window forward, since that is where the page
 * opens.
 */
export function QueueList({ onNavigate }: { onNavigate?: () => void } = {}) {
  const menu = useMenu();
  const { queue, index, origin, state } = usePlayer();
  const current = queue[index];
  const upcoming = queue.slice(index + 1);
  const played = queue.slice(0, index);
  // Opens on what is playing, with the history above it to scroll back to.
  const nowRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    nowRef.current?.scrollIntoView({ block: "start" });
  }, [current?.id]);
  // Drag to reorder: where the row came from and where it would land.
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  return (
    <>
      {!current ? (
        <div className="emptystate">
          <p className="emptystate__title">Nothing queued</p>
          <p className="emptystate__body">Play something and it will show up here.</p>
        </div>
      ) : (
        <>
          {played.length > 0 ? (
            <>
              <p className="queuesection">Played</p>
              <ul>
                {played.map((track, at) => (
                  <li key={`${track.id}:played:${at}`} className="queueitem">
                    <div
                      className="queuerow queuerow--played"
                      role="button"
                      tabIndex={0}
                      onClick={() => transport.jump(at)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") transport.jump(at);
                        if (e.key === "Delete") transport.removeAt(at);
                      }}
                      onContextMenu={(e) =>
                        menu.open(e, [
                          { label: "Play now", onSelect: () => transport.jump(at) },
                          // Moving it to right after the current song: the
                          // current one's position drops by one as it leaves.
                          { label: "Play next", onSelect: () => transport.move(at, index) },
                          { label: "Remove from queue", separated: true, onSelect: () => transport.removeAt(at) },
                        ])
                      }
                    >
                      <img className="queuerow__art" src={artworkAtLeast(track.artwork, 80)} alt="" loading="lazy" />
                      <span className="queuerow__text">
                        <span className="queuerow__title truncate">{track.title}</span>
                        <span className="queuerow__artist truncate"><ArtistLinks artists={track.artists} onNavigate={onNavigate} /></span>
                      </span>
                      <button
                        className="iconbtn queuerow__remove"
                        aria-label="Play next"
                        title="Play next"
                        onClick={(e) => {
                          e.stopPropagation();
                          transport.move(at, index);
                        }}
                      >
                        <IconQueue size={16} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <p className="queuesection" ref={nowRef}>Now playing</p>
          <QueueRow
            title={current.title}
            artist={artistNames(current.artists)}
            art={artworkAtLeast(current.artwork, 80)}
            current
            playing={state === "playing"}
          />

          {upcoming.length > 0 ? (
            <>
              <p className="queuesection">
                {origin ? `Next from: ${origin}` : "Next up"}
              </p>
              <ul onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
              }}>
                {upcoming.map((track, i) => {
                  const at = index + 1 + i;
                  return (
                    <li
                      key={`${track.id}:${i}`}
                      className="queueitem"
                      data-drop={dropAt === at ? (dragFrom !== null && dragFrom < at ? "after" : "before") : undefined}
                      draggable
                      onDragStart={(e) => {
                        setDragFrom(at);
                        e.dataTransfer.effectAllowed = "move";
                        // Firefox needs data for a drag to start at all.
                        e.dataTransfer.setData("text/plain", track.title);
                      }}
                      onDragOver={(e) => {
                        if (dragFrom === null) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dropAt !== at) setDropAt(at);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragFrom !== null && dragFrom !== at) transport.move(dragFrom, at);
                        setDragFrom(null);
                        setDropAt(null);
                      }}
                      onDragEnd={() => {
                        setDragFrom(null);
                        setDropAt(null);
                      }}
                    >
                      <div
                        className="queuerow"
                        role="button"
                        tabIndex={0}
                        data-dragging={dragFrom === at || undefined}
                        onClick={() => transport.jump(at)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") transport.jump(at);
                          if (e.key === "Delete") transport.removeAt(at);
                        }}
                        onContextMenu={(e) =>
                          menu.open(e, [
                            { label: "Play now", onSelect: () => transport.jump(at) },
                            {
                              label: "Play next",
                              disabled: i === 0,
                              onSelect: () => transport.move(at, index + 1),
                            },
                            { label: "Move up", disabled: i === 0, onSelect: () => transport.move(at, at - 1) },
                            {
                              label: "Move down",
                              disabled: at + 1 >= queue.length,
                              onSelect: () => transport.move(at, at + 1),
                            },
                            {
                              label: "Remove from queue",
                              separated: true,
                              onSelect: () => transport.removeAt(at),
                            },
                          ])
                        }
                      >
                        <img className="queuerow__art" src={artworkAtLeast(track.artwork, 80)} alt="" loading="lazy" draggable={false} />
                        <span className="queuerow__text">
                          <span className="queuerow__title truncate">{track.title}</span>
                          <span className="queuerow__artist truncate"><ArtistLinks artists={track.artists} onNavigate={onNavigate} /></span>
                        </span>
                        <button
                          className="iconbtn queuerow__remove"
                          aria-label="Remove from queue"
                          onClick={(e) => {
                            e.stopPropagation();
                            transport.removeAt(at);
                          }}
                        >
                          <IconClose size={16} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </>
      )}
    </>
  );
}

function QueueRow({
  title,
  artist,
  art,
  current,
  playing,
}: {
  title: string;
  artist: string;
  art?: string;
  current?: boolean;
  playing?: boolean;
}) {
  return (
    <div className="queuerow" data-current={current || undefined}>
      <img className="queuerow__art" src={art} alt="" />
      <span className="queuerow__text">
        <span className="queuerow__title truncate">{title}</span>
        <span className="queuerow__artist truncate">{artist}</span>
      </span>
      {playing ? <IconEqualizer /> : null}
    </div>
  );
}
