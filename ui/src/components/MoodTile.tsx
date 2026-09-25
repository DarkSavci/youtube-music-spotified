import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, browsePath } from "../lib/api";
import { artworkAtLeast, type MoodChip } from "../lib/types";

// Preview fetches are decorative. Limit concurrency and cancel offscreen work.
let active = 0;
const waiting: (() => void)[] = [];
async function preview(mood: MoodChip, signal: AbortSignal) {
  await new Promise<void>(resolve => {
    const run = () => { active++; resolve(); };
    if (active < 2) run(); else waiting.push(run);
  });
  try {
    signal.throwIfAborted();
    return await api.browse(mood.id, signal, mood.params);
  } finally { active--; waiting.shift()?.(); }
}

export function MoodTile({ mood }: { mood: MoodChip }) {
  const qc = useQueryClient();
  const ref = useRef<HTMLAnchorElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)));
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const { data } = useQuery({
    queryKey: ["browse-preview", mood.id, mood.params ?? ""],
    queryFn: ({ signal }) => preview(mood, signal),
    enabled: visible,
    staleTime: 30 * 60_000,
    retry: false,
  });
  useEffect(() => {
    if (!visible) void qc.cancelQueries({ queryKey: ["browse-preview", mood.id, mood.params ?? ""], exact: true });
  }, [visible, qc, mood.id, mood.params]);
  const item = data?.shelves.flatMap(s => s.items).find(i =>
    (i.playlist ?? i.album ?? i.track ?? i.artist ?? i.podcast ?? i.episode)?.artwork?.length);
  const art = artworkAtLeast((item?.playlist ?? item?.album ?? item?.track ?? item?.artist ?? item?.podcast ?? item?.episode)?.artwork, 240);
  return <a ref={ref} className="mood" href={`#${browsePath(mood.id, mood.params)}`}
    style={{ "--tile-color": mood.color } as React.CSSProperties}>
    <span>{mood.title}</span>
    {art ? <img className="mood__art" src={art} alt="" loading="lazy" onError={e => { e.currentTarget.style.visibility = "hidden"; }} /> : null}
  </a>;
}
