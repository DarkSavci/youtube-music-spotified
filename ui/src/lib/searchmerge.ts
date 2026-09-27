/**
 * Recent searches: the account's history and this device's, as one list.
 *
 * Kept free of imports so it can be tested on its own.
 */

/** One row of the recent-searches list. */
export interface RecentSearch {
  query: string;
  /** Removes the entry from the account's history; absent for a local one. */
  token?: string;
  /** Whether this device's own list has it. */
  local: boolean;
}

/** How many recent searches are shown. */
export const RECENT_CAP = 10;

/*
 * The account's history leads: it is the one list every device shares, and
 * searches made here are recorded in it too. The exception is this device's
 * newest search while the account's list does not have it yet (it is kept for
 * a couple of minutes): that is the most recent search of all, so it goes
 * first. The rest of this device's searches follow the account's.
 *
 * Duplicates are compared without case, as the local list already does; an
 * entry in both lists keeps the account's token, so removing it removes it
 * everywhere.
 */
export function mergeSearches(
  account: readonly { query: string; token?: string }[],
  local: readonly string[],
  cap = RECENT_CAP,
): RecentSearch[] {
  const out: RecentSearch[] = [];
  const at = new Map<string, number>();
  const add = (query: string, token: string | undefined, isLocal: boolean) => {
    const q = query.trim();
    if (!q) return;
    const key = q.toLowerCase();
    const seen = at.get(key);
    const row = seen === undefined ? undefined : out[seen];
    if (row) {
      if (!row.token && token) row.token = token;
      if (isLocal) row.local = true;
      return;
    }
    at.set(key, out.length);
    out.push({ query: q, token: token || undefined, local: isLocal });
  };
  const inAccount = new Set(account.map((e) => e.query.trim().toLowerCase()));
  const newest = local[0];
  if (newest && !inAccount.has(newest.trim().toLowerCase())) add(newest, undefined, true);
  for (const e of account) add(e.query, e.token, false);
  for (const q of local) add(q, undefined, true);
  return out.slice(0, cap);
}
