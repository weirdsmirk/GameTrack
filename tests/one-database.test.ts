// @vitest-environment node
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { DB_FILE, DB_PATH } from "../server/paths";

/**
 * The project has exactly one database: `data/database.sqlite`.
 *
 * This file exists because "one database" is not a property code has, it is a
 * property code keeps. Two separate defects in this repo's history both came from
 * the filename being written down a second time:
 *
 *   - `server/db.ts` opened `data/gametrack.db` while `/api/storage` measured
 *     `data/gametrack.db` independently. Renaming the database would have left the
 *     storage panel reporting the size of a file that no longer existed — and
 *     nothing would have failed, because both paths were valid strings.
 *   - `scripts/reset-metadata.ts` wrote two database-shaped files on every run
 *     (`db.backup()` plus a JSON id map), so `data/` accumulated copies that no
 *     code owned and nothing ever cleaned up.
 *
 * Neither is catchable by a test that only exercises behaviour. So this asserts
 * the invariant structurally: the filename is declared once, and no module is
 * permitted to name, copy or write a database of its own.
 */

const ROOT = path.resolve(__dirname, "..");
/** Every shipped source file that could plausibly reach the filesystem. */
const sourceFiles = () => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(ROOT, "server"));
  walk(path.join(ROOT, "scripts"));
  for (const name of ["server.ts"]) {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) out.push(full);
  }
  return out;
};

/** Strip comments so prose about databases cannot fail the scan. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("one database, one file", () => {
  it("lives at data/database.sqlite", () => {
    expect(DB_FILE).toBe("database.sqlite");
    expect(path.basename(DB_PATH)).toBe("database.sqlite");
    expect(path.basename(path.dirname(DB_PATH))).toBe("data");
  });

  it("declares the filename in exactly one place", () => {
    // Exactly one occurrence across server/ + scripts/ + server.ts: the constant
    // in server/paths.ts. A second one means some module has started naming the
    // database on its own, which is how the storage-stat drift happened — and no
    // behavioural test can catch it, because both paths are valid strings and
    // both "work".
    const occurrences: string[] = [];
    for (const file of sourceFiles()) {
      const body = code(fs.readFileSync(file, "utf8"));
      for (const hit of body.match(/"[^"]*\.sqlite(-wal|-shm)?"/g) ?? []) {
        occurrences.push(`${path.relative(ROOT, file)}: ${hit}`);
      }
    }
    expect(occurrences).toEqual([`server/paths.ts: "${DB_FILE}"`]);
  });

  it("has no module that names any database file at all", () => {
    // Stronger than the check above: not even the old `gametrack.db` may come back.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const body = code(fs.readFileSync(file, "utf8"));
      if (/"[^"]*\.db(-wal|-shm)?"/.test(body)) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it("never copies the database", () => {
    // `db.backup()`, `copyFile` and friends are exactly how the stray copies were
    // produced. Nothing in the app may write a second database file.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const body = code(fs.readFileSync(file, "utf8"));
      if (/\.backup\s*\(|\bcopyFile(Sync)?\s*\(|VACUUM\s+INTO/i.test(body)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("opens exactly one connection, on the shared path", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const body = code(fs.readFileSync(file, "utf8"));
      // Every `new Database(` must be the shared constant.
      const constructions = body.match(/new\s+Database\s*\(([^)]*)\)/g) ?? [];
      for (const c of constructions) {
        if (!/new\s+Database\s*\(\s*DB_PATH\s*\)/.test(c)) {
          offenders.push(`${path.relative(ROOT, file)}: ${c.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps data/ free of anything database-shaped", () => {
    const dataDir = path.join(ROOT, "data");
    if (!fs.existsSync(dataDir)) return; // fresh checkout: nothing to violate

    const strays = fs.readdirSync(dataDir).filter((name) =>
      /\.(db|sqlite)(-wal|-shm|-journal)?$/i.test(name) || /backup|snapshot|\.bak$/i.test(name)
    );
    // The one permitted entry, plus SQLite's own sidecars, which belong to it and
    // are not a second database.
    const permitted = new Set([
      DB_FILE,
      `${DB_FILE}-wal`,
      `${DB_FILE}-shm`,
      `${DB_FILE}-journal`,
    ]);
    expect(strays.filter((n) => !permitted.has(n))).toEqual([]);
  });
});
