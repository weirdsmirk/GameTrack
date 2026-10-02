/**
 * Shared `--help` handling for the maintenance scripts.
 *
 * Both scripts are destructive: `reset-metadata` clears `igdb_id` on every row
 * before re-fetching, and `fetch-all-igdb-posters` rewrites artwork across the
 * library. Neither used to look at `process.argv` at all, so
 * `npm run reset-metadata -- --help` fell through to the real work and cleared
 * `igdb_id` on every row — asking the script what it did *was* the destructive
 * act.
 *
 * It lives in its own module rather than inside either script because both need
 * it before they import anything that opens the database. `import
 * "dotenv/config"` is safe to run early; `import db from "../server/db"` is not,
 * because `server/db.ts` calls `ensureSchemaIntegrity()` at module scope, so
 * merely importing it writes to the library. Keeping the guard in a
 * dependency-free module is what lets each script decide whether to open the
 * database *before* any import does it on its behalf.
 */

/**
 * Whether this invocation is asking about the script rather than running it.
 *
 * An unrecognised argument stops the script too: guessing is how a probe turns
 * into a rewrite, and neither script has a safe dry-run to fall back on.
 */
export function wantsUsage(argv: readonly string[]): boolean {
  const unknown = argv.filter((a) => !isKnownFlag(a));
  if (unknown.length > 0) {
    console.error(`Unrecognised argument: ${unknown[0]}`);
    return true;
  }
  return argv.some((a) => a === "--help" || a === "-h");
}

/** Flags every maintenance script accepts. Kept here so neither invents its own. */
const KNOWN_FLAGS = new Set(["--help", "-h", "--dry-run"]);

function isKnownFlag(arg: string): boolean {
  return KNOWN_FLAGS.has(arg);
}

/**
 * Whether the caller asked to see what would change without changing it.
 *
 * Worth having on a script that rewrites a whole library: the expensive part is
 * one round trip per row, so a dry run costs the same as the real thing and
 * answers the only question that matters beforehand — which rows will match, and
 * which will be left unlinked.
 */
export function wantsDryRun(argv: readonly string[]): boolean {
  return argv.includes("--dry-run");
}

/**
 * Print usage and exit, or return so the caller can start its real work.
 *
 * Exits rather than returning a "should stop" signal, so no caller can forget to
 * return and fall through into the code that writes.
 */
export function handleUsage(wantsIt: boolean, usage: string): void {
  if (!wantsIt) return;
  console.log(usage);
  process.exit(0);
}
