/**
 * Authenticated API client.
 *
 * The server gates every /api route with `Authorization: Bearer <API_TOKEN>`
 * whenever API_TOKEN is set (mandatory for non-loopback hosts). The browser
 * can't know the server's env, so the token is supplied client-side from
 * either a `VITE_API_TOKEN` build arg or a `gametrack_api_token` localStorage
 * entry (set once via devtools on the deployed host). Empty in local mode —
 * requests then go out exactly as before.
 *
 * installApiAuth() patches window.fetch a single time so all existing and
 * future same-origin /api calls (store, modals, uploads, SSE-proof GETs)
 * carry the header without touching every call site.
 *
 * The two exported helpers that used to live here — setApiToken and apiFetch —
 * are gone. apiFetch was a second, identical copy of the patching installApiAuth
 * does automatically, with no call sites. setApiToken had none either, and was
 * never exposed on `window`, so the "run it once in the browser console"
 * workflow its own doc comment described was unreachable. Set the token
 * directly instead:
 *
 *   localStorage.setItem("gametrack_api_token", "<token>")
 *
 * which is what the module has always read.
 */

const TOKEN_STORAGE_KEY = "gametrack_api_token";

/** Not exported: only installApiAuth below needs it. */
function getApiToken(): string {
  try {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    /* storage unavailable — fall through to build-time default */
  }
  return (import.meta.env.VITE_API_TOKEN as string | undefined)?.trim() || "";
}

let installed = false;

/** Patch window.fetch once so every /api call carries the bearer token. */
export function installApiAuth(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const token = getApiToken();
    if (!token) return nativeFetch(input, init);
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (!url.startsWith("/api")) return nativeFetch(input, init);
    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
      return nativeFetch(new Request(input, { headers }), init);
    }
    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    return nativeFetch(input, { ...init, headers });
  }) as typeof window.fetch;
}
