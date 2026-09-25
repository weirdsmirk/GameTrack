import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import Database from "better-sqlite3";
import db from "./db";
import { z } from "zod";
import { normalizePlatformIds, AVAILABLE_PLATFORMS } from "../src/constants";
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

/** Parse JSON text columns defensively — a single corrupt row must never
 *  abort a whole transaction. */
function safeJsonParse<T = unknown>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return (parsed === null || typeof parsed !== "object" ? fallback : parsed) as T;
  } catch {
    return fallback;
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE constraint failed");
}

const logPlaytimeInsert = db.prepare(
  "INSERT INTO playtime_entries (game_id, hours, logged_at) VALUES (?, ?, ?)"
);

/** Record a playtime increase. Never fabricates sessions for existing totals. */
function logPlaytimeDelta(gameId: number, hours: number, loggedAt: number): void {
  if (hours < 0.01) return;
  logPlaytimeInsert.run(gameId, hours, loggedAt);
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
  owned_platforms: string; status: string; playtime: number; personal_rating: number | null;
  date_added: number; date_completed: number | null; created_at: number; updated_at: number;
  hide_playtime: number; steam_appid: number | null; custom_order: number | null;
  metadata_custom: number;
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
  const genres = safeJsonParse<string[]>(r.genres, []);
  const owned_platforms = safeJsonParse<string[]>(r.owned_platforms, []);
  return { ...r, genres, owned_platforms } as Game;
}

function parseWishlistItem(row: unknown): WishlistItem | null {
  if (!row) return null;
  const r = row as WishlistRow;
  const genres = safeJsonParse<string[]>(r.genres, []);
  const owned_platforms = safeJsonParse<string[]>(r.owned_platforms, []);
  return { ...r, genres, owned_platforms } as WishlistItem;
}

// ── Zod validation schemas ────────────────────────────────────────
const VALID_STATUSES = ["backlog", "playing", "completed", "endless"] as const;

const GameSchema = z.object({
  title: z.string().trim().min(1).max(300),
  status: z.enum(VALID_STATUSES).default("backlog"),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  igdb_id: z.number().int().nullable().optional(),
  genres: z.array(z.string().max(100)).max(50).optional().default([]),
  synopsis: z.string().max(10_000).optional().default(""),
  poster_url: z.string().max(2000).refine(val => val === "" || val.startsWith("http://") || val.startsWith("https://") || val.startsWith("/"), {
    message: "Must be an http(s) URL or a local poster path"
  }).optional().default(""),
  critic_score: z.number().int().min(0).max(100).nullable().optional(),
  owned_platforms: z.array(z.string().max(100)).max(50).optional().default([]),
  playtime: z.number().min(0).max(100_000).optional().default(0),
  personal_rating: z.number().int().min(0).max(10).nullable().optional(),
  date_added: z.number().optional(),
  date_completed: z.number().nullable().optional(),
  created_at: z.number().optional(),
  updated_at: z.number().optional(),
  hide_playtime: z.number().int().min(0).max(1).optional(),
  steam_appid: z.number().int().nullable().optional(),
  custom_order: z.number().int().min(0).nullable().optional(),
  metadata_custom: z.number().int().min(0).max(1).optional(),
});

// For PATCH updates — all fields optional except partial must have at least one
const GameUpdateSchema = GameSchema.partial();

export type Game = z.infer<typeof GameSchema> & { id: number };

const WishlistSchema = z.object({
  title: z.string().trim().min(1).max(300),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  igdb_id: z.number().int().nullable().optional(),
  genres: z.array(z.string().max(100)).max(50).optional().default([]),
  synopsis: z.string().max(10_000).optional().default(""),
  poster_url: z.string().max(2000).refine(val => val === "" || val.startsWith("http://") || val.startsWith("https://") || val.startsWith("/"), {
    message: "Must be an http(s) URL or a local poster path"
  }).optional().default(""),
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


// ── Prepared Statements ───────────────────────────────────────────

const stmts = {
  getAllGames: db.prepare("SELECT * FROM games ORDER BY date_added DESC"),
  getGameById: db.prepare("SELECT * FROM games WHERE id = ?"),
  getGameByIgdbId: db.prepare("SELECT id FROM games WHERE igdb_id = ?"),
  insertGame: db.prepare(`
    INSERT INTO games (title, year, igdb_id, genres, synopsis, poster_url, critic_score,
      owned_platforms, status, playtime, personal_rating, date_added, date_completed,
      created_at, updated_at, hide_playtime, steam_appid, custom_order, metadata_custom)
    VALUES (@title, @year, @igdb_id, @genres, @synopsis, @poster_url, @critic_score,
      @owned_platforms, @status, @playtime, @personal_rating, @date_added,
      @date_completed, @created_at, @updated_at, @hide_playtime, @steam_appid, @custom_order,
      @metadata_custom)
  `),
  updateGame: db.prepare(`
    UPDATE games SET title = @title, year = @year, igdb_id = @igdb_id, genres = @genres,
      synopsis = @synopsis, poster_url = @poster_url, critic_score = @critic_score,
      owned_platforms = @owned_platforms, status = @status, playtime = @playtime,
      personal_rating = @personal_rating, date_added = @date_added,
      date_completed = @date_completed, hide_playtime = @hide_playtime,
      updated_at = @updated_at, steam_appid = @steam_appid, custom_order = @custom_order,
      metadata_custom = @metadata_custom
    WHERE id = @id
  `),
  deleteGame: db.prepare("DELETE FROM games WHERE id = ?"),
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
};

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
    const payload = JSON.stringify(rows.map(parseGame), null, 2);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="gametrack-library-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(payload);
  } catch (err) {
    console.error("GET /api/export error:", err);
    res.status(500).json({ error: "Failed to export library" });
  }
});

// GET /api/export/db — raw SQLite database file as a backup. Unlike the JSON
// export this is a byte-exact snapshot: `db.backup()` runs a WAL-aware online
// backup, so the download stays consistent even while a sync is writing.
apiRouter.get("/export/db", async (_req: Request, res: Response) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const tmpPath = path.join(DATA_DIR, `.backup-${process.pid}-${Date.now()}-${crypto.randomUUID()}.db`);
  try {
    await db.backup(tmpPath);
    // The snapshot is a full copy of the DB — strip the stored Steam API key
    // before it leaves the process (see scrubSecretsFromSnapshot).
    scrubSecretsFromSnapshot(tmpPath);
    // Read the snapshot into memory and delete the temp file up front — the
    // library DB is small (local single-user app), and sending a buffer avoids
    // any temp-file/stream lifecycle races with the response.
    const snapshot = fs.readFileSync(tmpPath);
    fs.rmSync(tmpPath, { force: true });
    res.setHeader("Content-Type", "application/vnd.sqlite3");
    res.setHeader("Content-Disposition", `attachment; filename="gametrack-backup-${stamp}.db"`);
    res.setHeader("Content-Length", snapshot.length);
    res.send(snapshot);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    console.error("GET /api/export/db error:", err);
    res.status(500).json({ error: "Failed to export database" });
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
      owned_platforms: JSON.stringify(normalizePlatformIds(g.owned_platforms)),
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

    // User-raised playtime is a played session — log it for history.
    // Steam-sync writes bypass PUT and are never logged (bulk
    // corrections, not sessions).
    const playDelta =
      sent("playtime") && typeof g.playtime === "number"
        ? Math.round((g.playtime - (existing.playtime || 0)) * 100) / 100
        : 0;

    const apply = db.transaction(() => {
      if (playDelta >= 0.01) logPlaytimeDelta(gameId, playDelta, now);
      stmts.updateGame.run({
      title: g.title ?? existing.title,
      year: g.year !== undefined ? g.year : existing.year,
      igdb_id: g.igdb_id !== undefined ? g.igdb_id : existing.igdb_id,
      genres: JSON.stringify(sent("genres") ? g.genres : safeJsonParse(existing.genres, [])),
      synopsis: sent("synopsis") ? g.synopsis : existing.synopsis,
      poster_url: sent("poster_url") ? g.poster_url : existing.poster_url,
      critic_score: g.critic_score !== undefined ? g.critic_score : existing.critic_score,
      owned_platforms: JSON.stringify(normalizePlatformIds(sent("owned_platforms") ? g.owned_platforms : safeJsonParse(existing.owned_platforms, []))),
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

    stmts.updateGame.run({
      title: mapped.title,
      year: mapped.year,
      igdb_id: existing.igdb_id,
      genres: JSON.stringify(mapped.genres),
      synopsis: mapped.synopsis,
      poster_url: poster,
      critic_score: mapped.critic_score,
      owned_platforms: existing.owned_platforms,
      status: existing.status,
      playtime: existing.playtime,
      personal_rating: existing.personal_rating,
      date_added: existing.date_added,
      date_completed: existing.date_completed,
      hide_playtime: existing.hide_playtime,
      steam_appid: existing.steam_appid,
      custom_order: existing.custom_order,
      metadata_custom: 0,
      updated_at: Date.now(),
      id: existing.id,
    });
    res.json(parseGame(stmts.getGameById.get(gameId)));
  } catch (err) {
    respondIgdbFailure(err, res, "Failed to reset metadata");
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

// ── ANALYTICS ─────────────────────────────────────────────────────

apiRouter.get("/analytics", (_req: Request, res: Response) => {
  try {
    const summary = db.prepare(`
      SELECT 
        COUNT(id) as total_games,
        SUM(CASE WHEN status = 'playing' THEN 1 ELSE 0 END) as active_games,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_games,
        SUM(CASE WHEN hide_playtime = 0 THEN playtime ELSE 0 END) as total_playtime_hours,
        MAX(updated_at) as last_updated
      FROM games
      
    `).get() as any;

    const genreAnalytics = db.prepare(`
      SELECT j.value as genre, COUNT(g.id) as game_count, SUM(CASE WHEN g.hide_playtime = 0 THEN g.playtime ELSE 0 END) as total_playtime
      FROM games g, json_each(g.genres) j
      
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
      },
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

    const isDuplicate = (data: z.infer<typeof GameSchema>) => {
      if (data.igdb_id != null) {
        return existingByIgdb.has(data.igdb_id) || seenInBatch.has(`i:${data.igdb_id}`);
      }
      if (data.steam_appid != null) {
        return existingBySteam.has(data.steam_appid) || seenInBatch.has(`s:${data.steam_appid}`);
      }
      const titleKey = data.title.toLowerCase();
      return existingByTitle.has(titleKey) || seenInBatch.has(`t:${titleKey}`);
    };

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
        stmts.insertGame.run({
          title: data.title,
          year: data.year ?? null,
          igdb_id: data.igdb_id ?? null,
          genres: JSON.stringify(data.genres),
          synopsis: data.synopsis,
          poster_url: data.poster_url,
          critic_score: data.critic_score ?? null,
          owned_platforms: JSON.stringify(normalizePlatformIds(data.owned_platforms)),
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
        imported++;
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
    const getByTitle = db.prepare("SELECT id, owned_platforms, playtime FROM games WHERE steam_appid IS NULL AND lower(title) = lower(?)");
    const delExcluded = db.prepare("DELETE FROM games WHERE (steam_appid = ? OR lower(title) = lower(?)) AND personal_rating IS NULL AND poster_url NOT LIKE '/posters/%'");

    if (excludedAppids.size) {
      const deleteJunk = db.transaction(() => {
        for (const g of ownedGames) {
          if (!excludedAppids.has(g.appid)) continue;
          delExcluded.run(g.appid, g.name);
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
        const prevPlay = Number(existing.playtime) || 0;
        const delta = Math.round((nextPlay - prevPlay) * 100) / 100;
        stmts.updateGame.run({
          title: preserve ? existing.title : game.title,
          year: preserve ? existing.year : (game.year ?? existing.year),
          igdb_id: preserve ? existing.igdb_id : (game.igdb_id ?? existing.igdb_id),
          genres: JSON.stringify(preserve ? safeJsonParse(existing.genres, []) : game.genres),
          synopsis: preserve ? existing.synopsis : game.synopsis,
          poster_url: preserve ? existing.poster_url : defaultPoster,
          critic_score: preserve ? existing.critic_score : (game.critic_score ?? existing.critic_score),
          owned_platforms: JSON.stringify(game.owned_platforms),
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
        if (delta >= 0.01) logPlaytimeDelta(existing.id, delta, Date.now());
        updated++;
        return;
      }

      const titleMatch = getByTitle.get(game.title) as any;
      if (titleMatch) {
        const mergedPlatforms = new Set<string>([...safeJsonParse<string[]>(titleMatch.owned_platforms, []), ...game.owned_platforms]);
        const nextPlay = Number(game.playtime) || 0;
        const prevPlay = Number(titleMatch.playtime) || 0;
        adoptSteamAppid.run(game.steam_appid, nextPlay, JSON.stringify([...mergedPlatforms]), Date.now(), titleMatch.id);
        const delta = Math.round((nextPlay - prevPlay) * 100) / 100;
        if (delta >= 0.01) logPlaytimeDelta(titleMatch.id, delta, Date.now());
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
        owned_platforms: JSON.stringify(game.owned_platforms),
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
      db.exec("DELETE FROM playtime_entries");
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
    const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
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
        owned_platforms: JSON.stringify(normalizePlatformIds(item.owned_platforms || [])),
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

// ── PLAYTIME HISTORY ────────────────────────────────────────────────

// GET /api/games/:id/playtime — session log for one game (newest first)
apiRouter.get("/games/:id/playtime", (req: Request, res: Response) => {
  try {
    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) return res.status(400).json({ error: "Invalid game ID" });
    if (!stmts.getGameById.get(paramParsed.data.id)) return res.status(404).json({ error: "Game not found" });
    const rows = db.prepare("SELECT id, game_id, hours, logged_at FROM playtime_entries WHERE game_id = ? ORDER BY logged_at DESC LIMIT 50")
      .all(paramParsed.data.id);
    const total = db.prepare("SELECT COALESCE(SUM(hours), 0) AS h FROM playtime_entries WHERE game_id = ?").get(paramParsed.data.id) as { h: number };
    res.json({ entries: rows, loggedTotal: Math.round(total.h * 100) / 100 });
  } catch (err) {
    console.error("GET /api/games/:id/playtime error:", err);
    res.status(500).json({ error: "Failed to fetch playtime history" });
  }
});

// ── BACKUPS ─────────────────────────────────────────────────────────
// Automatic daily snapshots plus on-demand ones, kept in data/backups.
// Restores copy tables online inside a transaction — no restart needed.

const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_NAME_RE = /^[a-zA-Z0-9._-]+\.db$/;
const USER_TABLES = ["games", "wishlist", "settings", "playtime_entries"] as const;

function ensureBackupDir(): void {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
}

function getBackupSettings(): { enabled: boolean; keep: number } {
  const enabledRow = stmts.getSettings.get("auto_backup") as { value: string } | undefined;
  const keepRow = stmts.getSettings.get("backup_keep") as { value: string } | undefined;
  const keep = Math.min(30, Math.max(1, Number.parseInt(keepRow?.value || "5", 10) || 5));
  return { enabled: enabledRow?.value !== "0", keep };
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith(".db"))
    .map((name) => {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, created_at: Math.round(st.mtimeMs), size: st.size };
    })
    .sort((a, b) => b.created_at - a.created_at);
}

function pruneBackups(keep: number): void {
  const all = listBackups();
  for (const extra of all.slice(keep)) {
    fs.rmSync(path.join(BACKUP_DIR, extra.name), { force: true });
  }
}

let backupBusy = false;

/**
 * Snapshots that leave the process (downloads) or outlive it on disk
 * (backups) must never carry the stored Steam Web API key: the REST API
 * deliberately never returns it (GET /settings/steam only exposes `keySet`),
 * so a downloadable/restorable copy must not widen that trust. After a
 * restore the key is simply re-entered, or supplied via STEAM_WEB_API_KEY.
 */
function scrubSecretsFromSnapshot(file: string): void {
  let snap: Database.Database | null = null;
  try {
    snap = new Database(file);
    snap.exec(
      "UPDATE settings SET value = json_remove(value, '$.apiKey') WHERE key = 'steam_sync' AND json_valid(value)"
    );
  } catch (err) {
    console.warn("Could not scrub secrets from snapshot:", err instanceof Error ? err.message : err);
  } finally {
    snap?.close();
  }
}

async function withBackupLock<T>(fn: () => Promise<T>): Promise<T> {
  if (backupBusy) {
    const err = new Error("A backup or restore is already running.");
    (err as Error & { status: number }).status = 409;
    throw err;
  }
  backupBusy = true;
  try {
    return await fn();
  } finally {
    backupBusy = false;
  }
}

/** Create a snapshot now and prune to the configured retention. Returns the list. */
export async function createBackupNow(): Promise<{ name: string; created_at: number; size: number }[]> {
  return withBackupLock(async () => {
    ensureBackupDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `gametrack-backup-${stamp}.db`;
    const file = path.join(BACKUP_DIR, name);
    await db.backup(file);
    // Backups are downloadable over the API and may be copied off-box — they
    // must not carry the stored Steam API key, and should not be world-readable.
    scrubSecretsFromSnapshot(file);
    try {
      fs.chmodSync(file, 0o600);
    } catch { /* best-effort: read-only mounts/volumes may deny chmod */ }
    pruneBackups(getBackupSettings().keep);
    return listBackups();
  });
}

/** One snapshot per day, called at boot. Never throws. */
export async function ensureDailyBackup(): Promise<void> {
  try {
    if (!getBackupSettings().enabled) return;
    ensureBackupDir();
    const today = new Date().toISOString().slice(0, 10);
    const hasToday = fs.readdirSync(BACKUP_DIR).some((f) => f.endsWith(".db") && f.includes(today));
    if (!hasToday) await createBackupNow();
  } catch (err) {
    console.warn("Automatic backup skipped:", err instanceof Error ? err.message : err);
  }
}

function validateBackupFile(file: string): { ok: true } | { ok: false; error: string } {
  try {
    const header = Buffer.alloc(16);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, header, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (header.toString("latin1") !== "SQLite format 3\0") {
      return { ok: false, error: "File is not a SQLite database." };
    }
    const probe = new Database(file, { readonly: true });
    try {
      const integrity = probe.pragma("integrity_check", { simple: true }) as unknown;
      if (integrity !== "ok") return { ok: false, error: "Backup failed integrity check and was not restored." };
      const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      const names = new Set(tables.map((t) => t.name));
      if (!names.has("games") || !names.has("settings")) {
        return { ok: false, error: "Backup is missing expected tables and was not restored." };
      }
    } finally {
      probe.close();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not read backup file." };
  }
}

function tableColumns(schema: string, table: string): string[] {
  try {
    return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  } catch {
    return [];
  }
}

function restoreFromValidatedFile(file: string): void {
  const esc = file.replace(/'/g, "''");
  db.exec(`ATTACH DATABASE '${esc}' AS snap`);
  try {
    db.pragma("foreign_keys = OFF");
    const copy = db.transaction(() => {
      for (const t of USER_TABLES) {
        db.exec(`DELETE FROM main."${t}"`);
        const destCols = tableColumns("main", t);
        const srcCols = tableColumns("snap", t);
        if (!destCols.length || !srcCols.length) continue;
        const cols = destCols.filter((c) => srcCols.includes(c));
        if (!cols.length) continue;
        const list = cols.map((c) => `"${c}"`).join(", ");
        db.exec(`INSERT INTO main."${t}" (${list}) SELECT ${list} FROM snap."${t}"`);
      }
    });
    copy();
  } finally {
    try { db.exec("DETACH DATABASE snap"); } catch { /* already detached */ }
    db.pragma("foreign_keys = ON");
  }
}

async function restoreBackupFile(file: string): Promise<void> {
  const valid = validateBackupFile(file);
  if (!valid.ok) {
    const err = new Error(valid.error);
    (err as Error & { status: number }).status = 422;
    throw err;
  }
  await withBackupLock(async () => {
    ensureBackupDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safety = `gametrack-backup-pre-restore-${stamp}.db`;
    const safetyPath = path.join(BACKUP_DIR, safety);
    await db.backup(safetyPath);
    scrubSecretsFromSnapshot(safetyPath);
    try {
      fs.chmodSync(safetyPath, 0o600);
    } catch { /* best-effort: read-only mounts/volumes may deny chmod */ }
    restoreFromValidatedFile(file);
    pruneBackups(getBackupSettings().keep);
  });
}

// GET /api/settings/backups
apiRouter.get("/settings/backups", (_req: Request, res: Response) => {
  try {
    res.json(getBackupSettings());
  } catch (err) {
    console.error("GET /api/settings/backups error:", err);
    res.status(500).json({ error: "Failed to read backup settings" });
  }
});

const BackupSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  keep: z.number().int().min(1).max(30).optional(),
});

// PUT /api/settings/backups
apiRouter.put("/settings/backups", (req: Request, res: Response) => {
  try {
    const parsed = BackupSettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid backup settings" });
    const current = getBackupSettings();
    const next = {
      enabled: parsed.data.enabled ?? current.enabled,
      keep: parsed.data.keep ?? current.keep,
    };
    stmts.upsertSettings.run("auto_backup", next.enabled ? "1" : "0");
    stmts.upsertSettings.run("backup_keep", String(next.keep));
    pruneBackups(next.keep);
    res.json(next);
  } catch (err) {
    console.error("PUT /api/settings/backups error:", err);
    res.status(500).json({ error: "Failed to save backup settings" });
  }
});

// GET /api/backups
apiRouter.get("/backups", (_req: Request, res: Response) => {
  try {
    res.json(listBackups());
  } catch (err) {
    console.error("GET /api/backups error:", err);
    res.status(500).json({ error: "Failed to list backups" });
  }
});

// POST /api/backups — snapshot now
apiRouter.post("/backups", async (_req: Request, res: Response) => {
  try {
    res.status(201).json(await createBackupNow());
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 409) return res.status(409).json({ error: (err as Error).message });
    console.error("POST /api/backups error:", err);
    res.status(500).json({ error: "Failed to create backup" });
  }
});

// GET /api/backups/:name/download
apiRouter.get("/backups/:name/download", (req: Request, res: Response) => {
  try {
    const name = String(req.params.name || "");
    if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ error: "Invalid backup name" });
    const file = path.join(BACKUP_DIR, path.basename(name));
    if (!fs.existsSync(file)) return res.status(404).json({ error: "Backup not found" });
    res.setHeader("Content-Type", "application/vnd.sqlite3");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.sendFile(file);
  } catch (err) {
    console.error("GET /api/backups/:name/download error:", err);
    res.status(500).json({ error: "Failed to download backup" });
  }
});

// DELETE /api/backups/:name
apiRouter.delete("/backups/:name", (req: Request, res: Response) => {
  try {
    const name = String(req.params.name || "");
    if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ error: "Invalid backup name" });
    const file = path.join(BACKUP_DIR, path.basename(name));
    if (!fs.existsSync(file)) return res.status(404).json({ error: "Backup not found" });
    fs.rmSync(file, { force: true });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/backups/:name error:", err);
    res.status(500).json({ error: "Failed to delete backup" });
  }
});

// POST /api/backups/:name/restore — validate, safety-snapshot, copy tables online.
apiRouter.post("/backups/:name/restore", async (req: Request, res: Response) => {
  try {
    const name = String(req.params.name || "");
    if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ error: "Invalid backup name" });
    const file = path.join(BACKUP_DIR, path.basename(name));
    if (!fs.existsSync(file)) return res.status(404).json({ error: "Backup not found" });
    await restoreBackupFile(file);
    res.json({ success: true, games: stmts.getAllGames.all().map(parseGame) });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 409 || status === 422) return res.status(status).json({ error: (err as Error).message });
    console.error("POST /api/backups/:name/restore error:", err);
    res.status(500).json({ error: "Restore failed — your current library is untouched." });
  }
});

/** Restore from an uploaded SQLite file (raw body). Mounted with express.raw in server.ts. */
apiRouter.post("/backups/restore-file", async (req: Request, res: Response) => {
  // Random suffix: pid+timestamp alone is guessable/predictable.
  const tmp = path.join(DATA_DIR, `.restore-${process.pid}-${Date.now()}-${crypto.randomUUID()}.db`);
  try {
    const body = req.body as Buffer | undefined;
    if (!body || !Buffer.isBuffer(body) || body.length < 100) {
      return res.status(400).json({ error: "Upload a valid GameTrack database file." });
    }
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    await restoreBackupFile(tmp);
    res.json({ success: true, games: stmts.getAllGames.all().map(parseGame) });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 409 || status === 422) return res.status(status).json({ error: (err as Error).message });
    console.error("POST /api/backups/restore-file error:", err);
    res.status(500).json({ error: "Restore failed — your current library is untouched." });
  } finally {
    fs.rmSync(tmp, { force: true });
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
      const out = [...safeJsonParse<string[]>(a, [])];
      for (const v of safeJsonParse<string[]>(b, [])) if (!out.includes(v)) out.push(v);
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
        owned_platforms: JSON.stringify(union(keep.owned_platforms, remove.owned_platforms)),
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
      // Move the loser's sessions onto the keeper first.
      db.prepare("UPDATE OR IGNORE playtime_entries SET game_id = ? WHERE game_id = ?").run(keepId, removeId);
      db.prepare("DELETE FROM playtime_entries WHERE game_id = ?").run(removeId);
      stmts.deleteGame.run(removeId);
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
// Local footprint: database, posters, backups — plus maintenance actions.

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
    const backups = dirSize(BACKUP_DIR);
    res.json({
      dbSize: sizeOf(path.join(DATA_DIR, "gametrack.db")),
      walSize: sizeOf(path.join(DATA_DIR, "gametrack.db-wal")),
      gameCount: (db.prepare("SELECT COUNT(*) AS n FROM games").get() as { n: number }).n,
      posterCount: posters.files,
      posterSize: posters.bytes,
      backupCount: backups.files,
      backupSize: backups.bytes,
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
