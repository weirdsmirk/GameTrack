import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { normalizePlatformIds } from "../src/constants";
import { DATA_DIR, ensureDataDir } from "./paths";
import { getSteamPosterImage } from "./steam";

// Database lives inside the data directory for full portability.
const DB_PATH = path.join(DATA_DIR, "gametrack.db");

// Ensure the data directory exists with restricted permissions.
ensureDataDir();

const db = new Database(DB_PATH);
// Restrict database file permissions (best-effort: read-only mounts and some
// container volumes deny chmod, which must never crash startup).
try {
  fs.chmodSync(DB_PATH, 0o600);
} catch (err) {
  console.warn("Could not set database file permissions:", err instanceof Error ? err.message : err);
}

// ── Performance tuning ────────────────────────────────────────────
// WAL mode allows concurrent reads while writing and is significantly
// faster than the default journal mode for this workload.
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.pragma("cache_size = -64000");
// Bound WAL growth on crash-prone hosts: the 5-minute background sync writes
// constantly, and without a size limit a killed process can leave a huge
// -wal file behind. SQLite auto-checkpoints past this threshold.
db.pragma("journal_size_limit = 67108864");

// ── Schema ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    year INTEGER,
    igdb_id INTEGER,
    genres TEXT DEFAULT '[]',
    synopsis TEXT DEFAULT '',
    poster_url TEXT DEFAULT '',
    critic_score INTEGER CHECK (critic_score IS NULL OR (critic_score >= 0 AND critic_score <= 100)),
    owned_platforms TEXT DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'backlog'
      CHECK (status IN ('backlog', 'playing', 'completed', 'endless')),
    playtime REAL DEFAULT 0,
    personal_rating INTEGER CHECK (personal_rating IS NULL OR (personal_rating >= 0 AND personal_rating <= 10)),
    date_added INTEGER NOT NULL,
    date_completed INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    hide_playtime INTEGER DEFAULT 0 CHECK (hide_playtime IN (0, 1)),
    steam_appid INTEGER,
    custom_order INTEGER,
    metadata_custom INTEGER NOT NULL DEFAULT 0 CHECK (metadata_custom IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Indexes for common query patterns
  CREATE INDEX IF NOT EXISTS idx_games_date ON games(date_added DESC);
  CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
`);

// ── Migrations (versioned via PRAGMA user_version) ──────────────────
//
// Each migration block runs exactly once, in order. user_version is bumped
// only after a block completes successfully; a failed migration fails loudly
// at startup instead of being silently re-run every boot.

const SCHEMA_VERSION = 15;

function migrateTo(target: number) {
  const current = Number(db.pragma("user_version", { simple: true })) || 0;
  if (current >= target) return;
  for (let v = current + 1; v <= target; v++) {
    // Each version runs atomically — a failure mid-migration rolls the whole
    // version back instead of leaving partial DDL behind with a stale
    // user_version.
    const migrate = db.transaction(() => {
      runMigration(v);
      db.pragma(`user_version = ${v}`);
    });
    migrate();
  }
}

function runMigration(version: number) {
  const gameColumns = db.prepare("PRAGMA table_info(games)").all() as any[];

  if (version === 1) {
    if (!gameColumns.some((col) => col.name === "steam_appid")) {
      db.exec("ALTER TABLE games ADD COLUMN steam_appid INTEGER");
      db.exec("CREATE INDEX IF NOT EXISTS idx_games_steam ON games(steam_appid)");
    }

    // The external game id column is igdb_id. Databases created during the
    // short-lived RAWG era are converted by the v8 migration below.
    db.exec("CREATE INDEX IF NOT EXISTS idx_games_igdb ON games(igdb_id)");

    // "Main Story Done, Playing" was removed — convert existing entries to Completed.
    db.exec("UPDATE games SET status = 'completed' WHERE status = 'main_complete'");

    // "Multiplayer" status was removed — convert existing entries to Backlog.
    db.exec("UPDATE games SET status = 'backlog' WHERE status = 'multiplayer'");

    // Wishlist was removed from GameTrack — turn former wishlist entries into
    // plain backlog entries and drop the column (SQLite 3.35+).
    if (gameColumns.some((col) => col.name === "is_wishlist")) {
      db.exec("DROP INDEX IF EXISTS idx_games_wishlist");
      db.exec("UPDATE games SET is_wishlist = 0 WHERE status NOT IN ('backlog', 'playing', 'completed', 'endless')");
      db.exec("UPDATE games SET status = 'backlog', is_wishlist = 0 WHERE is_wishlist = 1");
      try {
        db.exec("ALTER TABLE games DROP COLUMN is_wishlist");
      } catch (err) {
        console.warn("Could not drop is_wishlist column (SQLite < 3.35 or referenced):", err);
      }
    }

    // Notes feature was removed from GameTrack — drop the column (SQLite 3.35+).
    if (gameColumns.some((col) => col.name === "notes")) {
      try {
        db.exec("ALTER TABLE games DROP COLUMN notes");
      } catch (err) {
        console.warn("Could not drop notes column (SQLite < 3.35 or referenced):", err);
      }
    }

    // Play sessions were removed from GameTrack — drop the table entirely.
    db.exec("DROP TABLE IF EXISTS play_sessions");

    // Normalize legacy platform slugs (IGDB forms like "pc", "playstation5",
    // "xbox-one") into canonical app platform ids stored on existing games.
    const platformRows = db.prepare("SELECT id, owned_platforms FROM games WHERE owned_platforms IS NOT NULL AND owned_platforms != '[]'").all() as any[];
    if (platformRows.length) {
      const updatePlatforms = db.prepare("UPDATE games SET owned_platforms = ? WHERE id = ?");
      const migratePlatforms = db.transaction((rows: any[]) => {
        for (const row of rows) {
          let list: string[] = [];
          try {
            list = JSON.parse(row.owned_platforms);
          } catch {
            continue;
          }
          if (!Array.isArray(list)) continue;
          const normalized = normalizePlatformIds(list);
          if (JSON.stringify(normalized) !== JSON.stringify(list)) {
            updatePlatforms.run(JSON.stringify(normalized), row.id);
          }
        }
      });
      migratePlatforms(platformRows);
    }
  }

  if (version === 2) {
    // De-duplicate rows sharing an igdb_id / steam_appid (keep the oldest),
    // then enforce uniqueness so double-submits can never create duplicates.
    db.exec(`
      DELETE FROM games
      WHERE igdb_id IS NOT NULL
        AND id NOT IN (SELECT MIN(id) FROM games WHERE igdb_id IS NOT NULL GROUP BY igdb_id)
    `);
    db.exec(`
      DELETE FROM games
      WHERE steam_appid IS NOT NULL
        AND id NOT IN (SELECT MIN(id) FROM games WHERE steam_appid IS NOT NULL GROUP BY steam_appid)
    `);
    db.exec("DROP INDEX IF EXISTS idx_games_igdb");
    db.exec("CREATE UNIQUE INDEX idx_games_igdb ON games(igdb_id) WHERE igdb_id IS NOT NULL");
    db.exec("DROP INDEX IF EXISTS idx_games_steam");
    db.exec("CREATE UNIQUE INDEX idx_games_steam ON games(steam_appid) WHERE steam_appid IS NOT NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_games_title_lower ON games(lower(title))");
    db.exec("CREATE INDEX IF NOT EXISTS idx_games_updated ON games(updated_at)");
  }

  if (version === 3) {
    // Hand-arranged library order. NULL means "not placed" (sorts last).
    if (!gameColumns.some((col) => col.name === "custom_order")) {
      db.exec("ALTER TABLE games ADD COLUMN custom_order INTEGER");
      db.exec("CREATE INDEX IF NOT EXISTS idx_games_custom_order ON games(custom_order)");
    }
  }

  if (version === 4 || version === 5 || version === 6) {
    // Wishlist — games you want, tracked separately from the library.
    db.exec(`
      CREATE TABLE IF NOT EXISTS wishlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        igdb_id INTEGER UNIQUE,
        title TEXT NOT NULL,
        year INTEGER,
        poster_url TEXT DEFAULT '',
        genres TEXT DEFAULT '[]',
        owned_platforms TEXT DEFAULT '[]',
        critic_score INTEGER CHECK (critic_score IS NULL OR (critic_score >= 0 AND critic_score <= 100)),
        synopsis TEXT DEFAULT '',
        date_added INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wishlist_date ON wishlist(date_added DESC);
    `);

    // Ensure igdb_id column exists on games table
    const currentGamesCols = db.prepare("PRAGMA table_info(games)").all() as any[];
    if (!currentGamesCols.some((col) => col.name === "igdb_id")) {
      db.exec("ALTER TABLE games ADD COLUMN igdb_id INTEGER");
    }
    db.exec("DROP INDEX IF EXISTS idx_games_igdb");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_games_igdb ON games(igdb_id) WHERE igdb_id IS NOT NULL");

    // Ensure igdb_id column exists on wishlist table
    const currentWishlistCols = db.prepare("PRAGMA table_info(wishlist)").all() as any[];
    if (!currentWishlistCols.some((col) => col.name === "igdb_id")) {
      db.exec("ALTER TABLE wishlist ADD COLUMN igdb_id INTEGER");
    }
    db.exec("DROP INDEX IF EXISTS idx_wishlist_igdb");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_igdb ON wishlist(igdb_id) WHERE igdb_id IS NOT NULL");
  }

  if (version === 7) {
    // v7 was the short-lived RAWG migration, which renamed igdb_id -> rawg_id.
    // It is a deliberate no-op now: v8 below restores the IGDB column naming
    // for any database that already ran it, so a fresh install (which creates
    // igdb_id directly) and an upgraded install both converge on igdb_id.
  }

  if (version === 8) {
    // RAWG support was removed — the app is IGDB-only again. Converge every
    // RAWG remnant (columns, uniqueness indexes, poster URLs) back onto IGDB.
    normalizeRawgRemnants();
    normalizePosterPolicy();
  }

  if (version === 9) {
    // The RAWG era rewrote the whole id column with RAWG's own numbers, so the
    // values that survived the rename above are NOT IGDB ids — they would make
    // the details modal and Discover resolve the wrong game. Clear them and
    // let scripts/reset-metadata.ts repopulate real IGDB ids (it matches every
    // title against IGDB and also restores the posters).
    const staleIds = db.prepare("SELECT COUNT(*) AS n FROM games WHERE igdb_id IS NOT NULL").get() as { n: number };
    db.exec("UPDATE games SET igdb_id = NULL WHERE igdb_id IS NOT NULL");
    db.exec("UPDATE wishlist SET igdb_id = NULL WHERE igdb_id IS NOT NULL");
    if (staleIds.n > 0) {
      console.warn(
        `[db] Cleared ${staleIds.n} RAWG-era external id(s) — run \`npm run reset-metadata\` to re-link them to IGDB.`
      );
    }
  }

  if (version === 10) {
    // Track whether a row's metadata (title/year/genres/synopsis/score/poster)
    // was customized by the user. Steam sync consults this flag so manual
    // metadata edits survive every future sync instead of only surviving when
    // the user happened to also rate the game or upload a poster file.
    const cols = db.prepare("PRAGMA table_info(games)").all() as any[];
    if (!cols.some((col) => col.name === "metadata_custom")) {
      db.exec("ALTER TABLE games ADD COLUMN metadata_custom INTEGER NOT NULL DEFAULT 0 CHECK (metadata_custom IN (0, 1))");
    }
    // One-time backfill: rows that already carry a custom uploaded poster were
    // by definition customized by the user.
    db.exec("UPDATE games SET metadata_custom = 1 WHERE poster_url LIKE '/posters/%'");
  }

  if (version === 11) {
    // Poster quality switch: IGDB covers were stored at `t_cover_big`
    // (264x374). Re-point every stored IGDB poster at the retina
    // `t_cover_big_2x` preset (528x748) — same image, best documented cover
    // resolution. Steam CDN and local `/posters/...` uploads are untouched.
    const upgraded = upgradeIgdbPosterQuality();
    if (upgraded > 0) {
      console.log(`[db] Upgraded ${upgraded} poster URL(s) to high-resolution IGDB covers.`);
    }
  }

  if (version === 14) {
    // Custom collections were removed from the application. Drop their
    // normalized tables for existing databases as part of the migration.
    db.exec("DROP TABLE IF EXISTS collection_games; DROP TABLE IF EXISTS collections;");
  }

  if (version === 15) {
    // Playtime history was removed from the application. Drop its table and
    // indexes, following the same pattern as the collections removal above.
    db.exec(`
      DROP INDEX IF EXISTS idx_playtime_game;
      DROP INDEX IF EXISTS idx_playtime_date;
      DROP TABLE IF EXISTS playtime_entries;
    `);
  }

  if (version === 12) {
    // Modern format switch: the IGDB CDN serves the same cover as WebP
    // (~15-35% smaller than JPEG). Rewrite stored `.jpg`/`.jpeg`/`.png`
    // IGDB suffixes to `.webp` — same image, faster loads. Steam CDN and
    // local `/posters/...` uploads are untouched.
    const upgraded = upgradeIgdbPosterQuality();
    if (upgraded > 0) {
      console.log(`[db] Upgraded ${upgraded} poster URL(s) to WebP.`);
    }
  }
}

/**
 * Re-point stored low-resolution IGDB poster crops at `t_cover_big_2x` and
 * rewrite legacy `.jpg`/`.jpeg`/`.png` suffixes to `.webp` (same image,
 * modern container served by the IGDB CDN).
 * Idempotent string replacement (games + wishlist) — safe to re-run on
 * every boot via ensureSchemaIntegrity().
 */
export function upgradeIgdbPosterQuality(): number {
  // LIKE patterns use `/.../` delimiters so `t_cover_big` never matches the
  // already-upgraded `t_cover_big_2x` (different character after "big").
  const upgrades: Array<[string, string]> = [
    ["/t_cover_big/", "/t_cover_big_2x/"],
    ["/t_cover_small/", "/t_cover_big_2x/"],
    ["/t_cover_small_2x/", "/t_cover_big_2x/"],
    ["/t_thumb/", "/t_cover_big_2x/"],
    ["/t_thumb_2x/", "/t_cover_big_2x/"],
    ["/t_micro/", "/t_cover_big_2x/"],
    ["/t_micro_2x/", "/t_cover_big_2x/"],
  ];
  // Suffix swaps only apply at the end of the URL — the IGDB image_id is
  // alphanumeric, so `.jpg`/`.png` can only occur as the file extension.
  // (Stored poster URLs never carry query strings.)
  const suffixUpgrades: Array<[string, string]> = [
    [".jpg", ".webp"],
    [".jpeg", ".webp"],
    [".png", ".webp"],
  ];
  let total = 0;
  const apply = db.transaction(() => {
    for (const table of ["games", "wishlist"] as const) {
      for (const [from, to] of upgrades) {
        const info = db
          .prepare(
            `UPDATE ${table} SET poster_url = REPLACE(poster_url, ?, ?) WHERE poster_url LIKE '%images.igdb.com%' AND poster_url LIKE ?`
          )
          .run(from, to, `%${from}%`);
        total += Number(info.changes) || 0;
      }
      for (const [from, to] of suffixUpgrades) {
        const info = db
          .prepare(
            `UPDATE ${table} SET poster_url = REPLACE(poster_url, ?, ?) WHERE poster_url LIKE '%images.igdb.com%' AND poster_url LIKE ?`
          )
          .run(from, to, `%${from}`);
        total += Number(info.changes) || 0;
      }
    }
  });
  apply();
  return total;
}

// ── RAWG remnant cleanup ────────────────────────────────────────────
// The app briefly shipped with RAWG as its metadata provider. That switch has
// been fully reverted, so any database touched by it is converged back onto the
// IGDB schema here. Both helpers are idempotent, which lets ensureSchemaIntegrity()
// re-run them defensively on every boot.

/**
 * Restore `igdb_id` as the single external-provider column (games + wishlist)
 * and rebuild the uniqueness indexes on it.
 */
function normalizeRawgRemnants() {
  const gamesCols = db.prepare("PRAGMA table_info(games)").all() as any[];
  if (gamesCols.some((col) => col.name === "rawg_id") && !gamesCols.some((col) => col.name === "igdb_id")) {
    db.exec("ALTER TABLE games RENAME COLUMN rawg_id TO igdb_id");
  }
  db.exec("DROP INDEX IF EXISTS idx_games_rawg");
  const gamesColsAfterRename = db.prepare("PRAGMA table_info(games)").all() as any[];
  if (gamesColsAfterRename.some((col) => col.name === "rawg_id")) {
    // Both columns existed, which means the rawg_id values are RAWG ids and can
    // never be used as IGDB ids — blank them and drop the column if we can.
    db.exec("UPDATE games SET rawg_id = NULL");
    try {
      db.exec("ALTER TABLE games DROP COLUMN rawg_id");
    } catch (err) {
      console.warn("Could not drop legacy games.rawg_id column:", err);
    }
  }
  // De-duplicate before rebuilding the unique index (keep the oldest row) so a
  // database that predates the index can't fail the migration.
  db.exec(`
    DELETE FROM games
    WHERE igdb_id IS NOT NULL
      AND id NOT IN (SELECT MIN(id) FROM games WHERE igdb_id IS NOT NULL GROUP BY igdb_id)
  `);
  db.exec("DROP INDEX IF EXISTS idx_games_igdb");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_games_igdb ON games(igdb_id) WHERE igdb_id IS NOT NULL");

  const wishlistCols = db.prepare("PRAGMA table_info(wishlist)").all() as any[];
  if (wishlistCols.some((col) => col.name === "rawg_id") && !wishlistCols.some((col) => col.name === "igdb_id")) {
    db.exec("ALTER TABLE wishlist RENAME COLUMN rawg_id TO igdb_id");
  }
  db.exec("DROP INDEX IF EXISTS idx_wishlist_rawg");
  const wishlistColsAfterRename = db.prepare("PRAGMA table_info(wishlist)").all() as any[];
  if (wishlistColsAfterRename.some((col) => col.name === "rawg_id")) {
    db.exec("UPDATE wishlist SET rawg_id = NULL");
    try {
      db.exec("ALTER TABLE wishlist DROP COLUMN rawg_id");
    } catch (err) {
      console.warn("Could not drop legacy wishlist.rawg_id column:", err);
    }
  }
  db.exec(`
    DELETE FROM wishlist
    WHERE igdb_id IS NOT NULL
      AND id NOT IN (SELECT MIN(id) FROM wishlist WHERE igdb_id IS NOT NULL GROUP BY igdb_id)
  `);
  db.exec("DROP INDEX IF EXISTS idx_wishlist_igdb");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_igdb ON wishlist(igdb_id) WHERE igdb_id IS NOT NULL");
}

/**
 * Poster policy: a row owned on Steam always uses the Steam CDN portrait (the
 * exact artwork for that appid); every other row uses its IGDB cover. The RAWG
 * era repointed both kinds of row at media.rawg.io, so Steam rows are repaired
 * here and non-Steam rows are blanked — a dead RAWG link is never rendered, and
 * the IGDB cover is restored by scripts/fetch-all-igdb-posters.ts or by the
 * details modal's "Sync Poster" action.
 */
export function normalizePosterPolicy(): number {
  // Custom uploads ("/posters/...") are user content — never rewrite them.
  const staleGames = db
    .prepare("SELECT id, steam_appid FROM games WHERE (poster_url = '' OR poster_url LIKE '%rawg.io%') AND poster_url NOT LIKE '/posters/%'")
    .all() as { id: number; steam_appid: number | null }[];
  const staleWishlist = db
    .prepare("SELECT id FROM wishlist WHERE poster_url = '' OR poster_url LIKE '%rawg.io%'")
    .all() as { id: number }[];

  if (!staleGames.length && !staleWishlist.length) return 0;

  const updateGame = db.prepare("UPDATE games SET poster_url = ? WHERE id = ?");
  const updateWishlist = db.prepare("UPDATE wishlist SET poster_url = ? WHERE id = ?");
  const apply = db.transaction(() => {
    for (const row of staleGames) {
      updateGame.run(row.steam_appid != null ? getSteamPosterImage(row.steam_appid) : "", row.id);
    }
    for (const row of staleWishlist) updateWishlist.run("", row.id);
  });
  apply();

  return staleGames.filter((row) => row.steam_appid != null).length;
}

migrateTo(SCHEMA_VERSION);

// Defensive integrity check on startup — cheap, idempotent guards so a database
// that never ran the versioned migrations (or was written by older code) still
// boots on the IGDB schema.
function ensureSchemaIntegrity() {
  normalizeRawgRemnants();
  normalizePosterPolicy();
  upgradeIgdbPosterQuality();
}

ensureSchemaIntegrity();

export default db;
