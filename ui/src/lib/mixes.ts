import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "./base";
import type { Track } from "./types";

/** A playlist built from this machine's listening history. */
export interface Mix {
  id: string;
  kind: string;
  title: string;
  description: string;
  tracks: Track[];
  seeds?: string[];
}

/*
 * The generated mixes, shared by Home's "Made for you" and each mix's page.
 *
 * They are absent until there is enough history to seed them, which is a
 * normal early state rather than a failure — so a miss is an empty list, not
 * an error.
 */
export function useMixes() {
  return useQuery({
    queryKey: ["mixes"],
    queryFn: async ({ signal }) => {
      const res = await fetch(apiUrl("/v1/me/mixes"), { signal });
      if (!res.ok) return [] as Mix[];
      return (await res.json()) as Mix[];
    },
    retry: false,
    staleTime: 10 * 60_000,
  });
}
