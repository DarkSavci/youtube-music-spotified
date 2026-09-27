import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, browsePath } from "../lib/api";
import { artworkAtLeast, type MoodChip } from "../lib/types";

// Preview fetches are decorative: two at a time.
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

/*
 * The grid's own response carries no pictures, so each picture costs a
 * browse request to YouTube. Only the first few tiles get one, each fetched
 * once when first seen and kept for a day; scrolling away no longer cancels
 * it, which used to make scrolling back ask again. The rest show their colour.
 */
export const MOOD_PREVIEWS = 8;

export function MoodTile({ mood, preview: withPreview = false }: { mood: MoodChip; preview?: boolean }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!withPreview || seen) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [withPreview, seen]);
  const { data } = useQuery({
    queryKey: ["browse-preview", mood.id, mood.params ?? ""],
    queryFn: ({ signal }) => preview(mood, signal),
    enabled: withPreview && seen,
    staleTime: 24 * 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
    retry: false,
  });
  const item = data?.shelves.flatMap(s => s.items).find(i =>
    (i.playlist ?? i.album ?? i.track ?? i.artist ?? i.podcast ?? i.episode)?.artwork?.length);
  const art = artworkAtLeast((item?.playlist ?? item?.album ?? item?.track ?? item?.artist ?? item?.podcast ?? item?.episode)?.artwork, 240);
  return <a ref={ref} className="mood" href={`#${browsePath(mood.id, mood.params)}`}
    style={{ "--tile-color": mood.color } as React.CSSProperties}>
    <span>{mood.title}</span>
    {art ? <img className="mood__art" src={art} alt="" loading="lazy" onError={e => { e.currentTarget.style.visibility = "hidden"; }} /> : null}
  </a>;
}
