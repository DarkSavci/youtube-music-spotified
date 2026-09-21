/**
 * Where the Go core lives.
 *
 * In the desktop app the page is loaded over file://, where a root-relative
 * path like "/v1/home" resolves against the drive root and fails. The shell
 * therefore supplies an absolute origin.
 *
 * In a browser — dev server or plain web — the relative path is correct,
 * because Vite proxies /v1 to the core and same-origin requests just work.
 *
 * Every request in the app goes through here so the two cases never diverge
 * again: the packaged build once served every endpoint correctly while the
 * window showed nothing, purely because of this.
 */
const origin =
  typeof window !== "undefined" && window.spotifier?.coreOrigin
    ? window.spotifier.coreOrigin
    : "";

/** Absolute URL for an API path, e.g. apiUrl("/v1/home"). */
export function apiUrl(path: string): string {
  return origin + path;
}

export const API_BASE = origin + "/v1";
