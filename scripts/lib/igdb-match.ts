import { normalizeName } from "../../server/steam";
/**
 * Shared IGDB title-matching helpers for the maintenance scripts.
 *
 * The library rows store human titles ("Batman: Arkham City - Game of the Year
 * Edition"), while IGDB is queried with Apicalypse `search`, which is fuzzy but
 * returns DLC/skins/editions alongside the base game. This module ranks the
 * candidates and only accepts a match when the names actually relate.
 */
import { fetchFromIgdb, type IgdbRawGame } from "../../server/igdb";

/** Strip "(Classic)", "[GOTY]" and similar human suffixes before searching IGDB. */
export function stripEditionSuffix(title: string): string {
  return title
    .replace(/\s*[(\[][^)\]]*(classic|goty|game of the year|definitive|remastered|remake|director'?s cut|enhanced|complete|ultimate|deluxe|anniversary|special|collector'?s|legendary|premium)[^)\]]*[)\]]\s*$/i, "")
    .replace(/\s+[-–—:]\s*[^-\–—:]*\b(classic|goty|game of the year|definitive|remastered|remake|director'?s cut|enhanced|complete|ultimate|deluxe|anniversary|special|collector'?s|legendary|premium)\b[^-\–—:]*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Fields the matcher needs — includes `category` to spot DLC/packs. */
export const MATCH_FIELDS =
  "name, category, first_release_date, genres.name, summary, storyline, cover.image_id, rating, aggregated_rating, platforms.name, platforms.slug";

/** IGDB categories that are not a standalone game: DLC, mod, pack, update. */
const NON_GAME_CATEGORIES = new Set([1, 5, 13, 14]);



/** Strip characters that would break out of an Apicalypse string literal. */
export function escapeIgdbQuery(s: string): string {
  return s.replace(/[\\"\r\n;]/g, "").trim();
}

function releaseYear(game: IgdbRawGame): number | null {
  // UTC: server-local timezones shift the year for releases near Jan 1.
  return game.first_release_date ? new Date(game.first_release_date * 1000).getUTCFullYear() : null;
}

function scoreCandidate(game: IgdbRawGame, normalizedTarget: string, year: number | null): number {
  const name = normalizeName(game.name || "");
  let score = 0;

  if (name === normalizedTarget) score += 100;
  else if (name.includes(normalizedTarget) || normalizedTarget.includes(name)) score += 40;

  const candidateYear = releaseYear(game);
  if (year && candidateYear) {
    if (candidateYear === year) score += 30;
    else if (Math.abs(candidateYear - year) <= 1) score += 10;
  }

  if (game.cover?.image_id) score += 5;
  if (typeof game.category === "number" && NON_GAME_CATEGORIES.has(game.category)) score -= 60;

  return score;
}

/**
 * Look a title up on IGDB and return the best plausible match, or null when
 * nothing relates closely enough (better no match than the wrong game).
 */
export async function findIgdbMatch(title: string, year: number | null): Promise<IgdbRawGame | null> {
  const clean = escapeIgdbQuery(title);
  if (!clean) return null;

  const target = normalizeName(clean);
  if (!target) return null;

  // Edition suffixes ("(Classic)", "- GOTY Edition") describe the local copy,
  // not the catalogue entry — search the cleaned name too and consider the
  // best candidate from either query. Nothing from the storefront suffix (no
  // "GOTY"/"Definitive"/...) may leak into the search string itself: IGDB
  // tokenizes the whole phrase and those words down-rank the base game.
  const cleaned = stripEditionSuffix(clean);
  const queries = cleaned && normalizeName(cleaned) !== target
    ? [cleaned, clean]
    : [clean];

  let best: { game: IgdbRawGame; score: number } | null = null;
  for (const q of queries) {
    for (const candidate of await searchOnce(q)) {
      const score = scoreCandidate(candidate, target, year);
      if (!best || score > best.score) best = { game: candidate, score };
    }
  }
  return best?.game ?? null;
}

/** One Apicalypse `search` call, filtered to candidates plausibly related to the target. */
async function searchOnce(query: string): Promise<IgdbRawGame[]> {
  const rows = await fetchFromIgdb("games", `search "${query}"; fields ${MATCH_FIELDS}; limit 20;`);
  const target = normalizeName(query);
  return (Array.isArray(rows) ? (rows as IgdbRawGame[]) : [])
    .filter((game) => game?.id && game.name)
    .filter((game) => {
      const name = normalizeName(game.name || "");
      return name === target || name.includes(target) || target.includes(name);
    });
}

/** Sleep helper so scripts can respect IGDB's ~4 requests/second limit. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fail fast (before touching any row) when IGDB credentials are missing or
 * rejected. Callers re-assign ids/posters, so a misconfigured environment must
 * never be able to leave the library half-updated.
 */
export async function assertIgdbReachable(): Promise<void> {
  if (!process.env.IGDB_CLIENT_ID || !process.env.IGDB_CLIENT_SECRET) {
    throw new Error(
      "IGDB_CLIENT_ID / IGDB_CLIENT_SECRET are not set. Add them to .env (Twitch Developer Portal) and re-run."
    );
  }
  try {
    await fetchFromIgdb("games", "fields id; limit 1;");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `IGDB is not reachable with the configured credentials — nothing was changed.\n  ${message}\n` +
        "  Regenerate the Client Secret at dev.twitch.tv/console/apps and update .env, then re-run."
    );
  }
}