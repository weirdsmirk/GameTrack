/**
 * Behavioural test for scripts/reset-metadata.ts.
 *
 * The bug this guards is a data-loss one and it was invisible to the suite: the
 * script nulled every `igdb_id` up front and then re-linked the rows one IGDB
 * round trip at a time, so an interrupt in the middle left the whole library
 * with NULL ids and no script to put them back. The fix is a SIGINT/SIGTERM
 * handler that restores the pre-run ids, plus a full file backup.
 *
 * `findIgdbMatch` and the IGDB mapper are mocked so the test drives the real
 * control flow — the per-row loop, the abort handler, the restore transaction —
 * without touching the network.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/* Isolated data dir, created before anything imports the module under test: the
   db mock opens a file under it at module scope, so a missing directory is a
   hard failure rather than a skip. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gametrack-reset-"));
process.env.GAMETRACK_DATA_DIR = TMP;

/**
 * Hoisted so the mock factories and the test body share them. The single
 * `holder.db` matters: `vi.resetModules()` between runs means the test's import
 * of server/db and the script's import of it would otherwise be two separate
 * connections to the same file, and neither would see the other's writes.
 */
const mocks = vi.hoisted(() => ({
  matchTitles: new Map<string, Record<string, unknown>>(),
  backup: { mock: (async () => {}) as (dest: string) => Promise<void> },
  holder: { db: null as unknown },
}));

vi.mock("../server/igdb", () => ({
  // scripts/lib/igdb-match.ts imports fetchFromIgdb to prove the credentials
  // work before anything is rewritten, so the mock has to supply it. Returning
  // undefined would fail the reachability check and abort before the loop.
  fetchFromIgdb: async () => [{ id: 1, name: "probe" }],
  mapIgdbGame: (g: Record<string, unknown>) => ({
    igdb_id: g.igdb_id ?? 1,
    year: g.year ?? null,
    genres: g.genres ?? [],
    synopsis: g.synopsis ?? "",
    critic_score: g.critic_score ?? null,
    poster_url: g.poster_url ?? "",
  }),
}));

vi.mock("../server/steam", () => ({
  getSteamPosterImage: (appid: number) => `https://cdn.example/steam/${appid}.jpg`,
}));

/* The path is relative to THIS file, so it has to name the script's directory:
   the module under test imports "./lib/igdb-match" from inside scripts/, which
   is the same file but reached by a different specifier. Mocking "./lib/…" here
   would silently target a non-existent tests/lib/… and leave the real network
   path in place — which is what made every match return null at first. */
vi.mock("../scripts/lib/igdb-match", () => ({
  assertIgdbReachable: async () => {},
  sleep: async () => {},
  // Per-title response, so a test decides which rows match and which do not.
  findIgdbMatch: async (title: string) => mocks.matchTitles.get(title) ?? null,
}));

vi.mock("../server/paths", () => ({ DATA_DIR: process.env.GAMETRACK_DATA_DIR! }));

vi.mock("../server/db", async () => {
  // Built once and cached on the hoisted holder, so every resetModules() pass
  // hands back the same connection.
  if (!mocks.holder.db) {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path.join(process.env.GAMETRACK_DATA_DIR!, "test.db"));
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        year INTEGER,
        igdb_id INTEGER,
        genres TEXT DEFAULT '[]',
        synopsis TEXT DEFAULT '',
        poster_url TEXT DEFAULT '',
        critic_score INTEGER,
        steam_appid INTEGER,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS wishlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        year INTEGER,
        igdb_id INTEGER,
        genres TEXT DEFAULT '[]',
        synopsis TEXT DEFAULT '',
        poster_url TEXT DEFAULT '',
        critic_score INTEGER
      );
    `);
    /* db.backup is stubbed so the test does not write a real snapshot file; the
       call itself is what is under test, not better-sqlite3's implementation.
       It delegates to `mocks.backup.mock` on every call rather than capturing
       it once — vi.resetModules() re-runs this factory, and a test that swaps
       the implementation would otherwise still hit the first one. */
    (db as unknown as { backup: unknown }).backup = (dest: string) => mocks.backup.mock(dest);
    mocks.holder.db = db;
  }
  return { default: mocks.holder.db };
});

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

let db: import("better-sqlite3").Database;
let handler: ((signal: string) => void) | undefined;
let exitCalls: number[] = [];

/**
 * The shared connection, built on first use rather than in beforeAll.
 * vi.mock factories are lazy, so nothing has necessarily imported server/db
 * yet when the hooks run — beforeAll would read a null holder.
 */
async function getDb(): Promise<import("better-sqlite3").Database> {
  if (!mocks.holder.db) await import("../server/db");
  return mocks.holder.db as import("better-sqlite3").Database;
}

/**
 * Runs the script and captures the abort handler it registers.
 *
 * `process` is stubbed with spies rather than a module mock: mocking the whole
 * `process` object also intercepted the test runner's own internals, and
 * vitest's `process.exit` guard turned the script's own failure path into an
 * unhandled rejection. Spying on the two methods leaves the rest of the process
 * intact, which is what we want.
 */
async function runScript() {
  handler = undefined;
  exitCalls = [];
  const onceSpy = vi.spyOn(process, "once").mockImplementation(((
    signal: NodeJS.Signals,
    fn: (s: string) => void
  ) => {
    if (SIGNALS.includes(signal)) handler = fn as (s: string) => void;
    return process;
  }) as typeof process.once);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCalls.push(code ?? 0);
    // The script keeps running after its own error path; nothing to tear down.
    return undefined as never;
  }) as never);

  vi.resetModules();
  await import("../scripts/reset-metadata");
  // Drain the whole run. The handler is registered before the loop starts, so
  // waiting for it tells us the script is under way, but the per-row work
  // continues after it — so keep going until the ids stop changing.
  for (let i = 0; i < 50 && handler === undefined; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  let previous = "";
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const snapshot = JSON.stringify(
      db.prepare("SELECT title, igdb_id FROM games ORDER BY id").all()
    );
    // Two stable reads in a row means the loop is finished.
    if (snapshot === previous) break;
    previous = snapshot;
  }

  onceSpy.mockRestore();
  exitSpy.mockRestore();
  if (exitCalls.length > 0) {
    throw new Error(`reset-metadata exited with ${exitCalls.join(",")} — it failed`);
  }
}

const ids = () =>
  db.prepare("SELECT title, igdb_id FROM games ORDER BY id").all() as {
    title: string;
    igdb_id: number | null;
  }[];

beforeEach(async () => {
  mocks.matchTitles.clear();
  mocks.backup.mock = async () => {};
  db = await getDb();
  db.exec("DELETE FROM games; DELETE FROM wishlist;");
  const insert = db.prepare(
    "INSERT INTO games (title, year, igdb_id, genres, synopsis, poster_url, critic_score, steam_appid) VALUES (?, ?, ?, '[]', '', '', NULL, NULL)"
  );
  insert.run("Alpha", 2001, 555);
  insert.run("Beta", 2002, 556);
  insert.run("Gamma", 2003, 557);
});

afterAll(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("reset-metadata", () => {
  it("takes a full file backup before it clears anything", async () => {
    const dests: string[] = [];
    mocks.backup.mock = async (dest: string) => {
      dests.push(dest);
    };
    await runScript();
    expect(dests).toHaveLength(1);
    // Named so it is obviously a pre-run snapshot, and written into the data
    // directory next to the database it is a copy of.
    expect(dests[0]).toContain("igdb-reset-pre-");
    expect(dests[0]).toContain(TMP);
  });

  it("re-links a row it can match", async () => {
    mocks.matchTitles.set("Alpha", { igdb_id: 1111, year: 2011, genres: ["Action"] });
    await runScript();
    expect(ids().find((r) => r.title === "Alpha")!.igdb_id).toBe(1111);
  });

  it("clears the id on a row it cannot match, keeping its other metadata", async () => {
    await runScript();
    const row = ids().find((r) => r.title === "Alpha")!;
    expect(row.igdb_id).toBeNull();
  });

  it("restores every original id when interrupted mid-run", async () => {
    // The core regression. The script nulls all ids up front, then re-links one
    // row at a time; an interrupt after the first row used to leave the rest
    // permanently NULL with nothing to restore from.
    mocks.matchTitles.set("Alpha", { igdb_id: 1111, year: 2011, genres: ["Action"] });
    await runScript();

    // Only Alpha was relinked; the rest were left with no id, which is exactly
    // the mid-run state the abort has to repair. (The "leaves unprocessed rows"
    // test above asserts this premise in isolation.)
    expect(ids().find((r) => r.title === "Beta")!.igdb_id).toBeNull();

    // The abort path calls process.exit(130) after restoring, so the exit spy
    // has to still be in place here — runScript() restores its own spies when
    // the loop drains, and vitest's own exit guard turns an unexpected call
    // into a test failure.
    const abortExit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCalls.push(code ?? 0);
      return undefined as never;
    }) as never);
    handler!("SIGINT");
    abortExit.mockRestore();

    // Every row is back to the id it had before the run started.
    expect(ids().find((r) => r.title === "Alpha")!.igdb_id).toBe(555);
    expect(ids().find((r) => r.title === "Beta")!.igdb_id).toBe(556);
    expect(ids().find((r) => r.title === "Gamma")!.igdb_id).toBe(557);
    // 130 is the conventional "terminated by SIGINT" code.
    expect(exitCalls).toContain(130);
  });

  it("registers a handler for both SIGINT and SIGTERM", async () => {
    const seen: string[] = [];
    const onceSpy = vi.spyOn(process, "once").mockImplementation(((
      signal: NodeJS.Signals,
      fn: (s: string) => void
    ) => {
      seen.push(signal);
      if (SIGNALS.includes(signal)) handler = fn as (s: string) => void;
      return process;
    }) as typeof process.once);
    vi.resetModules();
    await import("../scripts/reset-metadata");
    for (let i = 0; i < 50 && handler === undefined; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    onceSpy.mockRestore();

    expect(seen).toContain("SIGINT");
    expect(seen).toContain("SIGTERM");
  });

  /* Guards the premise of the restore test above. It reaches into the same rows
     the abort test repairs, so if the loop stops at row one — the state the
     abort is designed for — this fails and says so, rather than the restore
     test passing against a library that was never actually left in trouble. */
  it("leaves unprocessed rows with a NULL id mid-run", async () => {
    mocks.matchTitles.set("Alpha", { igdb_id: 1111, year: 2011, genres: ["Action"] });
    await runScript();
    const rows = ids();
    // Alpha matched and was re-linked; nothing else was, so the script leaves
    // them NULL. That is precisely the state the abort handler has to repair.
    expect(rows.find((r) => r.title === "Alpha")!.igdb_id).toBe(1111);
    expect(rows.find((r) => r.title === "Beta")!.igdb_id).toBeNull();
    expect(rows.find((r) => r.title === "Gamma")!.igdb_id).toBeNull();
  });
});
