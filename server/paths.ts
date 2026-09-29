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
 * Compiled frontend assets. Overridable with GAMETRACK_DIST_DIR so the test
 * suite can serve its own placeholder without writing into the repo's dist/ —
 * which is what the suite used to do, and which made a broken `vite build`
 * invisible to the SPA-fallback test.
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
