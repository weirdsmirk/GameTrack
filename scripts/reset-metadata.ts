/**
 * Re-sync the whole library (and wishlist) against IGDB.
 *
 * Run this after the RAWG → IGDB switch, or any time metadata/poster URLs have
 * drifted:
 *
 *   npm run reset-metadata
 *
 * For every row it looks the title up on IGDB and rewrites the IGDB id, year,
 * genres, synopsis, critic score and poster art. Poster rules:
 *   • rows synced from Steam  → the portrait Steam CDN cover (it always exists)
 *   • everything else         → the IGDB cover art
 * Locally uploaded posters (`/posters/...`) are never touched, and stale RAWG
 * CDN URLs are always purged. Titles are matched conservatively — an ambiguous
 * title is left with no IGDB id rather than linked to the wrong game.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import db from "../server/db";
import { mapIgdbGame } from "../server/igdb";
import { getSteamPosterImage } from "../server/steam";
import { DATA_DIR } from "../server/paths";
import { assertIgdbReachable, findIgdbMatch, sleep } from "./lib/igdb-match";

/** IGDB allows ~4 requests/second — stay comfortably under that. */
const REQUEST_DELAY_MS = 260;

interface Row {
  id: number;
  title: string;
  year: number | null;
  igdb_id: number | null;
  poster_url: string;
  genres: string;
  synopsis: string;
  critic_score: number | null;
  steam_appid?: number | null;
}

interface Stats {
  matched: number;
  unmatched: number;
  steamPosters: number;
  igdbPosters: number;
  keptPosters: number;
  duplicates: number;
}

function isLocalUpload(url: string | null | undefined): boolean {
  return Boolean(url && url.startsWith("/posters/"));
}

function isRawgUrl(url: string | null | undefined): boolean {
  return Boolean(url && /rawg\.io/i.test(url));
}

/**
 * Decide the poster for a row: Steam cover for Steam-owned games, IGDB cover
 * otherwise. Local uploads win over everything; a stale RAWG URL is dropped.
 */
function resolvePoster(row: Row, igdbPoster: string | null, stats: Stats): string {
  if (isLocalUpload(row.poster_url)) {
    stats.keptPosters++;
    return row.poster_url;
  }

  if (row.steam_appid != null) {
    stats.steamPosters++;
    return getSteamPosterImage(row.steam_appid);
  }

  if (igdbPoster) {
    stats.igdbPosters++;
    return igdbPoster;
  }

  if (isRawgUrl(row.poster_url)) {
    // Purge the RAWG CDN link — PosterImage renders the built-in fallback art.
    return "";
  }

  stats.keptPosters++;
  return row.poster_url;
}

async function processRows(
  label: string,
  rows: Row[],
  applyRow: (row: Row, patch: Record<string, unknown>) => void,
  stats: Stats
): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    process.stdout.write(`[${label} ${i + 1}/${rows.length}] ${row.title}\n`);

    try {
      const match = await findIgdbMatch(row.title, row.year);
      if (!match) {
        stats.unmatched++;
        console.log("   -> no confident IGDB match; cleared stale id, kept existing text metadata");
        applyRow(row, { igdb_id: null, poster_url: resolvePoster(row, null, stats) });
      } else {
        const mapped = mapIgdbGame(match);
        const genres = mapped.genres.length ? mapped.genres : JSON.parse(row.genres || "[]");
        applyRow(row, {
          igdb_id: mapped.igdb_id,
          year: mapped.year ?? row.year,
          genres: JSON.stringify(genres),
          synopsis: mapped.synopsis,
          critic_score: mapped.critic_score ?? row.critic_score,
          poster_url: resolvePoster(row, mapped.poster_url, stats),
        });
        stats.matched++;
        console.log(`   -> IGDB #${mapped.igdb_id}${mapped.year ? ` (${mapped.year})` : ""}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed/i.test(message)) {
        // Two library rows map to the same IGDB game — keep the id on the first.
        stats.duplicates++;
        console.warn("   -> duplicate IGDB id already claimed by another row; id left empty");
        applyRow(row, { igdb_id: null });
      } else {
        stats.unmatched++;
        console.error(`   -> failed: ${message}`);
      }
    }

    await sleep(REQUEST_DELAY_MS);
  }
}

/** Filename-safe UTC stamp, reused by both the id backup and the file backup. */
function stampFor(label: string): string {
  return `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/** Snapshot the current ids so a re-run always has something to fall back on. */
function backupIds(rows: { id: number; title: string; igdb_id: number | null }[], label: string): void {
  if (!rows.some((row) => row.igdb_id != null)) return;
  const file = path.join(DATA_DIR, `igdb-id-backup-${label}-${stampFor(label)}.json`);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2), { mode: 0o600 });
  console.log(`Backed up previous ${label} ids to ${file}`);
}

async function run(): Promise<void> {
  console.log("Starting IGDB metadata + poster reset...\n");
  await assertIgdbReachable();

  const games = db.prepare(
    "SELECT id, title, year, igdb_id, poster_url, genres, synopsis, critic_score, steam_appid FROM games ORDER BY id"
  ).all() as Row[];
  const wishlist = db.prepare(
    "SELECT id, title, year, igdb_id, poster_url, genres, synopsis, critic_score FROM wishlist ORDER BY id"
  ).all() as Row[];

  console.log(`Found ${games.length} library game(s) and ${wishlist.length} wishlist item(s).\n`);

  // Every stored id today may be a RAWG id, so wipe them before re-assigning —
  // otherwise stale values can collide with freshly matched IGDB ids. The ids
  // are backed up first (and the IGDB credential check above already passed).
  backupIds(games, "games");
  backupIds(wishlist, "wishlist");

  /* The wipe below and the re-link that follows are minutes apart, because
     every row costs an IGDB round trip. A Ctrl-C in that gap used to leave
     every row in the library with igdb_id = NULL — the RAWG-era links were
     already gone and the new ones had not been written yet, so there was
     nothing to fall back on and no script to put them back. Two guards close
     that window:
       1. `db.backup()` writes a byte-complete copy of the file next to it, so
          there is something to restore from even if this process dies hard.
       2. The SIGINT/SIGTERM handler below puts the in-memory snapshot back, so
          a normal Ctrl-C is a no-op rather than a data-loss event. */
  const snapshot = path.join(DATA_DIR, `igdb-reset-${stampFor("pre")}.db`);
  await db.backup(snapshot);
  console.log(`Backed up the database to ${snapshot}\n`);

  const restoreIds = db.prepare("UPDATE games SET igdb_id = @igdb_id WHERE id = @id");
  const restoreWishlistIds = db.prepare("UPDATE wishlist SET igdb_id = @igdb_id WHERE id = @id");
  const undo = db.transaction((rows: Row[], stmt: typeof restoreIds) => {
    for (const row of rows) stmt.run({ id: row.id, igdb_id: row.igdb_id });
  });
  const abort = (signal: string) => {
    console.error(`\n${signal} received — restoring the pre-run IGDB ids.`);
    undo(games, restoreIds);
    undo(wishlist, restoreWishlistIds);
    console.error("Restored. Nothing was lost. (To revert to the file backup, copy the .db above back over data/gametrack.db.)");
    process.exit(130);
  };
  process.once("SIGINT", () => abort("SIGINT"));
  process.once("SIGTERM", () => abort("SIGTERM"));

  db.prepare("UPDATE games SET igdb_id = NULL").run();
  db.prepare("UPDATE wishlist SET igdb_id = NULL").run();

  const updateGame = db.prepare(`
    UPDATE games
    SET igdb_id = @igdb_id,
        year = COALESCE(@year, year),
        genres = @genres,
        synopsis = @synopsis,
        critic_score = COALESCE(@critic_score, critic_score),
        poster_url = @poster_url,
        updated_at = @updated_at
    WHERE id = @id
  `);

  const updateWishlist = db.prepare(`
    UPDATE wishlist
    SET igdb_id = @igdb_id,
        year = COALESCE(@year, year),
        genres = @genres,
        synopsis = @synopsis,
        critic_score = COALESCE(@critic_score, critic_score),
        poster_url = @poster_url
    WHERE id = @id
  `);

  const stats: Stats = {
    matched: 0,
    unmatched: 0,
    steamPosters: 0,
    igdbPosters: 0,
    keptPosters: 0,
    duplicates: 0,
  };

  await processRows(
    "library",
    games,
    (row, patch) => updateGame.run({ id: row.id, updated_at: Date.now(), ...patch }),
    stats
  );
  await processRows("wishlist", wishlist, (row, patch) => updateWishlist.run({ id: row.id, ...patch }), stats);

  console.log("\n──────────────────────────────────────────────");
  console.log(`Matched against IGDB : ${stats.matched}`);
  console.log(`No confident match   : ${stats.unmatched}`);
  console.log(`Steam posters        : ${stats.steamPosters}`);
  console.log(`IGDB posters         : ${stats.igdbPosters}`);
  console.log(`Existing posters kept: ${stats.keptPosters}`);
  console.log(`Duplicate IGDB ids   : ${stats.duplicates}`);
  console.log("Reset complete.");
}

run().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});