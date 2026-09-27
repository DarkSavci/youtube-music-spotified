import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { mergeSearches, type RecentSearch } from "./searchmerge";
import { useSignedIn } from "./signin";
import { toast } from "./toast";
import type { SearchHistoryEntry } from "./types";

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
      // Without case, as remember() de-duplicates: a merged row may show
      // the account's spelling of a search this list holds differently.
      const next = prev.filter((p) => p.toLowerCase() !== query.trim().toLowerCase());
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

/*
 * The account's own search history.
 *
 * YouTube Music asks for it whenever its search box is focused and empty.
 * Here it is asked for only then too — the search page open with nothing
 * typed, or the box focused while empty — never at start-up, and only signed
 * in: signed out there is nothing to read, and the core would answer empty
 * anyway. The core keeps the answer for a couple of minutes, and so does
 * this cache, so reopening search does not ask YouTube again.
 */
export const SEARCH_HISTORY_KEY = ["search-history"] as const;
const HISTORY_STALE_MS = 2 * 60_000;

export const searchHistoryQuery = {
  queryKey: SEARCH_HISTORY_KEY,
  queryFn: ({ signal }: { signal: AbortSignal }) => api.searchHistory(signal),
  staleTime: HISTORY_STALE_MS,
  // Every retry is another request to YouTube; the local list stands in.
  retry: false,
} as const;

/** Readies the account's history, as the box is focused with nothing typed. */
export function prefetchSearchHistory(qc: QueryClient) {
  void qc.prefetchQuery(searchHistoryQuery);
}

/**
 * The recent-searches list: the account's history merged with this device's.
 * `active` is whether it is on screen, which is what lets the account's
 * history be read at all.
 */
export function useRecentSearchList(active: boolean) {
  const { recent, remember, forget, clear } = useRecentSearches();
  const signedIn = useSignedIn();
  const qc = useQueryClient();
  const { data: account } = useQuery({ ...searchHistoryQuery, enabled: active && signedIn });
  const items = useMemo(
    () => mergeSearches(signedIn ? (account ?? []) : [], recent),
    [signedIn, account, recent],
  );

  /** Removes a row from this device and, when it came from the account, there too. */
  const remove = useCallback(
    (item: RecentSearch) => {
      forget(item.query);
      if (!item.token) return;
      const token = item.token;
      qc.setQueryData<SearchHistoryEntry[]>(SEARCH_HISTORY_KEY, (old) => old?.filter((e) => e.token !== token));
      api.forgetSearches([token]).then(
        () => void qc.invalidateQueries({ queryKey: SEARCH_HISTORY_KEY, refetchType: "none" }),
        () => {
          toast("Couldn't remove that search from your YouTube Music history.");
          void qc.invalidateQueries({ queryKey: SEARCH_HISTORY_KEY });
        },
      );
    },
    [forget, qc],
  );

  /** Clears this device's list and every account entry shown. */
  const clearAll = useCallback(() => {
    clear();
    const tokens = (qc.getQueryData<SearchHistoryEntry[]>(SEARCH_HISTORY_KEY) ?? [])
      .map((e) => e.token)
      .filter((t): t is string => Boolean(t));
    if (tokens.length === 0) return;
    qc.setQueryData<SearchHistoryEntry[]>(SEARCH_HISTORY_KEY, []);
    api.forgetSearches(tokens).then(
      () => void qc.invalidateQueries({ queryKey: SEARCH_HISTORY_KEY, refetchType: "none" }),
      () => {
        toast("Couldn't clear your YouTube Music search history.");
        void qc.invalidateQueries({ queryKey: SEARCH_HISTORY_KEY });
      },
    );
  }, [clear, qc]);

  return { items, remember, remove, clear: clearAll };
}
