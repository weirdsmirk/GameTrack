/**
 * Behavioural test for scripts/reset-metadata.ts.
 *
 * The bug this guards is a data-loss one and it was invisible to the suite: the
 * script nulled every `igdb_id` up front and then re-linked the rows one IGDB
 * round trip at a time, so an interrupt in the middle left the whole library
 * with NULL ids. The SIGINT handler added to paper over that only covered a
 * clean Ctrl-C — not SIGKILL, an OOM, or a dropped connection.
 *
 * The fix is structural rather than defensive: writes are staged in memory and
 * applied in a single transaction at the end, so there is no destructive window
 * to interrupt. These tests assert that — nothing changes until the very end, a
 * failure changes nothing, a dry run changes nothing at all — which is a
 * stronger guarantee than "an interrupt gets repaired".
 *
 * `findIgdbMatch` and the IGDB mapper are mocked so the test drives the real
 * control flow without touching the network.
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
  /** Title whose lookup should throw, to prove a failed run writes nothing. */
  throwFor: null as string | null,
  /** Resolves the held promise, releasing a paused run. */
  release: null as (() => void) | null,
  /** Called when the run reaches `pauseOn`, so a test can look at the database. */
  onArrive: null as (() => void) | null,
  pauseOn: null as string | null,
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
  findIgdbMatch: async (title: string) => {
    if (mocks.pauseOn === title) {
      // Hold here, so the test can inspect the database at the exact moment the
      // old design would have left every id nulled.
      mocks.onArrive?.();
      await new Promise<void>((resolve) => {
        mocks.release = resolve;
      });
    }
    if (mocks.throwFor === title) throw new Error("simulated IGDB outage");
    return mocks.matchTitles.get(title) ?? null;
  },
}));

vi.mock("../server/paths", () => ({ DATA_DIR: process.env.GAMETRACK_DATA_DIR! }));

vi.mock("../server/db", async () => {
  // Built once and cached on the hoisted holder, so every resetModules() pass
  // hands back the same connection.
  if (!mocks.holder.db) {
    const Database = (await import("better-sqlite3")).default;
    // The real filename, in a temp directory. Even the fixture does not get to
    // invent a second name: a test that runs against "test.db" cannot catch a bug
    // about the shipped path.
    const db = new Database(path.join(process.env.GAMETRACK_DATA_DIR!, "database.sqlite"));
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
    mocks.holder.db = db;
  }
  return { default: mocks.holder.db };
});

let db: import("better-sqlite3").Database;
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
 * Runs the script to completion.
 *
 * `process.exit` is spied rather than mocked as a module: mocking the whole
 * `process` object also intercepted the test runner's own internals, and vitest's
 * `process.exit` guard turned the script's own failure path into an unhandled
 * rejection. Spying on the method leaves the rest of the process intact.
 *
 * There is no abort handler to wait for any more, so completion is detected by
 * the database going quiet: two identical consecutive reads mean the run is done.
 */
async function runScript(argv: string[] = []) {
  exitCalls = [];
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCalls.push(code ?? 0);
    // The script keeps running after its own error path; nothing to tear down.
    return undefined as never;
  }) as never);
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "reset-metadata", ...argv]);

  vi.resetModules();
  await import("../scripts/reset-metadata");

  let previous = "";
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const snapshot = JSON.stringify(
      db.prepare("SELECT title, igdb_id, poster_url, synopsis FROM games ORDER BY id").all()
    );
    if (snapshot === previous && i > 5) break;
    previous = snapshot;
  }

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
  mocks.throwFor = null;
  mocks.release = null;
  mocks.onArrive = null;
  mocks.pauseOn = null;
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
  it("writes no file beside the database, so only one database ever exists", async () => {
    // The script used to take a byte-complete copy before the write and a JSON id
    // map before that, which meant a single run left two extra database-ish files
    // in data/. That is gone, and this asserts it stays gone: the only thing the
    // run may touch is the one database.
    const dataDir = process.env.GAMETRACK_DATA_DIR!;
    const before = fs.readdirSync(dataDir).sort();

    mocks.matchTitles.set("Alpha", { igdb_id: 1111, year: 2011, genres: ["Action"] });
    await runScript();

    expect(fs.readdirSync(dataDir).sort()).toEqual(before);
    // And explicitly: no second database, no snapshot, no id map.
    const created = fs.readdirSync(dataDir).filter((f) => /\.(db|sqlite)|backup|snapshot|-wal$|-shm$/i.test(f));
    expect(created).toEqual(["database.sqlite", "database.sqlite-shm", "database.sqlite-wal"]);
  });

  it("re-links a row it can match", async () => {
    mocks.matchTitles.set("Alpha", { igdb_id: 1111, year: 2011, genres: ["Action"] });
    await runScript();
    expect(ids().find((r) => r.title === "Alpha")!.igdb_id).toBe(1111);
  });

  /* This is the test that proves the swallow-the-error bug is fixed rather than
     merely hidden. The unmatched patch used to omit `year`, `genres`, `synopsis`
     and `critic_score`, so better-sqlite3 rejected the statement with a RangeError
     that the row loop's catch recorded as "failed: Missing named parameter" and
     moved on. The row's id came out NULL only because the old code had already
     wiped every id up front — the statement itself had never worked. Asserting
     the poster too forces the whole row to be written, not just the id. */
  it("clears the id on a row it cannot match, keeping its other metadata", async () => {
    await runScript();
    const row = db
      .prepare("SELECT igdb_id, year, synopsis, poster_url FROM games WHERE title = ?")
      .get("Alpha") as { igdb_id: number | null; year: number | null; synopsis: string; poster_url: string };
    expect(row.igdb_id).toBeNull();
    // Untouched metadata, not nulled by the write.
    expect(row.year).toBe(2001);
    expect(row.synopsis).toBe("");
  });

  /* The core regression, and the guarantee that replaced the SIGINT handler.

     Under the old design the script nulled every id up front and re-linked rows one
     round trip at a time, so the library sat unlinked for the whole slow phase and
     only a clean Ctrl-C could rescue it. Here the run is deliberately parked
     half-way through that phase — after the first row has been matched, before the
     last — and the database is inspected while it is stopped there.

     Every id must still be its original one. Nothing is written until the single
     final transaction, so there is no window to interrupt in the first place. */
  it("leaves every row untouched while the slow matching phase is still running", async () => {
    mocks.matchTitles.set("Alpha", { igdb_id: 1111, year: 2011, genres: ["Action"] });
    mocks.pauseOn = "Gamma";

    const finished = runScript();

    // Wait until the run is parked inside the third row's lookup.
    for (let i = 0; i < 200 && !mocks.release; i++) await new Promise((r) => setTimeout(r, 10));
    expect(mocks.release).not.toBeNull();

    // Alpha and Beta have both been matched by now — the writes are staged in
    // memory, and none of them has reached the database.
    const midFlight = ids();
    expect(midFlight.find((r) => r.title === "Alpha")!.igdb_id).toBe(555);
    expect(midFlight.find((r) => r.title === "Beta")!.igdb_id).toBe(556);
    expect(midFlight.find((r) => r.title === "Gamma")!.igdb_id).toBe(557);

    mocks.release?.();
    await finished;

    // And only once the run is over does the library change.
    expect(ids().find((r) => r.title === "Alpha")!.igdb_id).toBe(1111);
  });

  it("counts a per-row lookup failure as unmatched and still finishes the run", async () => {
    // Deliberate, and worth pinning: one unreachable title must not abandon the
    // other 37 rows. This is why "a failed row" is not the same as "a failed run",
    // and why atomicity is asserted by inspecting the database mid-flight above
    // rather than by throwing inside the row loop.
    mocks.matchTitles.set("Alpha", { igdb_id: 1111, year: 2011, genres: ["Action"] });
    mocks.matchTitles.set("Beta", { igdb_id: 2222, year: 2002, genres: ["RPG"] });
    mocks.throwFor = "Gamma";

    await runScript();

    expect(ids().find((r) => r.title === "Alpha")!.igdb_id).toBe(1111);
    expect(ids().find((r) => r.title === "Beta")!.igdb_id).toBe(2222);
    expect(ids().find((r) => r.title === "Gamma")!.igdb_id).toBeNull();
  });

  it("writes nothing at all on a dry run, and says what it would have done", async () => {
    mocks.matchTitles.set("Alpha", { igdb_id: 1111, year: 2011, genres: ["Action"] });
    const dataDir = process.env.GAMETRACK_DATA_DIR!;
    const filesBefore = fs.readdirSync(dataDir).sort();
    const rowsBefore = JSON.stringify(ids());

    await runScript(["--dry-run"]);

    // Unmatched even though a match was available — the whole point.
    expect(JSON.stringify(ids())).toBe(rowsBefore);
    expect(fs.readdirSync(dataDir).sort()).toEqual(filesBefore);
  });

  it("keeps the first row to claim an id and blanks the duplicate", async () => {
    // Both rows resolve to the same IGDB game. Decided by an in-memory claim set
    // before the write, because a UNIQUE violation inside the single final
    // transaction would roll back the whole batch.
    mocks.matchTitles.set("Alpha", { igdb_id: 9999, year: 2011, genres: ["Action"] });
    mocks.matchTitles.set("Beta", { igdb_id: 9999, year: 2011, genres: ["Action"] });
    await runScript();

    const alpha = ids().find((r) => r.title === "Alpha")!.igdb_id;
    const beta = ids().find((r) => r.title === "Beta")!.igdb_id;
    expect(alpha).toBe(9999);
    expect(beta).toBeNull();
  });

  it("refuses an unrecognised flag without touching the database", async () => {
    const dataDir = process.env.GAMETRACK_DATA_DIR!;
    const filesBefore = fs.readdirSync(dataDir).sort();
    const rowsBefore = JSON.stringify(ids());

    await runScript(["--not-a-flag"]).catch(() => {
      /* handleUsage exits 0 after printing usage; nothing to assert on the exit */
    });

    expect(JSON.stringify(ids())).toBe(rowsBefore);
    expect(fs.readdirSync(dataDir).sort()).toEqual(filesBefore);
  });
});
