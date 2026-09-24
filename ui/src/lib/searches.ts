import { useCallback, useEffect, useState } from "react";

/**
 * Recent searches.
 *
 * Kept in this browser's storage rather than in the Control plane: a recent
 * search is a convenience for the person at this keyboard, not part of the
 * listening record, and putting it in the play-log database would mean it
 * shows up in statistics that are meant to be about listening.
 *
 * Reads and writes are guarded because storage can be blocked or cleared, and
 * a missing history should cost nothing more than an empty list.
 */
const KEY = "spotifier.recentSearches" + (window.spotifier?.accountScope ? `.${window.spotifier.accountScope}` : "");
const LIMIT = 8;

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(values: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(values.slice(0, LIMIT)));
  } catch {
    /* storage blocked; the list is simply not remembered */
  }
}

export function useRecentSearches() {
  const [recent, setRecent] = useState<string[]>(read);

  // Other windows of the same app share the list.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setRecent(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const remember = useCallback((query: string) => {
    const q = query.trim();
    if (q.length < 2) return;
    setRecent((prev) => {
      // Case-insensitive de-duplication, most recent first: searching the
      // same thing twice should not fill the list with it.
      const next = [q, ...prev.filter((p) => p.toLowerCase() !== q.toLowerCase())];
      write(next);
      return next.slice(0, LIMIT);
    });
  }, []);

  const forget = useCallback((query: string) => {
    setRecent((prev) => {
      const next = prev.filter((p) => p !== query);
      write(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    write([]);
    setRecent([]);
  }, []);

  return { recent, remember, forget, clear };
}
