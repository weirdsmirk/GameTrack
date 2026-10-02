/**
 * Poster-only refresh — re-point every row at an IGDB (or Steam) cover without
 * touching any other metadata. Useful when only artwork is stale:
 *
 *   npm run fetch-igdb-posters
 *
 * Rows with a stored IGDB id are queried directly (exact, cheapest); rows
 * without one fall back to the conservative title matcher. Steam-owned rows
 * always get the portrait Steam CDN cover, and locally uploaded posters are
 * left alone. Stale RAWG CDN links are purged.
 */
import "dotenv/config";
import { handleUsage, wantsUsage } from "./lib/maintenance-guard";
import type { IgdbRawGame } from "../server/igdb";

interface IgdbDeps {
  fetchFromIgdb: typeof import("../server/igdb").fetchFromIgdb;
  getIgdbImageUrl: typeof import("../server/igdb").getIgdbImageUrl;
  getSteamPosterImage: typeof import("../server/steam").getSteamPosterImage;
  assertIgdbReachable: typeof import("./lib/igdb-match").assertIgdbReachable;
  findIgdbMatch: typeof import("./lib/igdb-match").findIgdbMatch;
  sleep: typeof import("./lib/igdb-match").sleep;
}

const REQUEST_DELAY_MS = 260;

interface Row {
  id: number;
  title: string;
  year: number | null;
  igdb_id: number | null;
  poster_url: string;
  steam_appid?: number | null;
}

function isLocalUpload(url: string | null | undefined): boolean {
  return Boolean(url && url.startsWith("/posters/"));
}

function isRawgUrl(url: string | null | undefined): boolean {
  return Boolean(url && /rawg\.io/i.test(url));
}

const USAGE = `
fetch-igdb-posters — re-point every library and wishlist row at an IGDB or Steam
cover, touching no other metadata. Use it when only the artwork is stale.

Rows with a stored IGDB id are looked up directly; rows without one fall back to
the conservative title matcher. Steam-owned rows always get the portrait Steam
cover, locally uploaded posters are left alone, and stale RAWG CDN links are cut.

Usage:
  npm run fetch-igdb-posters             run it
  npm run fetch-igdb-posters -- --help   show this
`;

/** IGDB cover for a known id, or null when the game has no artwork. */
async function coverForId(igdbId: number, deps: IgdbDeps): Promise<string | null> {
  const rows = await deps.fetchFromIgdb("games", `fields cover.image_id; where id = ${igdbId};`);
  const game = (Array.isArray(rows) ? rows[0] : undefined) as IgdbRawGame | undefined;
  return deps.getIgdbImageUrl(game?.cover?.image_id);
}

async function run(): Promise<void> {
  const { default: db } = await import("../server/db");
  const { fetchFromIgdb, getIgdbImageUrl } = await import("../server/igdb");
  const { getSteamPosterImage } = await import("../server/steam");
  const { assertIgdbReachable, findIgdbMatch, sleep } = await import("./lib/igdb-match");
  const deps: IgdbDeps = { fetchFromIgdb, getIgdbImageUrl, getSteamPosterImage, assertIgdbReachable, findIgdbMatch, sleep };

  console.log("Refreshing posters (Steam covers for Steam rows, IGDB covers for the rest)...\n");

  const games = db.prepare(
    "SELECT id, title, year, igdb_id, poster_url, steam_appid FROM games ORDER BY id"
  ).all() as Row[];
  const wishlist = db.prepare(
    "SELECT id, title, year, igdb_id, poster_url FROM wishlist ORDER BY id"
  ).all() as Row[];

  const updateGame = db.prepare("UPDATE games SET poster_url = ?, updated_at = ? WHERE id = ?");
  const updateWishlist = db.prepare("UPDATE wishlist SET poster_url = ? WHERE id = ?");

  let steamCount = 0;
  let igdbCount = 0;
  let keptCount = 0;
  let clearedCount = 0;

  const processRows = async (label: string, rows: Row[], save: (row: Row, poster: string) => void) => {
    let igdbChecked = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      process.stdout.write(`[${label} ${i + 1}/${rows.length}] ${row.title}\n`);

      if (isLocalUpload(row.poster_url)) {
        keptCount++;
        console.log("   -> custom upload kept");
        continue;
      }

      if (row.steam_appid != null) {
        save(row, deps.getSteamPosterImage(row.steam_appid));
        steamCount++;
        console.log("   -> Steam cover");
        continue;
      }

      try {
        const igdbId = row.igdb_id;
        let cover: string | null = null;

        if (igdbId != null) {
          cover = await coverForId(igdbId, deps);
        } else {
          // Rows without a stored id come from manual entry (or an ambiguous
          // title) — hit IGDB once before doing any title search so a
          // misconfigured environment never silently skips everything.
          if (!igdbChecked) {
            igdbChecked = true;
            await deps.assertIgdbReachable();
          }
          const match = await deps.findIgdbMatch(row.title, row.year);
          cover = getIgdbImageUrl(match?.cover?.image_id);
        }

        if (cover) {
          save(row, cover);
          igdbCount++;
          console.log("   -> IGDB cover");
        } else if (isRawgUrl(row.poster_url)) {
          save(row, "");
          clearedCount++;
          console.log("   -> stale RAWG link removed (no IGDB cover found)");
        } else {
          keptCount++;
          console.log("   -> no new cover found; existing poster kept");
        }
      } catch (err: unknown) {
        console.error(`   -> failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      await deps.sleep(REQUEST_DELAY_MS);
    }
  };

  await processRows("library", games, (row, poster) => {
    updateGame.run(poster, Date.now(), row.id);
  });
  await processRows("wishlist", wishlist, (row, poster) => {
    updateWishlist.run(poster, row.id);
  });

  console.log("\n──────────────────────────────────────────────");
  console.log(`Steam covers  : ${steamCount}`);
  console.log(`IGDB covers   : ${igdbCount}`);
  console.log(`Kept as-is    : ${keptCount}`);
  console.log(`RAWG links cut: ${clearedCount}`);
  console.log("Poster refresh complete.");
}

/* One guard, at the entry point.

   It lives here rather than at the top of the file because `run()` is what pulls
   in the database-backed modules: ES module imports are hoisted, so a static
   `import db from "../server/db"` would open — and write to — the library even
   when this script was only asked what it would do.

   The explicit `else` matters as much as the exit: anything that intercepts
   `process.exit` — a test spy, an embedding host — would otherwise fall straight
   through into the branch that rewrites every poster in the library. */
if (wantsUsage(process.argv.slice(2))) {
  handleUsage(true, USAGE);
} else {
  run().catch((err) => {
    console.error("Poster refresh failed:", err);
    process.exit(1);
  });
}
