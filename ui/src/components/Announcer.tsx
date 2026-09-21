import { useEffect, useRef, useState } from "react";
import { usePlayer } from "../lib/player";
import { artistNames } from "../lib/types";

/**
 * Screen-reader announcements.
 *
 * A music player changes what it is doing without the user acting — a track
 * ends, the next one starts, one fails and is skipped. None of that is visible
 * to a screen reader unless it is announced, so a listener using one would
 * simply not know what is playing.
 *
 * `polite` rather than `assertive`: a track change is worth knowing but never
 * worth interrupting someone mid-sentence.
 */
export function Announcer() {
  const track = usePlayer((s) => s.track);
  const state = usePlayer((s) => s.state);
  const [message, setMessage] = useState("");
  const lastAnnounced = useRef<string>("");

  useEffect(() => {
    if (!track) return;
    // Announce the track, not every state flicker: loading and buffering
    // produce several transitions per track and narrating each is noise.
    const key = `${track.id}:${state === "playing"}`;
    if (key === lastAnnounced.current) return;
    lastAnnounced.current = key;

    if (state === "playing") {
      const artists = artistNames(track.artists);
      setMessage(artists ? `Playing ${track.title} by ${artists}` : `Playing ${track.title}`);
    } else if (state === "paused") {
      setMessage("Paused");
    }
  }, [track, state]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}

/**
 * Lets keyboard users jump past the library rail straight to the content.
 *
 * Without it, reaching the main panel means tabbing through every saved item
 * on every navigation.
 */
export function SkipLink() {
  return (
    <a href="#main-content" className="skiplink">
      Skip to content
    </a>
  );
}
