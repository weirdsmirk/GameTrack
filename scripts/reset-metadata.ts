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
import { handleUsage, wantsDryRun, wantsUsage } from "./lib/maintenance-guard";

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
interface IgdbDeps {
  mapIgdbGame: typeof import("../server/igdb").mapIgdbGame;
  getSteamPosterImage: typeof import("../server/steam").getSteamPosterImage;
  findIgdbMatch: typeof import("./lib/igdb-match").findIgdbMatch;
  sleep: typeof import("./lib/igdb-match").sleep;
}

function resolvePoster(row: Row, igdbPoster: string | null, stats: Stats, deps: IgdbDeps): string {
  if (isLocalUpload(row.poster_url)) {
    stats.keptPosters++;
    return row.poster_url;
  }

  if (row.steam_appid != null) {
    stats.steamPosters++;
    return deps.getSteamPosterImage(row.steam_appid);
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
  stats: Stats,
  deps: IgdbDeps
): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    process.stdout.write(`[${label} ${i + 1}/${rows.length}] ${row.title}\n`);

    try {
      const match = await deps.findIgdbMatch(row.title, row.year);
      if (!match) {
        stats.unmatched++;
        console.log("   -> no confident IGDB match; cleared stale id, kept existing text metadata");
        /* Every named parameter the UPDATE references has to be present, even the
           ones being kept: better-sqlite3 rejects the whole statement if any is
           missing. This patch used to carry only `igdb_id` and `poster_url`, so
           the write threw RangeError — and the catch below swallowed it as
           "failed: Missing named parameter". The row's id still ended up NULL,
           but only because the old code had already wiped every id up front; the
           "clear the id on an unmatched row" behaviour was never actually being
           applied by this statement at all. Passing the row's current values
           states the intent directly and makes the write complete on its own. */
        applyRow(row, {
          igdb_id: null,
          year: row.year,
          genres: row.genres,
          synopsis: row.synopsis,
          critic_score: row.critic_score,
          poster_url: resolvePoster(row, null, stats, deps),
        });
      } else {
        const mapped = deps.mapIgdbGame(match);
        const genres = mapped.genres.length ? mapped.genres : JSON.parse(row.genres || "[]");
        applyRow(row, {
          igdb_id: mapped.igdb_id,
          year: mapped.year ?? row.year,
          genres: JSON.stringify(genres),
          synopsis: mapped.synopsis,
          critic_score: mapped.critic_score ?? row.critic_score,
          poster_url: resolvePoster(row, mapped.poster_url, stats, deps),
        });
        stats.matched++;
        console.log(`   -> IGDB #${mapped.igdb_id}${mapped.year ? ` (${mapped.year})` : ""}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed/i.test(message)) {
        /* Duplicates are decided by the in-memory `claimed` set before anything is
           written, so this branch is not expected to fire. It is kept rather than
           deleted because the write is now one transaction: if an id ever did
           collide, swallowing it here would still abort the batch, and the caller
           would report success for a rollback. Failing loudly is the honest
           outcome. */
        stats.duplicates++;
        throw new Error(
          `UNIQUE constraint failed on igdb_id despite pre-claim checks: ${message}`
        );
      } else {
        stats.unmatched++;
        console.error(`   -> failed: ${message}`);
        /* A lookup that errored is not the same as a lookup that found nothing, but
           it ends the same way for this row. The script exists to clear ids that
           may still be RAWG's, so leaving the old value in place because the
           network blipped would preserve exactly the wrong id. The text metadata
           is kept, as for a genuine no-match. */
        applyRow(row, {
          igdb_id: null,
          year: row.year,
          genres: row.genres,
          synopsis: row.synopsis,
          critic_score: row.critic_score,
          poster_url: row.poster_url,
        });
      }
    }

    await deps.sleep(REQUEST_DELAY_MS);
  }
}

/** Filename-safe UTC stamp, reused by both the id backup and the file backup. */
function stampFor(label: string): string {
  return `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/** Snapshot the current ids so a re-run always has something to fall back on. */
function backupIds(
  rows: { id: number; title: string; igdb_id: number | null }[],
  label: string,
  dataDir: string
): void {
  if (!rows.some((row) => row.igdb_id != null)) return;
  const file = path.join(dataDir, `igdb-id-backup-${label}-${stampFor(label)}.json`);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2), { mode: 0o600 });
  console.log(`Backed up previous ${label} ids to ${file}`);
}

const USAGE = `
reset-metadata — re-match every library and wishlist row against IGDB.

For every row it looks the title up on IGDB and rewrites the IGDB id, year,
genres, synopsis, critic score and poster art. Poster rules:
  • rows synced from Steam  → the portrait Steam CDN cover (it always exists)
  • everything else         → the IGDB cover art
Locally uploaded posters (/posters/...) are never touched, and stale RAWG CDN
URLs are always purged. Titles are matched conservatively — an ambiguous title is
left with no IGDB id rather than linked to the wrong game.

Nothing is written until every row has been looked up, so an interrupted run
leaves the library exactly as it was.

Usage:
  npm run reset-metadata                 run it
  npm run reset-metadata -- --dry-run    report what would change, write nothing
  npm run reset-metadata -- --help       show this
`;

async function run(): Promise<void> {
  const dryRun = wantsDryRun(process.argv.slice(2));

  /* Everything that touches the database is loaded HERE, not at the top of the
     file. ES module imports are hoisted and evaluated before any module-level
     statement, so a static `import db from "../server/db"` would open — and write
     to — the library even when this script was only asked what it would do. The
     guard above has already exited by this point, so by the time these resolve no
     database has been touched. */
  const { default: db } = await import("../server/db");
  const { DATA_DIR } = await import("../server/paths");
  const { assertIgdbReachable, findIgdbMatch, sleep } = await import("./lib/igdb-match");
  const { mapIgdbGame } = await import("../server/igdb");
  const { getSteamPosterImage } = await import("../server/steam");
  const deps: IgdbDeps = { mapIgdbGame, getSteamPosterImage, findIgdbMatch, sleep };

  console.log(`${dryRun ? "DRY RUN — " : ""}Starting IGDB metadata + poster reset...\n`);
  await assertIgdbReachable();

  const games = db.prepare(
    "SELECT id, title, year, igdb_id, poster_url, genres, synopsis, critic_score, steam_appid FROM games ORDER BY id"
  ).all() as Row[];
  const wishlist = db.prepare(
    "SELECT id, title, year, igdb_id, poster_url, genres, synopsis, critic_score FROM wishlist ORDER BY id"
  ).all() as Row[];

  console.log(`Found ${games.length} library game(s) and ${wishlist.length} wishlist item(s).\n`);

  // A plain JSON id map, written before anything else. Cheap insurance that costs
  // no database write, so it is not the thing standing between a mistake and the
  // library.
  backupIds(games, "games", DATA_DIR);
  backupIds(wishlist, "wishlist", DATA_DIR);

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

  /* Writes are collected here and applied in one transaction at the end.

     The previous shape nulled `igdb_id` on every row first, then spent minutes
     doing one IGDB round trip per row to write the new ids back. For that whole
     window the library was linked to nothing, and only two things stood between
     an interrupted run and a fully unlinked library: a JSON file nobody restores
     automatically, and a SIGINT handler that does not cover SIGKILL, an OOM, a
     crashed connection or a pulled power cable.

     Staging instead of streaming removes the window rather than trying to catch
     the fall. The database is untouched for the entire slow phase, and the write
     is a single transaction, so it either lands whole or not at all. */
  const gameWrites: { id: number; params: Record<string, unknown> }[] = [];
  const wishlistWrites: { id: number; params: Record<string, unknown> }[] = [];

  /* Ids claimed by an earlier row in this run.

     Duplicate detection is done here, in memory, rather than by catching the
     UNIQUE violation the insert would raise. Inside one transaction that violation
     rolls back the whole batch, so the old per-row catch could not have survived
     being moved into a transaction — it has to be decided before the write, not
     during it. First row to claim an id keeps it, exactly as before. */
  const claimed = new Set<number>();
  const stage = (
    sink: { id: number; params: Record<string, unknown> }[],
    row: Row,
    patch: Record<string, unknown>
  ) => {
    const id = (patch.igdb_id as number | null | undefined) ?? null;
    let effective = patch;
    if (id != null && claimed.has(id)) {
      stats.duplicates++;
      console.warn("   -> duplicate IGDB id already claimed by another row; id left empty");
      effective = { ...patch, igdb_id: null };
    } else if (id != null) {
      claimed.add(id);
    }
    sink.push({ id: row.id, params: { id: row.id, ...effective } });
  };

  await processRows(
    "library",
    games,
    (row, patch) => stage(gameWrites, row, { updated_at: Date.now(), ...patch }),
    stats,
    deps
  );
  await processRows(
    "wishlist",
    wishlist,
    (row, patch) => stage(wishlistWrites, row, patch),
    stats,
    deps
  );

  console.log("\n──────────────────────────────────────────────");
  console.log(`Matched against IGDB : ${stats.matched}`);
  console.log(`No confident match   : ${stats.unmatched}`);
  console.log(`Steam posters        : ${stats.steamPosters}`);
  console.log(`IGDB posters         : ${stats.igdbPosters}`);
  console.log(`Existing posters kept: ${stats.keptPosters}`);
  console.log(`Duplicate IGDB ids   : ${stats.duplicates}`);

  if (dryRun) {
    console.log(`\nDry run: ${gameWrites.length + wishlistWrites.length} row(s) would be rewritten. Nothing was written.`);
    return;
  }

  // A byte-complete file copy, taken immediately before the single write rather
  // than before the slow phase — so it reflects the true "before" state and is
  // never stale.
  const snapshot = path.join(DATA_DIR, `igdb-reset-${stampFor("pre")}.db`);
  await db.backup(snapshot);
  console.log(`Backed up the database to ${snapshot}`);

  const applyAll = db.transaction(() => {
    for (const write of gameWrites) updateGame.run(write.params);
    for (const write of wishlistWrites) updateWishlist.run(write.params);
  });
  applyAll();

  console.log(`\nRewrote ${gameWrites.length + wishlistWrites.length} row(s) in a single transaction. Reset complete.`);
}

/* One guard, at the entry point.

   It lives here rather than at the top of the file because `run()` is what pulls
   in the database-backed modules: ES module imports are hoisted, so a static
   `import db from "../server/db"` would open — and write to — the library even
   when this script was only asked to describe itself.

   The explicit `else` matters as much as the exit. `handleUsage` calls
   `process.exit(0)`, which is enough in production, but anything that intercepts
   `process.exit` — a test spy, an embedding host — would otherwise fall straight
   through into the destructive branch below. */
if (wantsUsage(process.argv.slice(2))) {
  handleUsage(true, USAGE);
} else {
  run().catch((err) => {
    console.error("Reset failed:", err);
    process.exit(1);
  });
}