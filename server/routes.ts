import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import db from "./db";
import { z } from "zod";
import { normalizePlatformIds, mergePlatformTags, AVAILABLE_PLATFORMS } from "../src/constants";
import { DATA_DIR, POSTERS_DIR } from "./paths";

import { mapIgdbGame, fetchCuratedLists, cachedFetchFromIgdb, getSearchPool, getTrendingPool, IgdbAuthError } from "./igdb";
import {
  resolveSteamId,
  fetchOwnedGames,
  fetchSteamAppDetails,
  fetchPlayerSummary,
  matchSteamToIgdb,
  buildSyncedGame,
  effectiveSteamApiKey,
  getSteamPosterImage,
  SteamUserError,
  SteamNetworkError,
  mapWithLimit,
  isNonGameApp,
} from "./steam";

export const apiRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────

/** Parse a JSON *array* column defensively — a single corrupt row must never
 *  abort a whole transaction.
 *
 *  The array check is load-bearing, not pedantry. The guard used to accept any
 *  `typeof === "object"` value, which let a stored `'{}'` or `'{"0":"pc"}'` past
 *  it in a column typed `string[]` everywhere else. That had two consequences,
 *  both permanent: the client received an object where an array was promised (so
 *  `(game.owned_platforms || []).join("; ")` in the CSV export threw), and — worse
 *  — every `PUT /api/games/:id` fed that object into `resolveOwnedPlatforms` →
 *  `normalizePlatformIds`, whose `for (const p of platforms)` raised
 *  "platforms is not iterable" *inside* the update transaction. The write rolled
 *  back and the endpoint answered 500 for every field, forever, with no way for
 *  the user to repair the row short of editing the database file. */
function safeJsonParse(value: string | null | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : fallback;
  } catch {
    return fallback;
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE constraint failed");
}

/** Shown whenever IGDB rejects the stored credentials — tells the operator the fix. */
const IGDB_SETUP_HINT =
  "IGDB is not reachable with the configured credentials. Set valid IGDB_CLIENT_ID / IGDB_CLIENT_SECRET (Twitch developer app) in .env and restart the server.";

/**
 * IGDB credential problems are configuration errors, so surface them as a 503
 * with the actionable message instead of a blanket 500 that hides the fix.
 */
function respondIgdbFailure(error: unknown, res: Response, fallback: string): Response {
  console.error("IGDB request failed:", error instanceof Error ? error.message : error);
  if (error instanceof IgdbAuthError) {
    return res.status(503).json({ error: IGDB_SETUP_HINT });
  }
  return res.status(500).json({ error: fallback });
}

/** Raw row shape from SQLite — JSON columns are still TEXT strings here. */
interface GameRow {
  id: number; title: string; year: number | null; igdb_id: number | null;
  genres: string; synopsis: string; poster_url: string; critic_score: number | null;
  owned_platforms: string; ownership_status: string;
  status: string; playtime: number; personal_rating: number | null;
  date_added: number; date_completed: number | null; created_at: number; updated_at: number;
  hide_playtime: number; steam_appid: number | null; custom_order: number | null;
  metadata_custom: number;
  times_played: number; replay_playtime: number;
}

/** Raw row shape for a replay — no JSON columns, so it maps straight through. */
interface PlaythroughRow {
  id: number; game_id: number; sequence: number; status: string;
  playtime: number; personal_rating: number | null; date_completed: number | null;
  platform: string | null; notes: string; created_at: number; updated_at: number;
}

interface WishlistRow {
  id: number; igdb_id: number | null; title: string; year: number | null;
  genres: string; synopsis: string; poster_url: string; critic_score: number | null;
  owned_platforms: string; date_added: number;
}

/** Parse JSON text[] columns from SQLite TEXT back to JS arrays. */
function parseGame(row: unknown): Game | null {
  if (!row) return null;
  const r = row as GameRow;
  const genres = safeJsonParse(r.genres, []);
  // The ownership/platform invariant is enforced on read as well as on write
  // (see resolveOwnedPlatforms). A row that predates it, or that arrived through
  // an import which bypassed this module, must still never reach the client
  // carrying platforms while marked not-owned: the details modal disables the
  // platform controls based on this exact value, so a stale tag would put the
  // UI and the data in disagreement — a control disabled next to a populated
  // list reads as a bug, because it is one.
  const ownership_status = resolveOwnershipStatus(r.ownership_status);
  const owned_platforms = ownership_status === "not_owned"
    ? []
    : safeJsonParse(r.owned_platforms, []);
  // The replay totals are denormalised columns that syncReplayTotals maintains,
  // so they are correct by construction — but coerced here for the same reason
  // ownership is: a client that reads them to decide whether to show a "played
  // twice" badge must never see undefined (which would be falsy and hide a
  // replay the user did log) or a count below 1.
  const times_played = Math.max(1, Number(r.times_played) || 1);
  const replay_playtime = Math.max(0, Number(r.replay_playtime) || 0);
  return { ...r, genres, owned_platforms, ownership_status, times_played, replay_playtime } as Game;
}

function parseWishlistItem(row: unknown): WishlistItem | null {
  if (!row) return null;
  const r = row as WishlistRow;
  const genres = safeJsonParse(r.genres, []);
  const owned_platforms = safeJsonParse(r.owned_platforms, []);
  return { ...r, genres, owned_platforms } as WishlistItem;
}

// ── Zod validation schemas ────────────────────────────────────────
const VALID_STATUSES = ["backlog", "playing", "completed", "endless"] as const;
/**
 * Ownership of the physical/digital copy, independent of `owned_platforms`.
 * `not_owned` is a first-class library state: the title is played and fully
 * tracked (playtime, rating, status, dates) but is not part of the collection —
 * a friend's console, a shared PC, someone else's disc.
 */
const VALID_OWNERSHIP_STATUSES = ["owned", "not_owned"] as const;

/**
 * Upper bound for any accepted epoch-millisecond timestamp. A real clock cannot
 * be past 2100, so this is the "definitely not a real timestamp" line rather
 * than a prediction. Guards the date columns against values that would render
 * as a nonsense date or poison an ORDER BY.
 */
const MAX_TIMESTAMP_MS = 4102444800000; // 2100-01-01T00:00:00Z

const GameSchema = z.object({
  title: z.string().trim().min(1).max(300),
  status: z.enum(VALID_STATUSES).default("backlog"),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  igdb_id: z.number().int().nullable().optional(),
  genres: z.array(z.string().max(100)).max(50).optional().default([]),
  synopsis: z.string().max(10_000).optional().default(""),
  // Local paths must be a genuine same-origin path. Two separate escapes are
  // closed here, and both matter:
  //
  //  1. `//evil.example/beacon.png` — a protocol-relative URL. `startsWith("/")`
  //     matches it, so the bare check accepted it.
  //  2. `/\evil.example/beacon.png` — the same attack with a backslash. WHATWG
  //     URL parsing treats "\" as "/" in the relative-slope state for special
  //     schemes, so a `!startsWith("//")` guard still accepts it while the
  //     browser resolves `new URL(v, origin)` to `http://evil.example/beacon.png`.
  //
  // The client renders this straight into an `<img src>`, so a hostile import
  // file or backup turned into a request to an attacker-chosen host on every
  // card render — a tracking pixel leaking the reader's IP and UA. Production CSP
  // `img-src` blocks it because there is no wildcard, but dev mode ships no CSP
  // at all (`server.ts`), so it fired there. Rejecting backslashes outright closes
  // the class rather than this one instance of it.
  poster_url: z.string().max(2000).refine(
    val => val === ""
      || val.startsWith("http://")
      || val.startsWith("https://")
      || (val.startsWith("/") && !/^[/\\]{2}/.test(val) && !val.includes("\\")),
    { message: "Must be an http(s) URL or a local poster path" }
  ).optional().default(""),
  critic_score: z.number().int().min(0).max(100).nullable().optional(),
  owned_platforms: z.array(z.string().max(100)).max(50).optional().default([]),
  ownership_status: z.enum(VALID_OWNERSHIP_STATUSES).default("owned"),
  playtime: z.number().min(0).max(100_000).optional().default(0),
  personal_rating: z.number().int().min(0).max(10).nullable().optional(),
  /* Epoch-millisecond timestamps. Bounded at both ends on purpose: a bare
     `z.number()` accepted -1, so an import could persist a date before 1970 that
     later renders as a nonsense "01/01/70" in the date column and sorts to the
     top of every "recently added" query. The upper bound is a year past the
     maximum `year` a game can have, which is generous for clock skew while
     still rejecting values that no real export would carry. */
  date_added: z.number().int().min(0).max(MAX_TIMESTAMP_MS).optional(),
  date_completed: z.number().int().min(0).max(MAX_TIMESTAMP_MS).nullable().optional(),
  created_at: z.number().int().min(0).max(MAX_TIMESTAMP_MS).optional(),
  updated_at: z.number().int().min(0).max(MAX_TIMESTAMP_MS).optional(),
  hide_playtime: z.number().int().min(0).max(1).optional(),
  steam_appid: z.number().int().nullable().optional(),
  custom_order: z.number().int().min(0).nullable().optional(),
  metadata_custom: z.number().int().min(0).max(1).optional(),
});

// For PATCH updates — all fields optional except partial must have at least one
const GameUpdateSchema = GameSchema.partial();

export type Game = z.infer<typeof GameSchema> & { id: number };

/**
 * One replay of a game (runs #2..n; the game row itself is run #1).
 *
 * `date_completed` is deliberately nullable with no default: "finished this
 * replay but never wrote down when" and "has not finished it yet" are different
 * facts, and defaulting one to the other would silently invent a date — or, on
 * the create path, back-date a run the user is only now starting to log.
 *
 * `platform` is free-form text, not an id from the platform table, because a
 * replay is frequently on a platform you do not hold a copy on — a friend's
 * console, a shared install. Constraining it to owned platforms would make the
 * common case unrepresentable.
 */
const PlaythroughSchema = z.object({
  status: z.enum(VALID_STATUSES).default("backlog"),
  playtime: z.number().min(0).max(100_000).optional().default(0),
  personal_rating: z.number().int().min(0).max(10).nullable().optional(),
  date_completed: z.number().int().min(0).max(MAX_TIMESTAMP_MS).nullable().optional(),
  platform: z.string().trim().max(100).nullable().optional(),
  notes: z.string().max(2_000).optional().default(""),
});
const PlaythroughUpdateSchema = PlaythroughSchema.partial();

export type Playthrough = z.infer<typeof PlaythroughSchema> & {
  id: number;
  game_id: number;
  sequence: number;
  created_at: number;
  updated_at: number;
};

/**
 * Normalise a replay row for the wire. `platform` is blanked to null rather
 * than left as "", so "no platform recorded" has exactly one representation and
 * the client never has to treat "" and null as different states.
 */
function parsePlaythrough(row: unknown): Playthrough | null {
  if (!row) return null;
  const r = row as PlaythroughRow;
  return {
    ...r,
    platform: r.platform ? r.platform : null,
    notes: r.notes ?? "",
    personal_rating: r.personal_rating ?? null,
    date_completed: r.date_completed ?? null,
  } as Playthrough;
}

const WishlistSchema = z.object({
  title: z.string().trim().min(1).max(300),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  igdb_id: z.number().int().nullable().optional(),
  genres: z.array(z.string().max(100)).max(50).optional().default([]),
  synopsis: z.string().max(10_000).optional().default(""),
  // Same local-path rule as poster_url on games, for the same reason — see the note
  // there on the backslash form of the protocol-relative escape.
  poster_url: z.string().max(2000).refine(
    val => val === ""
      || val.startsWith("http://")
      || val.startsWith("https://")
      || (val.startsWith("/") && !/^[/\\]{2}/.test(val) && !val.includes("\\")),
    { message: "Must be an http(s) URL or a local poster path" }
  ).optional().default(""),
  critic_score: z.number().int().min(0).max(100).nullable().optional(),
  owned_platforms: z.array(z.string().max(100)).max(50).optional().default([]),
});

type WishlistItem = z.infer<typeof WishlistSchema> & { id: number; date_added: number };


const OrderSchema = z.object({ ids: z.array(z.number().int().positive()) });
const BulkDeleteSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(2000) });
/** Search results are always served 15 at a time. */
const SEARCH_PAGE_SIZE = 15;

// `genre` carries the IGDB genre names to match (comma separated), already
// mapped from the UI's labels on the client.
const SearchQuerySchema = z.object({
  q: z.string().max(200).default(""),
  page: z.string().regex(/^\d+$/).default("1"),
  genre: z.string().max(300).optional().default("")
});
const TrendingQuerySchema = z.object({
  page: z.string().regex(/^\d+$/).default("1"),
  limit: z.string().regex(/^\d+$/).default("15"),
  genre: z.string().max(300).optional().default("")
});

/** Split the `genre` query param into IGDB genre names (order preserved, deduped). */
function parseGenreParam(value: string): string[] {
  return [...new Set(
    value.split(",").map((g) => g.trim()).filter(Boolean)
  )].slice(0, 12);
}
const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });
const IgdbIdParamSchema = z.object({ igdbId: z.coerce.number().int().positive() });
const UploadPosterSchema = z.object({ dataUrl: z.string().startsWith("data:image/") });
const PlatformSettingsSchema = z.object({
  platforms: z.array(z.object({
    id: z.string(),
    label: z.string()
  }))
});
const ImportSchema = z.object({ games: z.array(z.any()) });

const MAX_IMPORT_ROWS = 2000;

/**
 * Ceiling on replays attached to one game.
 *
 * Nobody has finished Bloodborne four hundred times, so a real library never
 * approaches this; it exists so a malformed or hostile import cannot append
 * hundreds of thousands of rows to a single game, and so the sequence
 * renumbering stays bounded. Well above any plausible genuine use.
 */
const MAX_REPLAYS_PER_GAME = 500;

/**
 * Coerce a client-supplied ownership_status to one of the two stored values.
 * Anything unrecognised — an omitted key on a partial PUT, a value written by a
 * newer backup, a hand-edited import — collapses to "owned", which is what every
 * row meant before the flag existed, so a bad value can never invent a state.
 */
function resolveOwnershipStatus(value: unknown): string {
  return value === "not_owned" ? "not_owned" : "owned";
}

/**
 * The ownership/platform invariant, expressed once: a game you do not own is not
 * on any platform you own it on. The console, the disc and the account belong to
 * whoever holds the copy, so a not-owned title carries no platform tags at all.
 *
 * That is why the client disables the platform controls for a not-owned game
 * rather than accepting a selection and complaining afterwards — and why this
 * runs on every write instead of trusting the client to have done the right
 * thing. Imports, the wishlist promotion and the Steam sync all funnel through
 * here, and none of them should be able to smuggle a platform onto a title the
 * user does not hold.
 */
function resolveOwnedPlatforms(ownership: string, platforms: string[] | null | undefined): string {
  return ownership === "not_owned" ? "[]" : JSON.stringify(normalizePlatformIds(platforms));
}


// ── Prepared Statements ───────────────────────────────────────────

const stmts = {
  getAllGames: db.prepare("SELECT * FROM games ORDER BY date_added DESC"),
  getGameById: db.prepare("SELECT * FROM games WHERE id = ?"),
  getGameByIgdbId: db.prepare("SELECT id FROM games WHERE igdb_id = ?"),
  insertGame: db.prepare(`
    INSERT INTO games (title, year, igdb_id, genres, synopsis, poster_url, critic_score,
      owned_platforms, ownership_status, status, playtime, personal_rating, date_added, date_completed,
      created_at, updated_at, hide_playtime, steam_appid, custom_order, metadata_custom)
    VALUES (@title, @year, @igdb_id, @genres, @synopsis, @poster_url, @critic_score,
      @owned_platforms, @ownership_status, @status, @playtime, @personal_rating, @date_added,
      @date_completed, @created_at, @updated_at, @hide_playtime, @steam_appid, @custom_order,
      @metadata_custom)
  `),
  updateGame: db.prepare(`
    UPDATE games SET title = @title, year = @year, igdb_id = @igdb_id, genres = @genres,
      synopsis = @synopsis, poster_url = @poster_url, critic_score = @critic_score,
      owned_platforms = @owned_platforms, ownership_status = @ownership_status,
      status = @status, playtime = @playtime,
      personal_rating = @personal_rating, date_added = @date_added,
      date_completed = @date_completed, hide_playtime = @hide_playtime,
      updated_at = @updated_at, steam_appid = @steam_appid, custom_order = @custom_order,
      metadata_custom = @metadata_custom
    WHERE id = @id
  `),
  deleteGame: db.prepare("DELETE FROM games WHERE id = ?"),
  /* Partial updates for the two reset endpoints. Deliberately NOT updateGame:
     those endpoints `await` an outbound IGDB call, so a full-row write would
     persist every other column from a snapshot taken before that await and revert
     whatever the user changed in the meantime — including silently flipping a
     not-owned row back to owned. Scoping the write to the columns each endpoint
     owns makes concurrent edits to anything else impossible to clobber. */
  resetMetadataFields: db.prepare(`
    UPDATE games SET title = @title, year = @year, genres = @genres,
      synopsis = @synopsis, poster_url = @poster_url, critic_score = @critic_score,
      metadata_custom = 0, updated_at = @updated_at
    WHERE id = @id
  `),
  resetPosterFields: db.prepare(`
    UPDATE games SET poster_url = @poster_url, metadata_custom = 0, updated_at = @updated_at
    WHERE id = @id
  `),
  clearCustomOrder: db.prepare("UPDATE games SET custom_order = NULL"),
  setCustomOrder: db.prepare("UPDATE games SET custom_order = ? WHERE id = ?"),
  getSettings: db.prepare("SELECT value FROM settings WHERE key = ?"),
  upsertSettings: db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"),
  deleteAllGames: db.prepare("DELETE FROM games"),
  getAllWishlist: db.prepare("SELECT * FROM wishlist ORDER BY date_added DESC"),
  getWishlistById: db.prepare("SELECT * FROM wishlist WHERE id = ?"),
  getWishlistByIgdbId: db.prepare("SELECT id FROM wishlist WHERE igdb_id = ?"),
  insertWishlist: db.prepare(`
    INSERT INTO wishlist (igdb_id, title, year, genres, synopsis, poster_url, critic_score, owned_platforms, date_added)
    VALUES (@igdb_id, @title, @year, @genres, @synopsis, @poster_url, @critic_score, @owned_platforms, @date_added)
  `),
  deleteWishlistItem: db.prepare("DELETE FROM wishlist WHERE id = ?"),

  // ── Playthroughs (replays; runs #2..n) ──
  // Ordered by sequence, not id: the UI prints "Replay N" from sequence, and
  // renumbering after a delete keeps those labels contiguous. id stays the
  // identity a client PATCHes against.
  getPlaythroughsByGame: db.prepare(
    "SELECT * FROM playthroughs WHERE game_id = ? ORDER BY sequence ASC"
  ),
  getPlaythroughById: db.prepare("SELECT * FROM playthroughs WHERE id = ?"),
  getAllPlaythroughs: db.prepare(
    "SELECT * FROM playthroughs ORDER BY game_id ASC, sequence ASC"
  ),
  /** Next display ordinal for a game. MAX + 1 because sequence 1 is the game row. */
  nextPlaythroughSequence: db.prepare(
    "SELECT COALESCE(MAX(sequence), 1) + 1 AS next FROM playthroughs WHERE game_id = ?"
  ),
  insertPlaythrough: db.prepare(`
    INSERT INTO playthroughs (game_id, sequence, status, playtime, personal_rating,
      date_completed, platform, notes, created_at, updated_at)
    VALUES (@game_id, @sequence, @status, @playtime, @personal_rating,
      @date_completed, @platform, @notes, @created_at, @updated_at)
  `),
  updatePlaythrough: db.prepare(`
    UPDATE playthroughs SET status = @status, playtime = @playtime,
      personal_rating = @personal_rating, date_completed = @date_completed,
      platform = @platform, notes = @notes, updated_at = @updated_at
    WHERE id = @id
  `),
  deletePlaythrough: db.prepare("DELETE FROM playthroughs WHERE id = ?"),
  setPlaythroughSequence: db.prepare("UPDATE playthroughs SET sequence = ? WHERE id = ?"),
  /** Re-attach a loser's replays to the keeper during a duplicate merge. */
  movePlaythroughsToGame: db.prepare("UPDATE playthroughs SET game_id = ?, updated_at = ? WHERE game_id = ?"),
  /** The aggregates the games row caches — the only source of truth for both. */
  sumPlaythroughs: db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(playtime), 0) AS t FROM playthroughs WHERE game_id = ?"
  ),
  setReplayTotals: db.prepare(
    "UPDATE games SET times_played = ?, replay_playtime = ? WHERE id = ?"
  ),
};

/**
 * Recompute a game's denormalised replay totals from its playthrough rows.
 *
 * Called inside the same transaction as every mutation of those rows — insert,
 * update, delete, and the duplicate-merge re-parent — so the cached columns on
 * `games` can never disagree with the rows they summarise. Deriving rather than
 * incrementing is deliberate: an increment has to be right at every call site,
 * and a retry or a future code path that forgets one silently corrupts the
 * number the library badge and the analytics totals both read.
 *
 * No-ops on an unknown game id, which is what makes it safe to call
 * unconditionally after a delete.
 */
function syncReplayTotals(gameId: number) {
  const agg = stmts.sumPlaythroughs.get(gameId) as { n: number; t: number };
  stmts.setReplayTotals.run((agg.n || 0) + 1, agg.t || 0, gameId);
}

/**
 * Push a game's replay ordinals above the legal range without changing their
 * relative order.
 *
 * The table carries `UNIQUE (game_id, sequence)`, so any operation that brings
 * new rows in under ordinals the keeper already uses — a duplicate merge — has
 * to move the keeper's rows out of the way first. Parking the keeper before the
 * move is what makes that insert legal.
 *
 * Idempotent: parking an already-parked row just pushes it further out, and the
 * offset is large enough that a parked value can never coincide with a final
 * one (MAX_REPLAYS_PER_GAME is 500). The column's `CHECK (sequence >= 2)` still
 * holds while parked, so the statement cannot fail on the way in.
 */
const SEQUENCE_PARK_OFFSET = 1_000_000;
const parkSequences = (gameId: number) =>
  db.prepare("UPDATE playthroughs SET sequence = sequence + ? WHERE game_id = ?")
    .run(SEQUENCE_PARK_OFFSET, gameId);

/**
 * Rewrite a game's replay ordinals to 2..n with no gaps, preserving order.
 *
 * `sequence` exists purely so the UI can say "Replay 3" instead of showing a
 * raw row id, and a gap reads as a bug ("Replay 4, Replay 6") rather than as a
 * replay that was deleted. Renumbering on delete keeps the labels honest; the
 * stable identity is `id`, which no caller holds across this operation.
 *
 * Parking first is load-bearing. Writing the final ordinals one at a time
 * collides with a row that has not been rewritten yet, because the old ordinal
 * is still live — so every row is pushed out of range first (which keeps them
 * mutually distinct) and only then assigned its final value. No intermediate
 * state can hold two rows at the same sequence.
 */
function resequencePlaythroughs(gameId: number) {
  parkSequences(gameId);
  /* Ordered by parking band FIRST, then sequence.

     The merge parks the keeper's ordinals, moves the loser's replays in
     un-parked, and calls this — which parks everything a second time. The two
     bands are then distinguishable: the keeper's sit at 2×PARK, the loser's at
     1×PARK. Ordering on raw sequence alone therefore listed the LOSER's runs
     first and pushed the keeper's own first replay from ordinal 2 to 4, which
     is the opposite of what the merge promises ("the loser contributes its
     replays only") and visibly renumbered every surviving replay of the kept
     row. The band-aware sort keeps the keeper's runs ahead of the newcomer's.

     `>= PARK * 2` selects the keeper's band. Falls back to plain ordering for a
     lone game, where everything is in the same band and only sequence matters. */
  const rows = db
    .prepare(
      "SELECT id, sequence FROM playthroughs WHERE game_id = ? ORDER BY (sequence >= ?) DESC, sequence ASC, id ASC"
    )
    .all(gameId, SEQUENCE_PARK_OFFSET * 2) as { id: number }[];
  rows.forEach((row, index) => stmts.setPlaythroughSequence.run(index + 2, row.id));
}

// ── GAMES CRUD ────────────────────────────────────────────────────

// GET /api/health — liveness probe for process managers and containers
apiRouter.get("/health", (_req: Request, res: Response) => {
  try {
    db.prepare("SELECT 1").get();
    res.json({ ok: true, db: "up" });
  } catch (err) {
    console.error("GET /api/health error:", err);
    res.status(500).json({ ok: false, db: "down" });
  }
});

// GET /api/games
apiRouter.get("/games", (_req: Request, res: Response) => {
  try {
    const rows = stmts.getAllGames.all();
    res.json(rows.map(parseGame));
  } catch (err) {
    console.error("GET /api/games error:", err);
    res.status(500).json({ error: "Failed to fetch games" });
  }
});

// GET /api/export — full library as a downloadable JSON backup (round-trips
// with POST /api/import). JSON arrays are parsed defensively like everywhere
// else, so a corrupt row can't break the backup.
apiRouter.get("/export", (_req: Request, res: Response) => {
  try {
    const rows = stmts.getAllGames.all();
    // parseGame returns null for a falsy row; filter before mapping so the
    // nested-replay step below never dereferences one.
    const games = rows.map(parseGame).filter((g): g is Game => g != null);
    // Replays are nested under their game rather than exported as a second flat
    // array: the payload is meant to round-trip through POST /api/import, and a
    // game_id-keyed side array would need the importer to re-resolve ids that
    // the import assigns itself. Nested, each game carries its own history.
    const runs = stmts.getAllPlaythroughs.all() as PlaythroughRow[];
    const byGame = new Map<number, Playthrough[]>();
    for (const row of runs) {
      const parsedRow = parsePlaythrough(row);
      if (!parsedRow) continue;
      const list = byGame.get(row.game_id) ?? [];
      list.push(parsedRow);
      byGame.set(row.game_id, list);
    }
    const payload = JSON.stringify(
      games.map((g) => {
        const list = byGame.get(g.id);
        return list && list.length ? { ...g, playthroughs: list } : g;
      }),
      null,
      2
    );
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="gametrack-library-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(payload);
  } catch (err) {
    console.error("GET /api/export error:", err);
    res.status(500).json({ error: "Failed to export library" });
  }
});

// POST /api/games
apiRouter.post("/games", (req: Request, res: Response) => {
  try {
    const parsed = GameSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid game data", details: parsed.error.flatten().fieldErrors });
    }
    const g = parsed.data;
    const now = Date.now();
    const result = stmts.insertGame.run({
      title: g.title,
      year: g.year ?? null,
      igdb_id: g.igdb_id ?? null,
      genres: JSON.stringify(g.genres),
      synopsis: g.synopsis,
      poster_url: g.poster_url,
      critic_score: g.critic_score ?? null,
      ownership_status: resolveOwnershipStatus(g.ownership_status),
      owned_platforms: resolveOwnedPlatforms(
        resolveOwnershipStatus(g.ownership_status),
        g.owned_platforms
      ),
      status: g.status,
      playtime: g.playtime,
      personal_rating: g.personal_rating ?? null,
      date_added: g.date_added ?? now,
      date_completed: g.date_completed ?? (g.status === "completed" ? now : null),
      created_at: g.created_at ?? now,
      updated_at: g.updated_at ?? now,
      hide_playtime: g.hide_playtime ?? 0,
      steam_appid: g.steam_appid ?? null,
      custom_order: g.custom_order ?? null,
      metadata_custom: g.metadata_custom ?? 0,
    });
    const inserted = parseGame(stmts.getGameById.get(result.lastInsertRowid));
    res.status(201).json(inserted);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({ error: "A game with the same external ID already exists in the library." });
    }
    console.error("POST /api/games error:", err);
    res.status(500).json({ error: "Failed to add game" });
  }
});

// PUT /api/games/order — persist the hand-arranged library order.
// Body: { ids: number[] } in the desired display order (full library).
// Position = index in the array; games not listed are un-ordered (NULL).
apiRouter.put("/games/order", (req: Request, res: Response) => {
  try {
    const parsed = OrderSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid order payload", details: parsed.error.flatten().fieldErrors });
    const { ids } = parsed.data;
    if (ids.length === 0 || ids.length > 5000) return res.status(400).json({ error: "Invalid game id list length" });
    if (new Set(ids).size !== ids.length) return res.status(400).json({ error: "Order payload contains duplicate game ids" });

    const libraryRows = stmts.getAllGames.all() as { id: number }[];
    if (ids.length !== libraryRows.length) {
      return res.status(400).json({ error: `Order payload must contain all ${libraryRows.length} games` });
    }
    // Bind the payload to the actual library set: without this check a caller
    // could submit arbitrary ids, wiping the custom order of every real game
    // while writing order positions for ids that don't exist.
    const libraryIds = new Set(libraryRows.map((r) => r.id));
    if (!ids.every((id) => libraryIds.has(id))) {
      return res.status(400).json({ error: "Order payload contains unknown game ids" });
    }

    const setOrder = db.transaction((ordered: number[]) => {
      stmts.clearCustomOrder.run();
      const stmt = stmts.setCustomOrder;
      ordered.forEach((id, index) => stmt.run(index, id));
    });
    setOrder(ids);

    const rows = stmts.getAllGames.all();
    res.json(rows.map(parseGame));
  } catch (err) {
    console.error("PUT /api/games/order error:", err);
    res.status(500).json({ error: "Failed to save game order" });
  }
});

// DELETE /api/games/order — clear the hand-arranged order back to default.
apiRouter.delete("/games/order", (_req: Request, res: Response) => {
  try {
    stmts.clearCustomOrder.run();
    const rows = stmts.getAllGames.all();
    res.json(rows.map(parseGame));
  } catch (err) {
    console.error("DELETE /api/games/order error:", err);
    res.status(500).json({ error: "Failed to reset game order" });
  }
});

// PUT /api/games/:id
apiRouter.put("/games/:id", (req: Request, res: Response) => {
  try {
    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) return res.status(400).json({ error: "Invalid game ID" });
    const gameId = paramParsed.data.id;

    const existing = stmts.getGameById.get(gameId) as GameRow | undefined;
    if (!existing) return res.status(404).json({ error: "Game not found" });

    const parsed = GameUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid update data", details: parsed.error.flatten().fieldErrors });
    }
    const g = parsed.data;
    const now = Date.now();

    // IMPORTANT: zod's `.default()` (status → "backlog", poster_url → "", etc.)
    // fires even for OMITTED keys in a partial update, which would silently
    // reset those columns. Only apply fields the client actually sent.
    const body = (req.body ?? {}) as any;
    const sent = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

    // Merge validated input with existing row, then update the full row
    const nextStatus = sent("status") ? g.status : existing.status;
    let nextDateCompleted = g.date_completed !== undefined ? g.date_completed : existing.date_completed;
    if (sent("status") && nextStatus === "completed" && existing.status !== "completed" && !nextDateCompleted) {
      nextDateCompleted = now; // entering completed — stamp the completion date
    }
    // `date_completed` is deliberately NOT cleared when a title leaves
    // "completed": it is a historical record of when the game was finished, so
    // re-opening a game and completing it again keeps the original date rather
    // than inflating the completion history. The consequence — a row that is
    // no longer completed still carries a date — is handled at the read sites,
    // which all require `status === "completed"` before counting a completion
    // (see AnalyticsView.completedMonths and the "Completed This Month" panel).

    // Any edit to the metadata fields marks the row as user-customized, so the
    // next Steam sync preserves it instead of reverting it to IGDB defaults.
    // Status/playtime/rating changes and internal sync writes do not set this.
    // Internal provider refreshes send metadata_custom: 0 to opt out of the
    // auto-flag (never cleared automatically — only reset-metadata clears it).
    const touchesMetadata =
      sent("title") || sent("year") || sent("genres") || sent("synopsis") ||
      sent("poster_url") || sent("critic_score");
    const internalRefresh = sent("metadata_custom") && g.metadata_custom === 0;
    const nextMetadataCustom = internalRefresh
      ? existing.metadata_custom
      : touchesMetadata || g.metadata_custom === 1
        ? 1
        : existing.metadata_custom;

    const apply = db.transaction(() => {
      stmts.updateGame.run({
      title: g.title ?? existing.title,
      year: g.year !== undefined ? g.year : existing.year,
      igdb_id: g.igdb_id !== undefined ? g.igdb_id : existing.igdb_id,
      genres: JSON.stringify(sent("genres") ? g.genres : safeJsonParse(existing.genres, [])),
      synopsis: sent("synopsis") ? g.synopsis : existing.synopsis,
      poster_url: sent("poster_url") ? g.poster_url : existing.poster_url,
      critic_score: g.critic_score !== undefined ? g.critic_score : existing.critic_score,
      // Same sent()-gate as every other column: zod's `.default("owned")` fires
      // for an omitted key, so reading g.ownership_status directly would flip
      // every not-owned game back to owned on any unrelated edit. Resolved once,
      // because the platform invariant below depends on the same answer.
      ownership_status: sent("ownership_status")
        ? resolveOwnershipStatus(g.ownership_status)
        : resolveOwnershipStatus(existing.ownership_status),
      owned_platforms: resolveOwnedPlatforms(
        sent("ownership_status")
          ? resolveOwnershipStatus(g.ownership_status)
          : resolveOwnershipStatus(existing.ownership_status),
        sent("owned_platforms") ? g.owned_platforms : safeJsonParse(existing.owned_platforms, [])
      ),
      status: sent("status") ? g.status : existing.status,
      playtime: sent("playtime") ? g.playtime : existing.playtime,
      personal_rating: g.personal_rating !== undefined ? g.personal_rating : existing.personal_rating,
      date_added: g.date_added ?? existing.date_added,
      date_completed: nextDateCompleted,
      hide_playtime: g.hide_playtime !== undefined ? g.hide_playtime : existing.hide_playtime,
      steam_appid: g.steam_appid !== undefined ? g.steam_appid : existing.steam_appid,
      custom_order: g.custom_order !== undefined ? g.custom_order : existing.custom_order,
      metadata_custom: nextMetadataCustom,
      updated_at: now,
      id: gameId,
    });
    });
    apply();
    const updated = parseGame(stmts.getGameById.get(gameId));
    res.json(updated);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({ error: "Another game already uses this external ID." });
    }
    console.error("PUT /api/games/:id error:", err);
    res.status(500).json({ error: "Failed to update game" });
  }
});

// POST /api/games/:id/reset-metadata — restore the default IGDB metadata for a
// game (title/year/genres/synopsis/critic score + poster). Steam-owned rows
// reset their poster to the Steam CDN artwork; everyone else gets the IGDB
// cover. User data (status, playtime, rating, platforms, dates) is untouched.
apiRouter.post("/games/:id/reset-metadata", async (req: Request, res: Response) => {
  try {
    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) return res.status(400).json({ error: "Invalid game ID" });
    const gameId = paramParsed.data.id;

    const existing = stmts.getGameById.get(gameId) as GameRow | undefined;
    if (!existing) return res.status(404).json({ error: "Game not found" });
    if (existing.igdb_id == null) {
      return res.status(400).json({ error: "This game has no IGDB link, so there is no default metadata to restore." });
    }

    const query = `fields name, first_release_date, genres.name, summary, storyline, cover.image_id, rating, aggregated_rating, platforms.name, platforms.slug; where id = ${existing.igdb_id};`;
    const data = await cachedFetchFromIgdb("games", query, 60 * 60 * 1000);
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(404).json({ error: "Game not found on IGDB" });
    }
    const mapped = mapIgdbGame(data[0]);
    const poster = existing.steam_appid != null
      ? getSteamPosterImage(existing.steam_appid)
      : (mapped.poster_url || "");

    /* Writes ONLY the fields this endpoint owns.

       This used to be a full-row UPDATE built from the `existing` snapshot read
       at the top of the handler. But the handler `await`s an outbound IGDB call
       between that read and this write, which can take seconds — and every other
       column was being rewritten verbatim from the pre-await snapshot. Anything
       the user changed during that window was silently reverted: logged
       playtime, a new rating, a status change, a hide-playtime toggle, an
       ownership flip. The ownership columns made it worst: re-deriving them
       from the stale snapshot *re-broke the not-owned invariant*, actively
       reverting a flag back to "owned", and the re-read at the end then reported
       that reverted state as a success.

       A transaction would not have helped — the data is already stale by the
       time it starts. Scoping the write to the columns this endpoint is
       actually authoritative for is the fix: concurrent edits to anything else
       cannot be clobbered, because they are never written. */
    stmts.resetMetadataFields.run({
      title: mapped.title,
      year: mapped.year,
      genres: JSON.stringify(mapped.genres),
      synopsis: mapped.synopsis,
      poster_url: poster,
      critic_score: mapped.critic_score,
      metadata_custom: 0,
      updated_at: Date.now(),
      id: gameId,
    });
    res.json(parseGame(stmts.getGameById.get(gameId)));
  } catch (err) {
    respondIgdbFailure(err, res, "Failed to reset metadata");
  }
});

// POST /api/games/:id/reset-poster — restore just the poster to the default
// artwork (Steam CDN for Steam-owned rows, IGDB cover for linked rows, blank
// otherwise) and hand the row back to the automatic metadata pipeline.
//
// This exists instead of a client-side PUT because the PUT handler deliberately
// *preserves* metadata_custom when a caller sends `metadata_custom: 0` (that
// flag is the "the user hand-edited this" opt-out for internal refreshes).
// The client used to reset the poster by PUTting the poster URL directly, which
// the PUT handler read as a user edit: the row was permanently marked as
// hand-customized, so the next Steam sync refused to touch it and a later reset
// to defaults could never take hold. A reset has to be able to clear the flag,
// and only the server knows the canonical poster URL — the client was
// re-templating Valve's CDN path by hand and would silently drift from
// server/steam.ts if either side changed.
apiRouter.post("/games/:id/reset-poster", async (req: Request, res: Response) => {
  try {
    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) return res.status(400).json({ error: "Invalid game ID" });
    const gameId = paramParsed.data.id;

    const existing = stmts.getGameById.get(gameId) as GameRow | undefined;
    if (!existing) return res.status(404).json({ error: "Game not found" });

    // A row with no provider link has no default artwork to restore; blank it
    // so the UI falls back to the built-in cover, which is what "reset" means.
    let poster = "";
    if (existing.steam_appid != null) {
      poster = getSteamPosterImage(existing.steam_appid);
    } else if (existing.igdb_id != null) {
      const data = await cachedFetchFromIgdb(
        "games",
        `fields cover.image_id; where id = ${existing.igdb_id};`,
        60 * 60 * 1000
      );
      if (!Array.isArray(data) || data.length === 0) {
        return res.status(404).json({ error: "Game not found on IGDB" });
      }
      poster = mapIgdbGame(data[0]).poster_url || "";
    }

    /* Poster-only write, for the same reason as reset-metadata above: the handler
       `await`s IGDB for any row without a Steam appid (the common case for a
       non-Steam library), and rewriting every other column from the pre-await
       snapshot reverted anything the user changed during that window. The
       `await` is conditional, so the bug was intermittent: Steam-linked rows
       returned before yielding and had a zero-width window. */
    stmts.resetPosterFields.run({
      poster_url: poster,
      metadata_custom: 0,
      updated_at: Date.now(),
      id: gameId,
    });
    res.json(parseGame(stmts.getGameById.get(gameId)));
  } catch (err) {
    respondIgdbFailure(err, res, "Failed to reset poster");
  }
});

// DELETE /api/games/:id
apiRouter.delete("/games/:id", (req: Request, res: Response) => {
  try {
    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) return res.status(400).json({ error: "Invalid game ID" });
    const gameId = paramParsed.data.id;
    const result = stmts.deleteGame.run(gameId);
    if (result.changes === 0) return res.status(404).json({ error: "Game not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/games/:id error:", err);
    res.status(500).json({ error: "Failed to delete game" });
  }
});

// POST /api/games/bulk-delete — batch delete games
apiRouter.post("/games/bulk-delete", (req: Request, res: Response) => {
  try {
    const parsed = BulkDeleteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid bulk delete payload", details: parsed.error.flatten().fieldErrors });
    const validIds = parsed.data.ids;
    const deleteBatch = db.transaction((idList: number[]) => {
      let count = 0;
      for (const id of idList) {
        const result = stmts.deleteGame.run(id);
        if (result.changes > 0) count++;
      }
      return count;
    });
    const deletedCount = deleteBatch(validIds);
    res.json({ success: true, count: deletedCount });
  } catch (err) {
    console.error("POST /api/games/bulk-delete error:", err);
    res.status(500).json({ error: "Failed to delete games" });
  }
});

// ── PLAYTHROUGHS (replays) ─────────────────────────────────────────
//
// A game played more than once. The games row is playthrough #1 and is never
// duplicated here; these routes manage runs #2..n only. That split is the whole
// design: the library keeps one row per title, so nothing downstream — the
// grid, the filters, the duplicate detector, the Steam sync — has to learn what
// a second copy of a game would even mean.
//
// Every mutation runs inside a transaction that also calls syncReplayTotals
// (and resequencePlaythroughs on delete), so the denormalised totals on `games`
// and the ordinals the UI prints are updated in the same atomic step as the rows
// themselves. There is no path that writes a replay without refreshing them.

// GET /api/games/:id/playthroughs — every run for a game, oldest first.
// `times_played` is returned alongside so the client does not have to trust its
// cached copy of the game row, which may predate the latest replay.
apiRouter.get("/games/:id/playthroughs", (req: Request, res: Response) => {
  try {
    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) return res.status(400).json({ error: "Invalid game ID" });
    const gameId = paramParsed.data.id;

    const game = stmts.getGameById.get(gameId) as GameRow | undefined;
    if (!game) return res.status(404).json({ error: "Game not found" });

    const playthroughs = (stmts.getPlaythroughsByGame.all(gameId) as PlaythroughRow[])
      .map(parsePlaythrough);
    res.json({ playthroughs, times_played: (game.times_played as number) ?? playthroughs.length + 1 });
  } catch (err) {
    console.error("GET /api/games/:id/playthroughs error:", err);
    res.status(500).json({ error: "Failed to fetch playthroughs" });
  }
});

// POST /api/games/:id/playthroughs — log another run of this game.
//
// Defaults are honest rather than optimistic: a new replay starts as
// 'backlog' with no date and zero playtime, because "I have beaten this again"
// is the only fact the act of adding it asserts. Deciding it was completed, when
// and for how long is the user's to fill in afterwards.
apiRouter.post("/games/:id/playthroughs", (req: Request, res: Response) => {
  try {
    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) return res.status(400).json({ error: "Invalid game ID" });
    const gameId = paramParsed.data.id;

    if (!stmts.getGameById.get(gameId)) return res.status(404).json({ error: "Game not found" });

    const runCount = stmts.getPlaythroughsByGame.all(gameId).length;
    if (runCount >= MAX_REPLAYS_PER_GAME) {
      return res.status(400).json({ error: `A game can hold at most ${MAX_REPLAYS_PER_GAME} replays.` });
    }

    const parsed = PlaythroughSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid playthrough data", details: parsed.error.flatten().fieldErrors });
    }
    const p = parsed.data;
    const now = Date.now();

    const create = db.transaction(() => {
      const seq = (stmts.nextPlaythroughSequence.get(gameId) as { next: number }).next;
      const result = stmts.insertPlaythrough.run({
        game_id: gameId,
        sequence: seq,
        status: p.status,
        playtime: p.playtime ?? 0,
        personal_rating: p.personal_rating ?? null,
        date_completed: p.date_completed ?? null,
        platform: p.platform ? p.platform : null,
        notes: p.notes ?? "",
        created_at: now,
        updated_at: now,
      });
      syncReplayTotals(gameId);
      return result.lastInsertRowid;
    });

    const id = create();
    res.status(201).json(parsePlaythrough(stmts.getPlaythroughById.get(id)));
  } catch (err) {
    console.error("POST /api/games/:id/playthroughs error:", err);
    res.status(500).json({ error: "Failed to add playthrough" });
  }
});

// PUT /api/playthroughs/:id — update one replay in place.
//
// The game is never touched here. A replay's status is its own: you can be part
// way through a second run of a finished game, which is exactly the state that
// "one status per game" could not express before this existed.
apiRouter.put("/playthroughs/:id", (req: Request, res: Response) => {
  try {
    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) return res.status(400).json({ error: "Invalid playthrough ID" });
    const id = paramParsed.data.id;

    const existing = stmts.getPlaythroughById.get(id) as PlaythroughRow | undefined;
    if (!existing) return res.status(404).json({ error: "Playthrough not found" });

    const parsed = PlaythroughUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid playthrough data", details: parsed.error.flatten().fieldErrors });
    }
    const p = parsed.data;
    // Same omitted-key guard the games PUT uses: zod's `.default()` fires for
    // absent keys on a partial schema, so reading `p.status` directly would reset
    // every omitted field to its default on any unrelated edit.
    const body = (req.body ?? {}) as any;
    const sent = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

    const apply = db.transaction(() => {
      stmts.updatePlaythrough.run({
        id,
        status: sent("status") ? p.status : existing.status,
        playtime: sent("playtime") ? p.playtime : existing.playtime,
        personal_rating: sent("personal_rating") ? (p.personal_rating ?? null) : existing.personal_rating,
        date_completed: sent("date_completed") ? (p.date_completed ?? null) : existing.date_completed,
        platform: sent("platform") ? (p.platform ? p.platform : null) : existing.platform,
        notes: sent("notes") ? p.notes : existing.notes,
        updated_at: Date.now(),
      });
      syncReplayTotals(existing.game_id);
    });
    apply();

    res.json(parsePlaythrough(stmts.getPlaythroughById.get(id)));
  } catch (err) {
    console.error("PUT /api/playthroughs/:id error:", err);
    res.status(500).json({ error: "Failed to update playthrough" });
  }
});

// DELETE /api/playthroughs/:id — remove one replay.
//
// Re-ordinals the survivors so the UI keeps printing contiguous "Replay N"
// labels, and refreshes the game's totals — in the same transaction, so a game
// is never left claiming a playthrough that no longer exists.
apiRouter.delete("/playthroughs/:id", (req: Request, res: Response) => {
  try {
    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) return res.status(400).json({ error: "Invalid playthrough ID" });
    const id = paramParsed.data.id;

    const existing = stmts.getPlaythroughById.get(id) as PlaythroughRow | undefined;
    if (!existing) return res.status(404).json({ error: "Playthrough not found" });

    const apply = db.transaction(() => {
      stmts.deletePlaythrough.run(id);
      resequencePlaythroughs(existing.game_id);
      syncReplayTotals(existing.game_id);
    });
    apply();

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/playthroughs/:id error:", err);
    res.status(500).json({ error: "Failed to delete playthrough" });
  }
});

// ── ANALYTICS ─────────────────────────────────────────────────────

apiRouter.get("/analytics", (_req: Request, res: Response) => {
  try {
    const summary = db.prepare(`
      SELECT 
        COUNT(id) as total_games,
        SUM(CASE WHEN status = 'playing' THEN 1 ELSE 0 END) as active_games,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_games,
        SUM(CASE WHEN hide_playtime = 0 THEN playtime ELSE 0 END) as total_playtime_hours,
        MAX(updated_at) as last_updated,
        SUM(CASE WHEN ownership_status = 'owned' THEN 1 ELSE 0 END) as owned_games,
        SUM(CASE WHEN ownership_status = 'not_owned' THEN 1 ELSE 0 END) as not_owned_games,
        SUM(CASE WHEN ownership_status = 'owned' AND hide_playtime = 0 THEN playtime ELSE 0 END) as owned_playtime_hours,
        SUM(CASE WHEN ownership_status = 'not_owned' AND hide_playtime = 0 THEN playtime ELSE 0 END) as not_owned_playtime_hours,
        SUM(CASE WHEN times_played > 1 THEN 1 ELSE 0 END) as replayed_games,
        MAX(times_played) as most_times_played,
        /* Replay hours are NOT folded into total_playtime_hours. That figure has
           always meant "hours on first playthroughs" and is the divisor's
           numerator for average_playtime_per_game; quietly widening its meaning
           would inflate an existing stat without saying so. The all-in figure is
           published separately below, and the two are always reported together
           so the reader can see exactly what each one counts. */
        SUM(CASE WHEN hide_playtime = 0 THEN replay_playtime ELSE 0 END) as replay_playtime_hours,
        SUM(times_played) as times_played
      FROM games

    `).get() as any;

    // Replay rows belonging to games whose playtime is hidden are excluded from
    // both replay totals, matching how the games row's own playtime is treated
    // — otherwise hiding a game's hours would still surface them through the
    // replay figure.
    const replayTotals = db.prepare(`
      SELECT COUNT(*) AS total_runs,
             COALESCE(SUM(CASE WHEN g.hide_playtime = 0 THEN p.playtime ELSE 0 END), 0) AS total_hours,
             COUNT(DISTINCT p.game_id) AS games_with_replays
      FROM playthroughs p
      JOIN games g ON g.id = p.game_id
    `).get() as { total_runs: number; total_hours: number; games_with_replays: number };

    // "Most replayed" reads the runs directly rather than SUM(times_played),
    // which only agrees with it when no game has been hidden from playtime
    // reporting — see above.
    const mostReplayed = db.prepare(`
      SELECT g.title, g.id, g.times_played
      FROM games g
      WHERE g.times_played > 1
      ORDER BY g.times_played DESC, g.title ASC
      LIMIT 1
    `).get() as { title: string; id: number; times_played: number } | undefined;

    // The `CASE` around `genres` is load-bearing. `json_each` raises a
    // malformed-JSON error on a bad value, and a table-valued function in the
    // FROM clause is evaluated while the scan runs — so a `WHERE json_valid(...)`
    // guard can be reordered away from the call and does not reliably keep the
    // error from being raised. Substituting an empty array does, and it puts
    // this endpoint on the same footing as `parseGame`, which has always fallen
    // back to `[]` for an unparseable row rather than failing the response.
    const genreAnalytics = db.prepare(`
      SELECT j.value as genre, COUNT(g.id) as game_count, SUM(CASE WHEN g.hide_playtime = 0 THEN g.playtime ELSE 0 END) as total_playtime
      FROM games g, json_each(CASE WHEN json_valid(g.genres) THEN g.genres ELSE '[]' END) j
      
      GROUP BY j.value
      ORDER BY total_playtime DESC
    `).all();

    const thresholdMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentActivity = db.prepare(`
      SELECT * FROM games
      WHERE updated_at >= ?
      ORDER BY updated_at DESC
    `).all(thresholdMs).map(parseGame);

    res.json({
      summary: {
        total_games: summary.total_games || 0,
        active_games: summary.active_games || 0,
        completed_games: summary.completed_games || 0,
        total_playtime_hours: summary.total_playtime_hours || 0,
        average_playtime_per_game: summary.total_games > 0 ? parseFloat(((summary.total_playtime_hours || 0) / summary.total_games).toFixed(1)) : 0,
        last_updated: summary.last_updated || Date.now(),
        // The ownership split is reported alongside the totals rather than
        // instead of them: the totals still describe the whole registry, and the
        // split is what lets a view say how much of it is a title you actually
        // hold a copy of. `owned_*` + `not_owned_*` always reconciles with the
        // unrestricted figures, so the two can never drift apart.
        owned_games: summary.owned_games || 0,
        not_owned_games: summary.not_owned_games || 0,
        owned_playtime_hours: summary.owned_playtime_hours || 0,
        not_owned_playtime_hours: summary.not_owned_playtime_hours || 0,
        // Replays. `times_played` is every run of every game, so
        // `times_played - total_games` is the number of replays logged, and
        // `all_playthroughs_hours` is first-run hours plus replay hours. All
        // three reconcile against the registry totals beside them by
        // construction, which is what lets a view label each figure honestly
        // instead of implying the legacy total already includes replays.
        times_played: summary.times_played || 0,
        replayed_games: summary.replayed_games || 0,
        most_times_played: summary.most_times_played || 1,
        replay_playtime_hours: replayTotals.total_hours || 0,
        replay_runs: replayTotals.total_runs || 0,
        all_playthroughs_hours:
          parseFloat(
            ((summary.total_playtime_hours || 0) + (replayTotals.total_hours || 0)).toFixed(1)
          ),
      },
      mostReplayed: mostReplayed ?? null,
      genreAnalytics,
      recentActivity,
    });
  } catch (err) {
    console.error("GET /api/analytics error:", err);
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

// ── IMPORT ────────────────────────────────────────────────────────

apiRouter.post("/import", (req: Request, res: Response) => {
  try {
    const parsedPayload = ImportSchema.safeParse(req.body);
    if (!parsedPayload.success) return res.status(400).json({ error: "Invalid import data format" });
    const rows = parsedPayload.data.games;
    if (!rows.length) return res.status(400).json({ error: "No games found in import data" });

    const capped = rows.slice(0, MAX_IMPORT_ROWS);
    let imported = 0;
    let skipped = 0;
    let duplicates = 0;

    // Dedupe against existing rows: by igdb_id, then steam_appid, then title.
    const existingByIgdb = new Map<number, number>();
    const existingBySteam = new Map<number, number>();
    const existingByTitle = new Map<string, number>();
    for (const row of stmts.getAllGames.all() as { id: number; igdb_id: number | null; steam_appid: number | null; title: string }[]) {
      if (row.igdb_id != null) existingByIgdb.set(row.igdb_id, row.id);
      if (row.steam_appid != null) existingBySteam.set(row.steam_appid, row.id);
      existingByTitle.set(String(row.title || "").toLowerCase(), row.id);
    }
    const seenInBatch = new Set<string>();

    /**
     * A row is a duplicate if ANY of its keys is already claimed — not just the
     * first one present. This used to return on the first non-null key, so a row
     * carrying a *new* igdb_id alongside an *existing* steam_appid sailed past
     * the check and then tripped the partial unique index on steam_appid inside
     * the insert. That aborted the entire transaction, so one bad row silently
     * discarded the whole batch and the caller got a 500 that looked like a
     * server crash. The keys are independent unique constraints in the schema, so
     * they have to be checked independently here.
     */
    const isDuplicate = (data: z.infer<typeof GameSchema>) => {
      if (data.igdb_id != null && (existingByIgdb.has(data.igdb_id) || seenInBatch.has(`i:${data.igdb_id}`))) {
        return true;
      }
      if (data.steam_appid != null && (existingBySteam.has(data.steam_appid) || seenInBatch.has(`s:${data.steam_appid}`))) {
        return true;
      }
      const titleKey = data.title.toLowerCase();
      return existingByTitle.has(titleKey) || seenInBatch.has(`t:${titleKey}`);
    };

    /* Declared as its own transaction so better-sqlite3 compiles it to a
       SAVEPOINT when called from inside `insertMany`. That is what makes a
       single rejected row survivable: the rollback unwinds to the start of that
       row, not to the start of the batch. Returns the new id so a row's
       playthroughs can be attached to it — see insertPlaythroughs below. */
    const insertOne = db.transaction((row: Record<string, unknown>) => {
      return stmts.insertGame.run(row).lastInsertRowid;
    });

    const insertMany = db.transaction((items: any[]) => {
      for (const row of items) {
        const parsed = GameSchema.safeParse(row);
        if (!parsed.success) { skipped++; continue; }

        const data = parsed.data;
        if (isDuplicate(data)) { duplicates++; skipped++; continue; }

        if (data.igdb_id != null) seenInBatch.add(`i:${data.igdb_id}`);
        if (data.steam_appid != null) seenInBatch.add(`s:${data.steam_appid}`);
        seenInBatch.add(`t:${data.title.toLowerCase()}`);

        const now = Date.now();
        /* Per-row savepoint. `isDuplicate` above now catches every unique-key
           collision it can see, but the partial unique indexes on igdb_id and
           steam_appid are the database's own last line of defence, and a
           violation here used to abort the whole transaction — silently
           discarding an entire import batch and answering with a 500 that is
           indistinguishable from a crash. A nested `db.transaction` becomes a
           SAVEPOINT, so one bad row rolls back to just before itself and the
           rest of the batch commits. */
        try {
          const newGameId = insertOne({
            title: data.title,
            year: data.year ?? null,
            igdb_id: data.igdb_id ?? null,
            genres: JSON.stringify(data.genres),
            synopsis: data.synopsis,
            poster_url: data.poster_url,
            critic_score: data.critic_score ?? null,
            ownership_status: resolveOwnershipStatus(data.ownership_status),
            owned_platforms: resolveOwnedPlatforms(
              resolveOwnershipStatus(data.ownership_status),
              data.owned_platforms
            ),
            status: data.status,
            playtime: data.playtime,
            personal_rating: data.personal_rating ?? null,
            date_added: data.date_added ?? now,
            date_completed: data.date_completed ?? (data.status === "completed" ? now : null),
            created_at: data.created_at ?? now,
            updated_at: data.updated_at ?? now,
            hide_playtime: data.hide_playtime ?? 0,
            steam_appid: data.steam_appid ?? null,
            custom_order: null,
            metadata_custom: data.metadata_custom ?? 0,
          });

          /* Replays nested on the exported game, restored in order. Read from the
             RAW row, not the parsed one: GameSchema is not strict, so zod strips
             the unrecognised `playthroughs` key and reading it off `data` would
             always yield undefined — the backup would round-trip the games and
             silently drop every playthrough in it. Each run is validated
             independently and a malformed one is skipped rather than failing the
             game, because losing a replay is recoverable and losing the game's
             playtime is not. */
          const rawRuns = (row as Record<string, unknown>).playthroughs;
          if (Array.isArray(rawRuns)) {
            const now = Date.now();
            let seq = 2;
            for (const raw of rawRuns.slice(0, MAX_REPLAYS_PER_GAME)) {
              const run = PlaythroughSchema.safeParse(raw);
              if (!run.success) continue;
              const r = run.data;
              stmts.insertPlaythrough.run({
                game_id: newGameId,
                sequence: seq++,
                status: r.status,
                playtime: r.playtime ?? 0,
                personal_rating: r.personal_rating ?? null,
                date_completed: r.date_completed ?? null,
                platform: r.platform ? r.platform : null,
                notes: r.notes ?? "",
                created_at: now,
                updated_at: now,
              });
            }
            syncReplayTotals(Number(newGameId));
          }

          imported++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/UNIQUE constraint failed/i.test(message)) {
            duplicates++;
            skipped++;
            continue;
          }
          throw err;
        }
      }
    });

    insertMany(capped);

    res.json({
      success: true,
      imported,
      skipped,
      duplicates,
      truncated: rows.length > MAX_IMPORT_ROWS,
    });
  } catch (err) {
    console.error("POST /api/import error:", err);
    res.status(500).json({ error: "Import failed" });
  }
});

// ── STEAM SYNC ────────────────────────────────────────────────────

const SteamSettingsSchema = z.object({
  apiKey: z.string().trim().min(1).max(100).optional(),
  profile: z.string().trim().min(1).max(200),
}).strip();

function getSteamSettings() {
  const row = stmts.getSettings.get("steam_sync") as any;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function saveSteamSettings(value: Record<string, unknown>) {
  stmts.upsertSettings.run("steam_sync", JSON.stringify(value));
}

// GET /api/settings/steam — never returns the raw API key to the client
apiRouter.get("/settings/steam", (_req: Request, res: Response) => {
  try {
    const settings = getSteamSettings() || {};
    const keySet = Boolean(effectiveSteamApiKey(settings.apiKey));
    res.json({
      keySet,
      envKeyConfigured: Boolean((process.env.STEAM_WEB_API_KEY || "").trim()),
      profile: settings.profile || "",
      steamId: settings.steamId || null,
      steamName: settings.steamName || null,
      avatarUrl: settings.avatarUrl || null,
      lastSync: settings.lastSync || null,
    });
  } catch (err) {
    console.error("GET /api/settings/steam error:", err);
    res.status(500).json({ error: "Failed to fetch Steam settings" });
  }
});

// PUT /api/settings/steam — links a profile; the API key is optional when
// STEAM_WEB_API_KEY is set in the server .env (key stays backend-only)
apiRouter.put("/settings/steam", async (req: Request, res: Response) => {
  try {
    const parsed = SteamSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Steam profile is required." });
    }
    const { apiKey, profile } = parsed.data;

    const key = effectiveSteamApiKey(apiKey);
    if (!key) {
      return res.status(400).json({
        error: "No Steam API key configured. Set STEAM_WEB_API_KEY in .env on the server.",
      });
    }

    const steamId = await resolveSteamId(key, profile);
    const summary = await fetchPlayerSummary(key, steamId);

    const prev = getSteamSettings() || {};
    const next = {
      ...(process.env.STEAM_WEB_API_KEY ? { apiKey: undefined } : { apiKey: key }),
      profile: profile.trim(),
      steamId,
      steamName: summary.personaName,
      avatarUrl: summary.avatarUrl,
      lastSync: prev.lastSync ?? null,
    };
    saveSteamSettings(next);

    res.json({
      keySet: true,
      profile: next.profile,
      steamId,
      steamName: summary.personaName,
      avatarUrl: summary.avatarUrl,
      lastSync: next.lastSync,
    });
  } catch (err: unknown) {
    console.error("PUT /api/settings/steam error:", err instanceof Error ? err.message : err);
    // User-facing validation errors are "check your URL" problems; anything
    // else (timeouts, Steam/IGDB outages) is a server-side failure.
    if (err instanceof SteamUserError) {
      return res.status(400).json({ error: err.message });
    }
    res.status(502).json({ error: "Failed to connect Steam account. Try again shortly." });
  }
});

// ── Custom platform tags ────────────────────────────────────────────
// User-defined ownership tags ("Ubisoft Connect", "Arcade"...) shown next
// to the built-in platforms in the game platform checklists. Stored as a
// JSON array of { id, label } in the settings table.

const CUSTOM_PLATFORMS_LIMIT = 20;

function getCustomPlatformsSettings(): { id: string; label: string }[] {
  const row = stmts.getSettings.get("custom_platforms") as any;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCustomPlatformsSettings(platforms: { id: string; label: string }[]) {
  stmts.upsertSettings.run("custom_platforms", JSON.stringify(platforms));
}

// GET /api/settings/platforms — the current custom tags
apiRouter.get("/settings/platforms", (_req: Request, res: Response) => {
  try {
    res.json({ platforms: getCustomPlatformsSettings() });
  } catch (err) {
    console.error("GET /api/settings/platforms error:", err);
    res.status(500).json({ error: "Failed to fetch custom platforms" });
  }
});

// PUT /api/settings/platforms — replaces the full list of custom tags
apiRouter.put("/settings/platforms", (req: Request, res: Response) => {
  try {
    const parsed = PlatformSettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid platforms data", details: parsed.error.flatten().fieldErrors });
    const body = parsed.data.platforms;
    const seen = new Set<string>();
    const custom: { id: string; label: string }[] = [];
    for (const entry of body.slice(0, CUSTOM_PLATFORMS_LIMIT)) {
      const label = typeof entry?.label === "string" ? entry.label.trim().slice(0, 40) : "";
      const id = typeof entry?.id === "string" ? entry.id.trim().toLowerCase().slice(0, 40) : "";
      if (!label || !id || seen.has(id)) continue;
      if ([...AVAILABLE_PLATFORMS].some((p) => p.id.toLowerCase() === id || p.label.toLowerCase() === label.toLowerCase())) continue;
      seen.add(id);
      custom.push({ id, label });
    }
    saveCustomPlatformsSettings(custom);
    res.json({ platforms: custom });
  } catch (err) {
    console.error("PUT /api/settings/platforms error:", err);
    res.status(500).json({ error: "Failed to save custom platforms" });
  }
});

const CustomizationsSchema = z.object({
  theme: z.enum(["noir", "crimson", "paper", "arctic"]).default("noir"),
  libraryColumns: z.number().int().min(3).max(7).default(5),
  discoverColumns: z.number().int().min(3).max(7).default(6),
  showPlaytimeBadge: z.boolean().default(true),
  showRatingBadge: z.boolean().default(true),
  // Defaults to true, so a preferences row written before this field existed
  // parses unchanged and the hint is still offered to readers who never saw it.
  showShortcutHint: z.boolean().default(true),
  // Same reasoning: rows predating the toggle keep the behaviour they had.
  autoSteamSync: z.boolean().default(true),
});

// GET /api/settings/customizations — persisted UI preferences.
apiRouter.get("/settings/customizations", (_req: Request, res: Response) => {
  try {
    const row = stmts.getSettings.get("customizations") as { value: string } | undefined;
    if (!row) return res.json(CustomizationsSchema.parse({}));
    const parsed = JSON.parse(row.value);
    res.json(CustomizationsSchema.parse(parsed));
  } catch (err) {
    console.error("GET /api/settings/customizations error:", err);
    res.status(500).json({ error: "Failed to read customization settings" });
  }
});

// PUT /api/settings/customizations — replace the validated preference set.
apiRouter.put("/settings/customizations", (req: Request, res: Response) => {
  try {
    const parsed = CustomizationsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid customization settings" });
    stmts.upsertSettings.run("customizations", JSON.stringify(parsed.data));
    res.json(parsed.data);
  } catch (err) {
    console.error("PUT /api/settings/customizations error:", err);
    res.status(500).json({ error: "Failed to save customization settings" });
  }
});

// POST /api/sync/steam — pull owned games, enrich via IGDB, import/update
// A single sync may run at a time; concurrent requests (double-clicks, tabs)
// get a 409 instead of racing on the same rows.
let syncInProgress = false;

/**
 * Core Steam sync logic behind the manual sync HTTP route.
 * Returns a result summary or throws on failure.
 */
export async function runSteamSyncInternal(): Promise<{
  ok: boolean;
  total: number;
  gamesImported: number;
  excludedApps: number;
  imported: number;
  updated: number;
  adopted: number;
  unmatchedCount: number;
  lookupFailures: number;
  lastSync: number;
}> {
  if (syncInProgress) {
    throw new Error("A Steam sync is already running. Wait for it to finish.");
  }
  syncInProgress = true;
  try {
    const settings = getSteamSettings();
    const key = effectiveSteamApiKey(settings?.apiKey);
    if (!key || !settings?.steamId) {
      throw new SteamUserError("Steam account is not connected. Link your profile first.");
    }

    const ownedGames = await fetchOwnedGames(key, settings.steamId);
    if (!ownedGames.length) {
      // Persist the timestamp even with nothing to import, so the UI's
      // "Last sync" doesn't show a stale value after an empty pull.
      const freshSettings = getSteamSettings() || {};
      saveSteamSettings({ ...freshSettings, lastSync: Date.now() });
      return { ok: true, total: 0, gamesImported: 0, excludedApps: 0, imported: 0, updated: 0, adopted: 0, unmatchedCount: 0, lookupFailures: 0, lastSync: Date.now() };
    }

    const igdbMatches = await matchSteamToIgdb(ownedGames.map((g) => ({ appid: g.appid, name: g.name })));

    const excludedAppids = new Set<number>();
    // Upfront check for known software/tools
    for (const g of ownedGames) {
      if (isNonGameApp(g.appid, g.name)) {
        excludedAppids.add(g.appid);
      }
    }

    const detailsByAppid = new Map<number, any>();
    const detailLookupFailures: { appid: number; name: string }[] = [];
    const unmatchedForDetails = ownedGames.filter((g) => !igdbMatches.has(g.appid) && !excludedAppids.has(g.appid));
    await mapWithLimit(unmatchedForDetails, 5, async (g) => {
      try {
        const details = await fetchSteamAppDetails(g.appid);
        if (!details) {
          // Authoritative not-found on the Steam Store — safe to exclude
          // (renamed apps, delisted software, weird items).
          excludedAppids.add(g.appid);
          return;
        }
        if (isNonGameApp(g.appid, g.name, details)) {
          // Software, DLC, music, tools, utilities — don't pollute the library.
          excludedAppids.add(g.appid);
          return;
        }
        detailsByAppid.set(g.appid, details);
      } catch (err) {
        // Network/server failure — treat as "unknown", never "not a game".
        // Excluding here would wipe real library rows on a flaky network.
        console.warn(`Steam Store lookup failed for app ${g.appid} ("${g.name}"):`, err);
        detailLookupFailures.push({ appid: g.appid, name: g.name });
      }
    });

    const getBySteamAppid = db.prepare("SELECT * FROM games WHERE steam_appid = ?");
    const getByTitle = db.prepare("SELECT id, owned_platforms, ownership_status, playtime FROM games WHERE steam_appid IS NULL AND lower(title) = lower(?)");
    /* Junk removal matches on steam_appid ALONE.

       This used to be `(steam_appid = ? OR lower(title) = lower(?))`. The title
       disjunct matched *any* library row whose title case-insensitively equalled
       the Steam app's raw name — not the row Steam was actually claiming.
       `excludedAppids` is populated from DLC, soundtrack and software entries
       (and from store lookups that 404), whose names are exactly the sort of
       thing a real game shares: a title colliding with any of them was deleted
       outright, by an automatic operation the user never ran and was never
       shown.

       The guards narrowed it to rows with no rating and no uploaded poster, but
       they do not consult `ownership_status`, `hide_playtime`, `custom_order`,
       playtime, or — the worst of it — the `playthroughs` history, which
       `ON DELETE CASCADE` destroyed with the parent. Someone who had logged five
       runs of such a game lost all five on the next sync, unrecoverably.

       A title is not an identity. Only the appid is, and only the appid is what
       Steam asserted about this row. */
    const delExcluded = db.prepare(
      "DELETE FROM games WHERE steam_appid = ? AND personal_rating IS NULL AND poster_url NOT LIKE '/posters/%'"
    );

    if (excludedAppids.size) {
      const deleteJunk = db.transaction(() => {
        for (const g of ownedGames) {
          if (!excludedAppids.has(g.appid)) continue;
          delExcluded.run(g.appid);
        }
      });
      deleteJunk();
    }

    const adoptSteamAppid = db.prepare("UPDATE games SET steam_appid = ?, playtime = ?, owned_platforms = ?, updated_at = ? WHERE id = ?");

    let imported = 0;
    let updated = 0;
    let adopted = 0;
    const unmatched: { appid: number; name: string }[] = [];

    const syncOne = db.transaction((game: any) => {
      const existing = getBySteamAppid.get(game.steam_appid) as any;
      if (existing) {
        // A row counts as user-customized when it was explicitly flagged (any
        // metadata edit via PUT), when the user rated it, or when its poster
        // differs from the default Steam artwork for that appid (custom upload
        // or custom URL). Customized rows keep their metadata; everything else
        // refreshes from IGDB — and always uses the Steam poster, never RAWG's.
        const existingPoster = String(existing.poster_url || "");
        const defaultPoster = getSteamPosterImage(game.steam_appid);
        const hasCustomPoster = existingPoster !== "" && existingPoster !== defaultPoster;
        const preserve =
          existing.metadata_custom === 1 ||
          existing.personal_rating !== null ||
          hasCustomPoster;
        const nextPlay = Number(game.playtime) || 0;
        stmts.updateGame.run({
          title: preserve ? existing.title : game.title,
          year: preserve ? existing.year : (game.year ?? existing.year),
          igdb_id: preserve ? existing.igdb_id : (game.igdb_id ?? existing.igdb_id),
          genres: JSON.stringify(preserve ? safeJsonParse(existing.genres, []) : game.genres),
          synopsis: preserve ? existing.synopsis : game.synopsis,
          poster_url: preserve ? existing.poster_url : defaultPoster,
          critic_score: preserve ? existing.critic_score : (game.critic_score ?? existing.critic_score),
          // Preserved, not refreshed from the sync: a Steam sync only ever sees
          // the user's own Steam library, so re-deriving ownership from it would
          // silently claim a not-owned title as theirs. The flag only moves when
          // the user moves it — and it gates the platform list below, so the two
          // stay consistent even though only the second is being written.
          ownership_status: resolveOwnershipStatus(existing.ownership_status),
          /* UNION, not replace. `game.owned_platforms` is the constant ["steam"]
             that buildSyncedGame attaches to every synced row, so writing it
             directly collapsed the column to exactly ["steam"] on every sync: a
             title owned on PlayStation *and* Steam silently lost the PlayStation
             tag, and any custom tag from PUT /api/settings/platforms was
             destroyed for good, by an operation the user never explicitly ran.
             The adoption path further down already unions, so the two writes to
             the same column during one sync had opposite semantics. A sync can
             only *add* evidence that a platform exists; it can never retract a
             tag the user or another sync put there. */
          owned_platforms: resolveOwnedPlatforms(
            resolveOwnershipStatus(existing.ownership_status),
            mergePlatformTags(safeJsonParse(existing.owned_platforms, []), game.owned_platforms)
          ),
          status: existing.status,
          playtime: nextPlay,
          personal_rating: existing.personal_rating,
          date_added: existing.date_added,
          date_completed: existing.date_completed,
          hide_playtime: existing.hide_playtime,
          steam_appid: game.steam_appid,
          custom_order: existing.custom_order,
          metadata_custom: existing.metadata_custom ?? 0,
          updated_at: Date.now(),
          id: existing.id,
        });
        updated++;
        return;
      }

      const titleMatch = getByTitle.get(game.title) as any;
      if (titleMatch) {
        // `adoptSteamAppid` deliberately never touches ownership_status: the row
        // being adopted into may be one the user marked not-owned (they played
        // the Steam copy at a friend's house), and attaching the appid is about
        // identifying the title, not about claiming it. Only the flag's owner —
        // the user — moves it.
        //
        // The union below is skipped entirely for such a row, not just filtered
        // afterwards: a not-owned title has no platforms by definition, and this
        // is the one write path that would otherwise hand it a "steam" tag from a
        // sync the user never asked to claim the game through.
        const titleOwnership = resolveOwnershipStatus(titleMatch.ownership_status);
        const mergedPlatforms = new Set<string>([
          ...safeJsonParse(titleMatch.owned_platforms, []),
          ...game.owned_platforms,
        ]);
        const nextPlay = Number(game.playtime) || 0;
        adoptSteamAppid.run(
          game.steam_appid,
          nextPlay,
          resolveOwnedPlatforms(titleOwnership, [...mergedPlatforms]),
          Date.now(),
          titleMatch.id
        );
        adopted++;
        return;
      }

      const now = Date.now();
      stmts.insertGame.run({
        title: game.title,
        year: game.year ?? null,
        igdb_id: game.igdb_id ?? null,
        genres: JSON.stringify(game.genres),
        synopsis: game.synopsis,
        poster_url: game.poster_url,
        critic_score: game.critic_score ?? null,
        // New rows from a Steam sync are in the user's own Steam library, so
        // they are owned by definition.
        ownership_status: "owned",
        owned_platforms: resolveOwnedPlatforms("owned", game.owned_platforms),
        status: "backlog",
        playtime: game.playtime,
        personal_rating: null,
        date_added: now,
        date_completed: null,
        created_at: now,
        updated_at: now,
        hide_playtime: 0,
        steam_appid: game.steam_appid,
        custom_order: null,
        metadata_custom: 0,
      });
      imported++;
    });

    const storeNow = Date.now();
    const syncAll = db.transaction((games: any[]) => {
      for (const g of games) syncOne(g);
      // Re-read settings inside the transaction: never clobber a profile
      // link that happened while a long sync was in flight.
      const freshSettings = getSteamSettings() || {};
      saveSteamSettings({ ...freshSettings, lastSync: storeNow });
    });

    const syncedGames = ownedGames
      .filter((g) => !excludedAppids.has(g.appid))
      .map((g) => {
        const igdb = igdbMatches.get(g.appid);
        if (!igdb) unmatched.push({ appid: g.appid, name: g.name });
        return buildSyncedGame(g, igdb, detailsByAppid.get(g.appid));
      });

    syncAll(syncedGames);

    return {
      ok: true,
      total: ownedGames.length,
      gamesImported: syncedGames.length,
      excludedApps: excludedAppids.size,
      imported,
      updated,
      adopted,
      unmatchedCount: unmatched.length,
      lookupFailures: detailLookupFailures.length,
      lastSync: storeNow,
    };
  } finally {
    syncInProgress = false;
  }
}

apiRouter.post("/sync/steam", async (_req: Request, res: Response) => {
  try {
    const result = await runSteamSyncInternal();
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof SteamUserError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof SteamNetworkError) {
      return res.status(503).json({ error: err.message });
    }
    if (err instanceof Error && err.message?.includes("already running")) {
      return res.status(409).json({ error: err.message });
    }
    console.error("POST /api/sync/steam error:", err);
    res.status(500).json({ error: "Steam sync failed. Check the server logs for details." });
  }
});

// ── WIPE ──────────────────────────────────────────────────────────

apiRouter.delete("/wipe", (_req: Request, res: Response) => {
  if (syncInProgress) {
    return res.status(409).json({ error: "A Steam sync is running. Try again once it finishes." });
  }
  try {
    const wipe = db.transaction(() => {
      stmts.deleteAllGames.run();
    });
    wipe();
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/wipe error:", err);
    res.status(500).json({ error: "Wipe failed" });
  }
});

// ── CUSTOM POSTER UPLOAD ──────────────────────────────────────────

apiRouter.post("/upload-poster", (req: Request, res: Response) => {
  try {
    const parsed = UploadPosterSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid image data", details: parsed.error.flatten().fieldErrors });
    const { dataUrl } = parsed.data;

    const match = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
    if (!match || !match[2]) {
      return res.status(400).json({ error: "Unsupported image format" });
    }

    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length < 8) {
      return res.status(400).json({ error: "Image is empty or corrupted" });
    }
    if (buffer.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: "Image too large (max 2MB)" });
    }

    // Magic-byte validation — the data:image/ prefix and base64 regex can be
    // spoofed, but the actual file signature cannot. Rejects HTML/text payloads
    // that smuggle an image-like header.
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isWebp = buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
      buffer.subarray(8, 12).toString("latin1") === "WEBP";
    if (!isPng && !isJpeg && !isWebp) {
      return res.status(400).json({ error: "File is not a valid PNG, JPEG, or WebP image" });
    }

    if (!fs.existsSync(POSTERS_DIR)) {
      fs.mkdirSync(POSTERS_DIR, { recursive: true, mode: 0o700 });
    }

    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    // Full UUID, not an 8-hex-char slice. The slice was 32 bits, which combined with
  // the known `Date.now()` prefix made the whole upload directory brute-forceable
  // by anyone who could reach `/posters` — and since `/posters` cannot be gated
  // (an `<img src>` cannot send a bearer token), filename entropy is what stands
  // between an uploaded poster and a stranger. 122 bits instead of 32.
  const filename = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(POSTERS_DIR, filename), buffer, { mode: 0o600 });
    res.json({ url: `/posters/${filename}` });
  } catch (err: unknown) {
    console.error("POST /api/upload-poster error:", err);
    res.status(500).json({ error: "Failed to save poster" });
  }
});

// ── IGDB DISCOVER PROXY ───────────────────────────────────────────

apiRouter.get("/discover/game/:igdbId", async (req: Request, res: Response) => {
  try {
    const paramParsed = IgdbIdParamSchema.safeParse(req.params);
    if (!paramParsed.success) return res.status(400).json({ error: "Invalid Game ID" });
    const gId = paramParsed.data.igdbId;

    const query = `fields name, first_release_date, genres.name, summary, storyline, cover.image_id, rating, aggregated_rating, platforms.name, platforms.slug; where id = ${gId};`;
    const data = await cachedFetchFromIgdb("games", query, 60 * 60 * 1000);

    if (!Array.isArray(data) || data.length === 0) {
      return res.status(404).json({ error: "Game not found" });
    }

    res.json(mapIgdbGame(data[0]));
  } catch (error: unknown) {
    respondIgdbFailure(error, res, "Failed to fetch game details from IGDB");
  }
});

apiRouter.get("/discover/search", async (req: Request, res: Response) => {
  try {
    const parsed = SearchQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    const { q, page, genre } = parsed.data;
    if (!q.trim()) return res.json([]);

    const pageNum = Math.min(100, Math.max(1, parseInt(page.toString()) || 1));

    // One cached IGDB call builds the ranked, junk-free pool; genre filtering
    // and paging then happen in memory (IGDB rejects `search` + `where`).
    const pool = await getSearchPool(q);
    const genreNames = parseGenreParam(genre);
    const matching = genreNames.length
      ? pool.filter((game) =>
          game.genres.some((g) => genreNames.some((name) => name.toLowerCase() === g.toLowerCase()))
        )
      : pool;

    const startIndex = (pageNum - 1) * SEARCH_PAGE_SIZE;
    res.json(matching.slice(startIndex, startIndex + SEARCH_PAGE_SIZE));
  } catch (error: unknown) {
    respondIgdbFailure(error, res, "Failed to search games on IGDB");
  }
});

apiRouter.get("/discover/trending", async (req: Request, res: Response) => {
  try {
    const parsed = TrendingQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    const { page, limit, genre } = parsed.data;
    const pageNum = Math.min(100, Math.max(1, parseInt(page.toString()) || 1));
    const pageSize = Math.min(30, Math.max(1, parseInt(limit.toString()) || 15));

    // The pool is cached per genre selection, so the first request for a genre
    // pays one IGDB call and every page after it is served from memory.
    const pool = await getTrendingPool(parseGenreParam(genre));
    const startIndex = (pageNum - 1) * pageSize;
    res.json(pool.slice(startIndex, startIndex + pageSize));
  } catch (error: unknown) {
    respondIgdbFailure(error, res, "Failed to fetch trending games from IGDB");
  }
});

apiRouter.get("/discover/lists", async (_req: Request, res: Response) => {
  try {
    const lists = await fetchCuratedLists();
    res.json(lists);
  } catch (error: unknown) {
    respondIgdbFailure(error, res, "Failed to fetch curated lists from IGDB");
  }
});

// ── WISHLIST CRUD ────────────────────────────────────────────────

// GET /api/wishlist — games the user wants, newest first.
apiRouter.get("/wishlist", (_req: Request, res: Response) => {
  try {
    const rows = stmts.getAllWishlist.all();
    res.json(rows.map(parseWishlistItem));
  } catch (err) {
    console.error("GET /api/wishlist error:", err);
    res.status(500).json({ error: "Failed to fetch wishlist" });
  }
});

// POST /api/wishlist — add a game (usually an IGDB search hit) to the wishlist.
// Rejects duplicates by IGDB id and anything already sitting in the library.
apiRouter.post("/wishlist", (req: Request, res: Response) => {
  try {
    const parsed = WishlistSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid wishlist data", details: parsed.error.flatten().fieldErrors });
    }
    const w = parsed.data;

    if (w.igdb_id != null) {
      if (stmts.getGameByIgdbId.get(w.igdb_id)) {
        return res.status(409).json({ error: "This game already exists in your library." });
      }
      if (stmts.getWishlistByIgdbId.get(w.igdb_id)) {
        return res.status(409).json({ error: "This game is already on your wishlist." });
      }
    }

    const info = stmts.insertWishlist.run({
      igdb_id: w.igdb_id ?? null,
      title: w.title,
      year: w.year ?? null,
      genres: JSON.stringify(w.genres),
      synopsis: w.synopsis,
      poster_url: w.poster_url,
      critic_score: w.critic_score ?? null,
      owned_platforms: JSON.stringify(normalizePlatformIds(w.owned_platforms)),
      date_added: Date.now(),
    });
    const item = parseWishlistItem(stmts.getWishlistById.get(info.lastInsertRowid));
    res.status(201).json(item);
  } catch (err) {
    console.error("POST /api/wishlist error:", err);
    res.status(500).json({ error: "Failed to add wishlist item" });
  }
});

// DELETE /api/wishlist/:id — drop an item from the wishlist.
apiRouter.delete("/wishlist/:id", (req: Request, res: Response) => {
  try {
    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) return res.status(400).json({ error: "Invalid wishlist ID" });
    const itemId = paramParsed.data.id;

    const existing = stmts.getWishlistById.get(itemId);
    if (!existing) return res.status(404).json({ error: "Wishlist item not found" });

    stmts.deleteWishlistItem.run(itemId);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/wishlist/:id error:", err);
    res.status(500).json({ error: "Failed to remove wishlist item" });
  }
});

// POST /api/wishlist/bulk-delete — batch remove wishlist items
apiRouter.post("/wishlist/bulk-delete", (req: Request, res: Response) => {
  try {
    const parsed = BulkDeleteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid bulk delete payload", details: parsed.error.flatten().fieldErrors });
    const validIds = parsed.data.ids;
    const deleteBatch = db.transaction((idList: number[]) => {
      let count = 0;
      for (const id of idList) {
        const result = stmts.deleteWishlistItem.run(id);
        if (result.changes > 0) count++;
      }
      return count;
    });
    const deletedCount = deleteBatch(validIds);
    res.json({ ok: true, count: deletedCount });
  } catch (err) {
    console.error("POST /api/wishlist/bulk-delete error:", err);
    res.status(500).json({ error: "Failed to remove wishlist items" });
  }
});

// POST /api/wishlist/:id/own — promote a wishlist item into the library as a
// backlog entry (full metadata preserved), then drop it from the wishlist.
apiRouter.post("/wishlist/:id/own", (req: Request, res: Response) => {
  try {
    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) return res.status(400).json({ error: "Invalid wishlist ID" });
    const itemId = paramParsed.data.id;

    const item = parseWishlistItem(stmts.getWishlistById.get(itemId));
    if (!item) return res.status(404).json({ error: "Wishlist item not found" });

    if (item.igdb_id != null && stmts.getGameByIgdbId.get(item.igdb_id)) {
      return res.status(409).json({ error: "This game already exists in your library." });
    }

    const now = Date.now();
    const adopt = db.transaction(() => {
      const info = stmts.insertGame.run({
        title: item.title,
        year: item.year,
        igdb_id: item.igdb_id,
        genres: JSON.stringify(item.genres || []),
        synopsis: item.synopsis || "",
        poster_url: item.poster_url || "",
        critic_score: item.critic_score,
        // This endpoint *is* the "I own this now" action, so the promoted row is
        // always owned — never not_owned, regardless of what the wishlist entry
        // carried. Which means the wishlist's platform tags (where the game was
        // available to buy) transfer intact as ownership tags.
        ownership_status: "owned",
        owned_platforms: resolveOwnedPlatforms("owned", item.owned_platforms || []),
        status: "backlog",
        playtime: 0,
        personal_rating: null,
        date_added: now,
        date_completed: null,
        created_at: now,
        updated_at: now,
        hide_playtime: 0,
        steam_appid: null,
        custom_order: null,
        metadata_custom: 0,
      });
      stmts.deleteWishlistItem.run(itemId);
      return Number(info.lastInsertRowid);
    });

    const gameId = adopt();
    const game = parseGame(stmts.getGameById.get(gameId));
    res.json({ game });
  } catch (err) {
    console.error("POST /api/wishlist/:id/own error:", err);
    res.status(500).json({ error: "Failed to move game to library" });
  }
});

// ── DUPLICATES ──────────────────────────────────────────────────────
// Suspected duplicate library rows (same external id or same normalized
// title) with a merge action that folds the loser into the keeper.

const EDITION_SUFFIX_RE = /\s*[(\[][^)\]]*(goty|game of the year|definitive|remastered|remake|director'?s cut|enhanced|complete|ultimate|deluxe|anniversary|special|collector'?s|legendary|premium|classic)[^)\]]*[)\]]\s*$/i;

function duplicateKey(title: string): string {
  return title.toLowerCase().replace(EDITION_SUFFIX_RE, "").replace(/[^a-z0-9]+/g, "");
}

// GET /api/duplicates
apiRouter.get("/duplicates", (_req: Request, res: Response) => {
  try {
    const rows = db.prepare("SELECT id, title, year, igdb_id, steam_appid, status, playtime FROM games").all() as {
      id: number; title: string; year: number | null; igdb_id: number | null; steam_appid: number | null; status: string; playtime: number;
    }[];
    const groups = new Map<string, { reason: string; games: typeof rows }>();
    const push = (key: string, reason: string, row: (typeof rows)[number]) => {
      const g = groups.get(key) || { reason, games: [] };
      g.games.push(row);
      groups.set(key, g);
    };
    for (const row of rows) {
      if (row.igdb_id != null) push(`igdb:${row.igdb_id}`, "Same IGDB entry", row);
      if (row.steam_appid != null) push(`steam:${row.steam_appid}`, "Same Steam app", row);
      const key = duplicateKey(row.title || "");
      if (key) push(`title:${key}`, "Matching titles", row);
    }
    const result = [...groups.entries()]
      .filter(([, g]) => new Set(g.games.map((r) => r.id)).size > 1)
      .map(([key, g]) => {
        const seen = new Set<number>();
        const games = g.games.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
        return {
          key,
          reason: g.reason,
          games: games
            .sort((a, b) => a.id - b.id)
            .map((r) => ({ id: r.id, title: r.title, year: r.year, status: r.status, playtime: r.playtime })),
        };
      });
    const seenGroups = new Set<string>();
    res.json(result.filter((g) => {
      const idKey = g.games.map((x) => x.id).join(",");
      if (seenGroups.has(idKey)) return false;
      seenGroups.add(idKey);
      return true;
    }));
  } catch (err) {
    console.error("GET /api/duplicates error:", err);
    res.status(500).json({ error: "Failed to scan for duplicates" });
  }
});

const MergeSchema = z.object({ keepId: z.number().int().positive(), removeId: z.number().int().positive() });

// POST /api/duplicates/merge { keepId, removeId } — fold loser into keeper.
apiRouter.post("/duplicates/merge", (req: Request, res: Response) => {
  try {
    const parsed = MergeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "keepId and removeId are required" });
    const { keepId, removeId } = parsed.data;
    if (keepId === removeId) return res.status(400).json({ error: "Cannot merge a game into itself" });

    const keep = stmts.getGameById.get(keepId) as GameRow | undefined;
    const remove = stmts.getGameById.get(removeId) as GameRow | undefined;
    if (!keep || !remove) return res.status(404).json({ error: "One of the games was not found" });

    const union = (a: string, b: string): string[] => {
      const out = [...safeJsonParse(a, [])];
      for (const v of safeJsonParse(b, [])) if (!out.includes(v)) out.push(v);
      return out;
    };
    const merge = db.transaction(() => {
      stmts.updateGame.run({
        title: keep.title,
        year: keep.year ?? remove.year,
        igdb_id: keep.igdb_id ?? remove.igdb_id,
        genres: JSON.stringify(union(keep.genres, remove.genres)),
        synopsis: (keep.synopsis || "").length >= (remove.synopsis || "").length ? keep.synopsis : remove.synopsis,
        poster_url: (keep.poster_url || "").startsWith("/posters/")
          ? keep.poster_url
          : (remove.poster_url || "").startsWith("/posters/")
            ? remove.poster_url
            : (keep.poster_url || remove.poster_url),
        critic_score: keep.critic_score ?? remove.critic_score,
        // Keeper wins, matching every other single-valued column in this merge.
        // Falling back to the loser only matters for a row written before the
        // column existed, where `keep` could be undefined and `remove` not.
        ownership_status: resolveOwnershipStatus(keep.ownership_status ?? remove.ownership_status),
        owned_platforms: resolveOwnedPlatforms(
          resolveOwnershipStatus(keep.ownership_status ?? remove.ownership_status),
          union(keep.owned_platforms, remove.owned_platforms)
        ),
        status: keep.status,
        playtime: Math.max(keep.playtime || 0, remove.playtime || 0),
        personal_rating: keep.personal_rating ?? remove.personal_rating,
        date_added: Math.min(keep.date_added, remove.date_added),
        date_completed: keep.date_completed ?? remove.date_completed,
        hide_playtime: keep.hide_playtime || remove.hide_playtime,
        steam_appid: keep.steam_appid ?? remove.steam_appid,
        custom_order: keep.custom_order ?? remove.custom_order,
        metadata_custom: keep.metadata_custom || remove.metadata_custom,
        updated_at: Date.now(),
        id: keepId,
      });
      // The loser's replays are re-parented to the keeper, not cascaded away.
      // Folding two rows of the same game together is exactly the case where a
      // user has the most reason to have logged several runs, and ON DELETE
      // CASCADE would discard that history at the moment it becomes most
      // meaningful. Moving them keeps every playthrough in the merged game; the
      // game's own run #1 still resolves to the keeper's, so the loser
      // contributes its replays only.
      //
      // The keeper's ordinals are parked BEFORE the move: both rows number
      // their replays from 2, so re-parenting the loser's in would otherwise put
      // two rows on `UNIQUE (game_id, sequence)` and abort the whole merge with
      // a 409 — the user would be told the merge collided on an external ID
      // when nothing of the sort happened.
      parkSequences(keepId);
      stmts.movePlaythroughsToGame.run(keepId, Date.now(), removeId);
      resequencePlaythroughs(keepId);
      stmts.deleteGame.run(removeId);
      syncReplayTotals(keepId);
    });
    merge();
    res.json(parseGame(stmts.getGameById.get(keepId)));
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({ error: "Merge would collide with another game using the same external ID." });
    }
    console.error("POST /api/duplicates/merge error:", err);
    res.status(500).json({ error: "Merge failed" });
  }
});

// ── STORAGE ─────────────────────────────────────────────────────────
// Local footprint: database and posters — plus maintenance actions.

function dirSize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(dir)) return { files, bytes };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      bytes += fs.statSync(path.join(dir, entry.name)).size;
      files++;
    } catch {
      /* raced deletion — ignore */
    }
  }
  return { files, bytes };
}

// GET /api/storage
apiRouter.get("/storage", (_req: Request, res: Response) => {
  try {
    const sizeOf = (p: string) => { try { return fs.statSync(p).size; } catch { return 0; } };
    const posters = dirSize(POSTERS_DIR);
    res.json({
      dbSize: sizeOf(path.join(DATA_DIR, "gametrack.db")),
      walSize: sizeOf(path.join(DATA_DIR, "gametrack.db-wal")),
      gameCount: (db.prepare("SELECT COUNT(*) AS n FROM games").get() as { n: number }).n,
      posterCount: posters.files,
      posterSize: posters.bytes,
    });
  } catch (err) {
    console.error("GET /api/storage error:", err);
    res.status(500).json({ error: "Failed to read storage stats" });
  }
});

// POST /api/storage/checkpoint — fold the WAL back into the database file.
apiRouter.post("/storage/checkpoint", (_req: Request, res: Response) => {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/storage/checkpoint error:", err);
    res.status(500).json({ error: "Checkpoint failed" });
  }
});

// POST /api/storage/clean-posters — delete poster files no game references.
apiRouter.post("/storage/clean-posters", (_req: Request, res: Response) => {
  try {
    const used = new Set<string>();
    for (const row of stmts.getAllGames.all() as { poster_url: string }[]) {
      if (row.poster_url.startsWith("/posters/")) used.add(path.basename(row.poster_url));
    }
    for (const row of stmts.getAllWishlist.all() as { poster_url: string }[]) {
      if (row.poster_url.startsWith("/posters/")) used.add(path.basename(row.poster_url));
    }
    let removed = 0;
    let freedBytes = 0;
    if (fs.existsSync(POSTERS_DIR)) {
      for (const entry of fs.readdirSync(POSTERS_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || used.has(entry.name)) continue;
        try {
          const full = path.join(POSTERS_DIR, entry.name);
          freedBytes += fs.statSync(full).size;
          fs.rmSync(full, { force: true });
          removed++;
        } catch {
          /* raced deletion — ignore */
        }
      }
    }
    res.json({ success: true, removed, freedBytes });
  } catch (err) {
    console.error("POST /api/storage/clean-posters error:", err);
    res.status(500).json({ error: "Poster cleanup failed" });
  }
});
