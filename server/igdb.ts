const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const IGDB_BASE_URL = "https://api.igdb.com/v4";

interface CachedToken {
  accessToken: string;
  expiresAt: number; // Unix timestamp in ms
}

/** Shape of a raw game object returned by the IGDB API. */
export interface IgdbRawGame {
  id: number;
  name?: string;
  category?: number | null;
  parent_game?: number | null;
  version_parent?: number | null;
  first_release_date?: number;
  genres?: { name: string }[];
  summary?: string;
  storyline?: string;
  cover?: { image_id?: string };
  rating?: number;
  aggregated_rating?: number;
  platforms?: { name?: string; slug?: string }[];
  hypes?: number;
}

/** Normalized game shape returned by mapIgdbGame. */
export interface IgdbMappedGame {
  igdb_id: number;
  title: string;
  year: number | null;
  genres: string[];
  synopsis: string;
  poster_url: string | null;
  critic_score: number | null;
  owned_platforms: string[];
}

let cachedToken: CachedToken | null = null;
let tokenPromise: Promise<string> | null = null;

/** PC-store platform ids that are kept as ownership tags from IGDB data. */
const PC_STORE_PLATFORMS = new Set([
  "steam",
  "epic-games",
  "gog",
  "ea-play",
  "rockstar",
]);

/** IGDB store slugs/names → the app's platform tag ids (explicit store matches only). */
const STORE_SLUG_ALIASES: Record<string, string> = {
  steam: "steam",
  "epic-games": "epic-games",
  "epic games": "epic-games",
  gog: "gog",
  "gog.com": "gog",
  origin: "ea-play",
  "ea-app": "ea-play",
  "ea-desktop": "ea-play",
  rockstar: "rockstar",
  "rockstar-games-launcher": "rockstar",
};

/**
 * Raised when the Twitch/IGDB credentials are missing or rejected. This is an
 * operator problem, not a user error, so the discover routes translate it into
 * a 503 with an actionable message instead of a blanket 500.
 */
export class IgdbAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IgdbAuthError";
  }
}

/**
 * Retrieves a valid Twitch OAuth Access Token (Client Credentials Grant).
 * Caches the token in memory, refreshes before expiration, and coalesces
 * concurrent refreshes into a single in-flight request.
 */
export async function getIgdbAccessToken(): Promise<string> {
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new IgdbAuthError(
      "IGDB_CLIENT_ID or IGDB_CLIENT_SECRET environment variables are missing."
    );
  }

  // Return cached token if valid (with 60-second buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }

  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(TWITCH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        // 400/401/403 here mean the client id/secret pair is wrong or revoked —
        // retrying will never help, so fail with the actionable error instead.
        if (response.status === 400 || response.status === 401 || response.status === 403) {
          throw new IgdbAuthError(
            `Twitch rejected the configured IGDB credentials (${response.status}): ${errText}`
          );
        }
        throw new Error(`Failed to obtain Twitch OAuth token (${response.status}): ${errText}`);
      }

      const data = (await response.json()) as { access_token: string; expires_in: number };

      cachedToken = {
        accessToken: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };

      return cachedToken.accessToken;
    } finally {
      clearTimeout(timeoutId);
    }
  })().finally(() => {
    tokenPromise = null;
  });

  return tokenPromise;
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 300;

function isRetryable(status: number | undefined): boolean {
  if (status === undefined) return true; // network / timeout
  return status === 429 || status >= 500;
}

/** Transport-level failures (undici surfaces these as TypeError) are always safe to retry. */
function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(msg);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an Apicalypse query against an IGDB endpoint with bounded retry
 * (exponential backoff on 429/5xx/network errors) and automatic re-auth on 401.
 */
export async function fetchFromIgdb(endpoint: string, query: string): Promise<unknown> {
  const clientId = process.env.IGDB_CLIENT_ID;
  if (!clientId) {
    throw new Error("IGDB_CLIENT_ID environment variable is missing.");
  }

  let token = await getIgdbAccessToken();
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${IGDB_BASE_URL}/${endpoint}`, {
        method: "POST",
        headers: {
          "Client-ID": clientId,
          "Authorization": `Bearer ${token}`,
          "Content-Type": "text/plain",
        },
        body: query,
        signal: controller.signal,
      });

      if (response.status === 401) {
        // Token revoked/expired early — force a fresh one and retry once.
        cachedToken = null;
        token = await getIgdbAccessToken();
        continue;
      }

      if (!response.ok) {
        if (isRetryable(response.status) && attempt < MAX_RETRIES - 1) {
          lastError = new Error(`IGDB API error on /${endpoint} (${response.status})`);
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        const errText = await response.text();
        throw new Error(`IGDB API error on /${endpoint} (${response.status}): ${errText}`);
      }

      // IGDB occasionally returns 200 with an empty body — read as text and
      // retry instead of letting response.json() throw and skip the retry loop.
      const bodyText = await response.text();
      if (!bodyText.trim()) {
        if (attempt < MAX_RETRIES - 1) {
          lastError = new Error(`IGDB returned an empty body on /${endpoint}`);
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw new Error(`IGDB returned an empty body on /${endpoint}`);
      }
      return JSON.parse(bodyText);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError" && attempt < MAX_RETRIES - 1) {
        lastError = new Error(`IGDB request timed out on /${endpoint}`);
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      // DNS resets, refused connections and other transport failures never
      // reach the status-based retry path above — retry them here with the
      // same backoff. Deliberate API errors (4xx text, auth failures) are not
      // network errors, so they still throw immediately.
      if (attempt < MAX_RETRIES - 1 && isNetworkError(err)) {
        lastError = err;
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new Error(`IGDB request failed on /${endpoint}`);
}

// ── Server-side TTL cache ────────────────────────────────────────
// Discover queries are expensive (each /lists hit fires 4 IGDB calls) and
// the same data is viewed repeatedly — hold stable results in memory so
// browser refreshes / tab switches don't multiply upstream cost.
const discoveryCache = new Map<string, { at: number; data: unknown }>();
// In-flight upstream calls, keyed the same way. Without this, two requests
// that miss the cache in the same tick (fast scrolling asks for page 1 and
// page 2 back to back) both hit IGDB and — because IGDB's ordering is not
// stable across identical queries with tied sort keys — the two pools can
// differ, which shows up as duplicated or skipped items between pages.
const discoveryPending = new Map<string, Promise<unknown>>();
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
// Bound memory in a long-lived process: every distinct search string, page
// and offset is its own key, and expired entries are otherwise only dropped
// when re-requested. Evict the oldest insertion when over budget (Map keeps
// insertion order, so the first key is the oldest).
const DISCOVERY_CACHE_MAX_ENTRIES = 500;
let curatedListsCache: { at: number; data: { topThisMonth: IgdbMappedGame[]; bestAllTime: IgdbMappedGame[]; newReleases: IgdbMappedGame[]; mostHyped: IgdbMappedGame[] } } | null = null;

/**
 * fetchFromIgdb with a short TTL, keyed on endpoint + query. Callers keep
 * using fetchFromIgdb directly for user-specific or one-shot queries.
 */
export async function cachedFetchFromIgdb(endpoint: string, query: string, ttlMs: number = DISCOVERY_CACHE_TTL_MS): Promise<unknown> {
  const cacheKey = `${endpoint}\u0000${query}`;
  const hit = discoveryCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttlMs) {
    return hit.data;
  }
  if (hit) discoveryCache.delete(cacheKey); // expired — free the entry, don't accumulate

  // Coalesce concurrent misses: everyone waiting on this key shares one call.
  const pending = discoveryPending.get(cacheKey);
  if (pending) return pending;

  const call = (async () => {
    const data = await fetchFromIgdb(endpoint, query);
    if (discoveryCache.size >= DISCOVERY_CACHE_MAX_ENTRIES) {
      const oldest = discoveryCache.keys().next();
      if (!oldest.done) discoveryCache.delete(oldest.value);
    }
    discoveryCache.set(cacheKey, { at: Date.now(), data });
    return data;
  })();

  discoveryPending.set(cacheKey, call);
  try {
    return await call;
  } finally {
    discoveryPending.delete(cacheKey);
  }
}

/**
 * Highest-quality documented IGDB cover preset.
 * `t_cover_big` is only 264x374; the retina `t_cover_big_2x` variant is
 * 528x748 and is the largest `cover_*` size IGDB documents. `t_original`
 * is deliberately avoided: it is unbounded (multi-MB originals) and not
 * guaranteed to be a cover crop.
 */
export const IGDB_COVER_SIZE = "t_cover_big_2x";

/**
 * Helper to build high-quality IGDB cover image URLs.
 * Defaults to the largest documented cover preset — never emit a
 * lower-resolution variant when this is available. WebP is ~15-35%
 * smaller than the equivalent JPEG at the same visual quality and is
 * served directly by the IGDB image CDN.
 */
export function getIgdbImageUrl(imageId: string | undefined | null, size: string = IGDB_COVER_SIZE): string | null {
  if (!imageId) return null;
  return `https://images.igdb.com/igdb/image/upload/${size}/${imageId}.webp`;
}

/**
 * Upgrade a stored IGDB poster URL to the highest-quality cover preset in
 * the modern WebP format. Idempotent: URLs already on `t_cover_big_2x.webp`
 * (or non-IGDB URLs such as Steam CDN / local `/posters/...` uploads) are
 * returned untouched. Smaller cover crops (`t_cover_small`, `t_cover_big`,
 * `t_thumb`, `t_micro` and their `_2x` forms) are re-pointed at
 * `t_cover_big_2x`, and legacy `.jpg`/`.png` extensions become `.webp`, so
 * every render path loads the fastest best-quality variant without another
 * IGDB round-trip.
 */
export function upgradeIgdbPosterUrl(url: string | null | undefined): string | null | undefined {
  if (!url || typeof url !== "string") return url;
  if (!url.includes("images.igdb.com")) return url;
  // Only rewrite cover/thumb/micro crops (portrait-ish poster sources).
  // Screenshot / logo / 720p / 1080p sizes have different aspect ratios and
  // are never stored as posters, so leave them alone.
  const upgradedSize = url.replace(
    /\/t_(cover_small_2x|cover_small|cover_big|thumb_2x|thumb|micro_2x|micro)\//,
    `/${IGDB_COVER_SIZE}/`
  );
  // Same image, modern container: the CDN serves WebP for the .webp suffix.
  const upgraded = upgradedSize.replace(/\.(jpe?g|png)(\?.*)?$/, ".webp$2");
  return upgraded;
}

/**
 * Maps an IGDB raw game object to our application's normalized format.
 */
export function mapIgdbGame(item: IgdbRawGame): IgdbMappedGame {
  // UTC: server-local timezones shift the year for releases near Jan 1.
  const year = item.first_release_date
    ? new Date(item.first_release_date * 1000).getUTCFullYear()
    : null;

  const genres = Array.isArray(item.genres)
    ? item.genres.map((g) => g.name).filter(Boolean)
    : [];

  // IGDB platforms = every platform a game was *released* on (all consoles).
  // The app's platform tags mean *what the user owns*, so only keep stores
  // IGDB explicitly lists — never blanket-map "PC" to Steam. The user picks
  // their actual ownership tags when adding.
  const owned_platforms = Array.isArray(item.platforms)
    ? [...new Set(
        item.platforms
          .map((p) => (typeof p?.slug === "string" ? p.slug : p?.name || ""))
          .map((slug: string) => STORE_SLUG_ALIASES[slug.trim().toLowerCase()])
          .filter((pid: string | undefined): pid is string => Boolean(pid && PC_STORE_PLATFORMS.has(pid)))
      )]
    : [];

  const poster_url = item.cover?.image_id
    ? getIgdbImageUrl(item.cover.image_id)
    : null;

  const critic_score = typeof item.aggregated_rating === "number" 
    ? Math.round(item.aggregated_rating) 
    : (typeof item.rating === "number" ? Math.round(item.rating) : null);

  let synopsis = "No synopsis available.";
  if (item.summary && item.storyline && !item.summary.includes(item.storyline)) {
    synopsis = `${item.summary}\n\n${item.storyline}`;
  } else if (item.summary) {
    synopsis = item.summary;
  } else if (item.storyline) {
    synopsis = item.storyline;
  }

  return {
    igdb_id: item.id,
    title: item.name || "Untitled Game",
    year,
    genres,
    synopsis,
    poster_url,
    critic_score,
    owned_platforms,
  };
}

const GAME_FIELDS = "fields name, first_release_date, genres.name, summary, storyline, cover.image_id, rating, aggregated_rating, platforms.name, platforms.slug;";

// ── Discover feed pools ─────────────────────────────────────────────
//
// Trending and search are *pools*: one IGDB call builds a ranked list that is
// then paginated in memory. Why pools instead of IGDB `offset` paging:
//  - `cachedFetchFromIgdb` keys its cache on the exact query string, so an
//    offset baked into the query would bypass the cache on every page and hit
//    IGDB again (seconds of latency per "load more").
//  - Deep IGDB offsets degrade upstream, and IGDB cannot combine `search` with
//    `where` at all, so genre filtering has to happen against a pool anyway.
// The pool therefore gives us: one upstream call per (query|genre) per TTL, and
// instant, correctly-filtered pagination after that.

/** How many ranked titles make up each trending pool (≈20 pages of feed). */
const TRENDING_POOL_SIZE = 150;
/** IGDB returns at most 100 per search call — that is the search pool. */
const SEARCH_POOL_SIZE = 100;
/** Genre-filtered feeds are the same cost as unfiltered ones, so share the TTL. */
const FEED_POOL_TTL_MS = 10 * 60 * 1000;

/** Escape an IGDB Apicalypse string literal (genre names, search text). */
export function apicalypseString(value: string): string {
  // Strip characters that would break out of an Apicalypse string literal,
  // then cap the length so a hostile query can't build a huge upstream request.
  return value.replace(/[\\"\r\n;]/g, "").trim().slice(0, 200);
}

/**
 * Ranked, filtered trending pool for the Discover feed. When `genreNames` is
 * non-empty the filter is applied by IGDB itself (so every page of the feed
 * contains matches, instead of the client filtering a tiny window).
 */
export async function getTrendingPool(genreNames: string[]): Promise<IgdbMappedGame[]> {
  const where = ["total_rating_count > 50"];
  const names = genreNames.filter(Boolean).slice(0, 12);
  if (names.length) {
    where.push(`genres.name = (${names.map((n) => `"${apicalypseString(n)}"`).join(",")})`);
  }
  const query = `${GAME_FIELDS} where ${where.join(" & ")}; sort total_rating_count desc; limit ${TRENDING_POOL_SIZE};`;
  const data = await cachedFetchFromIgdb("games", query, FEED_POOL_TTL_MS);
  return (Array.isArray(data) ? (data as IgdbRawGame[]) : []).map(mapIgdbGame);
}

/**
 * Search titles IGDB knows about, minus microtransaction/edition junk and with
 * the base game ranked first. Cached as a whole pool so paging is instant and
 * genre filtering can be applied to the entire result set in JS (IGDB rejects
 * `search` queries that also carry a `where` clause).
 */
export async function getSearchPool(rawQuery: string): Promise<IgdbMappedGame[]> {
  const qStr = apicalypseString(rawQuery.trim());
  if (!qStr) return [];

  const query = `search "${qStr}"; ${GAME_FIELDS} limit ${SEARCH_POOL_SIZE};`;
  const data = await cachedFetchFromIgdb("games", query, FEED_POOL_TTL_MS);
  const raw = Array.isArray(data) ? (data as IgdbRawGame[]) : [];

  return filterSearchJunk(raw)
    .sort((a, b) => rankSearchHit(a, b, qStr))
    .map(mapIgdbGame);
}

/** Titles that are not games: skins, costume packs, DLC and edition upsells. */
const EXCLUDE_KEYWORDS = [
  "skin", "batsuit", "costume", "season pass", "pack", "add-on", "addon",
  "bonus", "theme", "avatar", "pre-order", "preorder", "suit", "car", "vehicle",
  "collector", "steelbook", "limited edition", "serious edition",
];

/** Drop skins/DLC/updates, keeping real games and major editions. */
function filterSearchJunk(items: IgdbRawGame[]): IgdbRawGame[] {
  return items.filter((item) => {
    const nameLower = (item.name || "").toLowerCase();
    if (EXCLUDE_KEYWORDS.some((kw) => nameLower.includes(kw))) return false;

    if (item.category !== undefined && item.category !== null) {
      // DLC=1, Mod=5, Pack=13, Update=14 are not standalone games.
      const allowedCategories = [0, 2, 3, 4, 8, 9, 10, 11];
      if (!allowedCategories.includes(item.category)) {
        const isMajorEdition = ["director", "goty", "game of the year"].some((kw) => nameLower.includes(kw));
        if (!isMajorEdition) return false;
      }
    }
    return true;
  });
}

/** Relevance ranking: exact title, then base games, then prefix matches. */
function rankSearchHit(a: IgdbRawGame, b: IgdbRawGame, searchLower: string): number {
  const aName = (a.name || "").toLowerCase();
  const bName = (b.name || "").toLowerCase();

  if (aName === searchLower && bName !== searchLower) return -1;
  if (bName === searchLower && aName !== searchLower) return 1;
  if (!a.version_parent && b.version_parent) return -1;
  if (!b.version_parent && a.version_parent) return 1;
  if (aName.startsWith(searchLower) && !bName.startsWith(searchLower)) return -1;
  if (bName.startsWith(searchLower) && !aName.startsWith(searchLower)) return 1;
  return 0; // Preserve IGDB's own relevance rank for the rest.
}

/**
 * Curated editorial lists for the Discover page — four parallel IGDB
 * queries resolved in a single round trip.
 */
export async function fetchCuratedLists(): Promise<{
  topThisMonth: IgdbMappedGame[];
  bestAllTime: IgdbMappedGame[];
  newReleases: IgdbMappedGame[];
  mostHyped: IgdbMappedGame[];
}> {
  const cached = curatedListsCache;
  if (cached && Date.now() - cached.at < DISCOVERY_CACHE_TTL_MS) {
    return cached.data;
  }

  const now = Math.floor(Date.now() / 1000);
  // Rolling 90-day window — "this month" alone is too sparse for rated games.
  const since90d = now - 90 * 86400;

  const [topThisMonth, bestAllTime, newReleases, mostHyped] = await Promise.all([
    // Recent releases, ranked by community rating.
    fetchFromIgdb(
      "games",
      `${GAME_FIELDS} where first_release_date >= ${since90d} & first_release_date <= ${now} & rating_count >= 10; sort rating desc; limit 15;`
    ),
    // Highest aggregate critical score of all time.
    fetchFromIgdb(
      "games",
      `${GAME_FIELDS} where aggregated_rating_count >= 10; sort aggregated_rating desc; limit 15;`
    ),
    // The freshest additions to the catalog.
    fetchFromIgdb(
      "games",
      `${GAME_FIELDS} where first_release_date <= ${now} & cover != null; sort first_release_date desc; limit 15;`
    ),
    // The most hyped upcoming titles.
    fetchFromIgdb(
      "games",
      `${GAME_FIELDS} where hypes > 300 & cover != null; sort hypes desc; limit 15;`
    ),
  ]);

  const lists = {
    topThisMonth: (Array.isArray(topThisMonth) ? (topThisMonth as IgdbRawGame[]) : []).map(mapIgdbGame),
    bestAllTime: (Array.isArray(bestAllTime) ? (bestAllTime as IgdbRawGame[]) : []).map(mapIgdbGame),
    newReleases: (Array.isArray(newReleases) ? (newReleases as IgdbRawGame[]) : []).map(mapIgdbGame),
    mostHyped: (Array.isArray(mostHyped) ? (mostHyped as IgdbRawGame[]) : []).map(mapIgdbGame),
  };
  curatedListsCache = { at: Date.now(), data: lists };
  return lists;
}
