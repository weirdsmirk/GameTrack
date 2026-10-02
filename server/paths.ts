import path from "path";
import fs from "fs";

// Works in dev (tsx provides __dirname), the esbuild CJS bundle (native __dirname),
// and container/node execution without build warnings.
const HERE =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.join(process.cwd(), "server");

/**
 * Project root, derived from this file's location. Works identically in
 * development (tsx running from `server/`) and production (esbuild bundle
 * emitted into `dist-server/`), so the app never depends on process.cwd().
 */
export const ROOT_DIR = path.resolve(HERE, "..");

/** Data directory — override with GAMETRACK_DATA_DIR (e.g. container volumes). */
export const DATA_DIR = process.env.GAMETRACK_DATA_DIR
  ? path.resolve(process.env.GAMETRACK_DATA_DIR)
  : path.join(ROOT_DIR, "data");

export const POSTERS_DIR = path.join(DATA_DIR, "posters");

/**
 * The one database file, and the only place in the project that names it.
 *
 * Everything that needs the database — the connection and the storage stats —
 * reads `DB_PATH` from here rather than building a filename. That matters
 * because the filename used to appear in two places (`server/db.ts` and the
 * `/api/storage` size stat), and two places is one rename away from reporting the
 * size of a file that stopped existing.
 */
export const DB_FILE = "database.sqlite";

export const DB_PATH = path.join(DATA_DIR, DB_FILE);

/** SQLite's write-ahead log, which lives beside the database and must match its name. */
export const DB_WAL_PATH = `${DB_PATH}-wal`;

/**
 * Compiled frontend assets. Overridable with GAMETRACK_DIST_DIR so a container
 * can mount a prebuilt client separately from the project root.
 */
export const DIST_DIR = process.env.GAMETRACK_DIST_DIR
  ? path.resolve(process.env.GAMETRACK_DIST_DIR)
  : path.join(ROOT_DIR, "dist");

/** Ensure the data directory exists with restricted permissions. */
export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    return;
  }
  // Best-effort on existing dirs: operators and mounted volumes may manage
  // permissions themselves, and a denied chmod must never crash startup.
  try {
    fs.chmodSync(DATA_DIR, 0o700);
  } catch (err) {
    console.warn("Could not set data directory permissions:", err instanceof Error ? err.message : err);
  }
}
