/**
 * Validation and partial-failure tests for the write paths.
 *
 * These are regression guards for bugs that reached a running build: the import
 * batch aborting wholesale on one bad row, the duplicate check returning on the
 * first key it found, and out-of-range timestamps persisting into the date
 * columns. Each test here reproduces the original failure, so if the fix is
 * reverted the test fails rather than quietly passing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gametrack-validation-"));
process.env.GAMETRACK_DATA_DIR = TMP;
process.env.PORT = "3211";
process.env.NODE_ENV = "test";

// server.ts reads this at module load and gates every /api route on it. A
// developer with API_TOKEN set in their real .env would otherwise get a 403 on
// every call in this file. (.env.example tells people to set it.)
delete process.env.API_TOKEN;

/* The CSRF origin gate rejects state-changing requests with no Origin header
   and supertest does not send one by default — so these calls need it, exactly
   as tests/api.test.ts does. */
const ORIGIN = { Origin: "http://localhost:3211" };

let app: import("express").Express;

beforeAll(async () => {
  // Imported dynamically *after* the env var is set: server/paths.ts reads
  // GAMETRACK_DATA_DIR at module load, so a static import would bind the real
  // data directory instead of the temp one.
  const mod = await import("../server.ts");
  app = await mod.createApp(true);
});

afterAll(async () => {
  const { default: db } = await import("../server/db");
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const baseGame = (over: Record<string, unknown> = {}) => ({
  title: "Import Fixture",
  status: "backlog",
  genres: [],
  synopsis: "",
  poster_url: "",
  owned_platforms: [],
  playtime: 0,
  ...over,
});

describe("POST /api/import", () => {
  it("commits the good rows when one row collides on a unique key", async () => {
    // Two rows share a title; the second must be skipped, not abort the batch.
    const res = await request(app)
      .post("/api/import")
      .set(ORIGIN)
      .send({
        games: [
          baseGame({ title: "Batch Survivor A" }),
          baseGame({ title: "Batch Survivor A" }),
          baseGame({ title: "Batch Survivor B" }),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The whole point: B still lands. Before the savepoint fix the transaction
    // rolled back and B was silently lost behind a 500.
    expect(res.body.imported).toBe(2);
    expect(res.body.duplicates).toBe(1);

    const list = await request(app).get("/api/games");
    const titles = list.body.map((g: { title: string }) => g.title);
    expect(titles).toContain("Batch Survivor A");
    expect(titles).toContain("Batch Survivor B");
  });

  it("checks igdb_id and steam_appid independently", async () => {
    // A row whose igdb_id is new but whose steam_appid is already taken used to
    // pass the duplicate check (which returned on the first key present) and
    // then trip the partial unique index inside the transaction, killing the
    // entire batch. Both keys must be evaluated.
    const existing = await request(app)
      .post("/api/games")
      .set(ORIGIN)
      .send(baseGame({ title: "Steam Owner", steam_appid: 778610 }));
    expect(existing.status).toBe(201);

    const res = await request(app)
      .post("/api/import")
      .set(ORIGIN)
      .send({
        games: [
          baseGame({ title: "Cross Key Clash", igdb_id: 900001, steam_appid: 778610 }),
          baseGame({ title: "Cross Key Survivor" }),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.duplicates).toBe(1);

    const list = await request(app).get("/api/games");
    const titles = list.body.map((g: { title: string }) => g.title);
    expect(titles).not.toContain("Cross Key Clash");
    expect(titles).toContain("Cross Key Survivor");
  });
});

describe("timestamp validation", () => {
  it("rejects a negative date_added instead of persisting it", async () => {
    const res = await request(app)
      .post("/api/import")
      .set(ORIGIN)
      .send({ games: [baseGame({ title: "Negative Date", date_added: -1 })] });

    // The row fails validation, so it is counted as skipped rather than written.
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toBe(1);

    const list = await request(app).get("/api/games");
    expect(list.body.map((g: { title: string }) => g.title)).not.toContain("Negative Date");
  });

  it("rejects a date beyond the 2100 ceiling", async () => {
    const res = await request(app)
      .post("/api/games")
      .set(ORIGIN)
      .send(baseGame({ title: "Far Future", date_added: 999999999999999 }));

    expect(res.status).toBe(400);
  });

  it("still accepts a normal timestamp", async () => {
    const res = await request(app)
      .post("/api/games")
      .set(ORIGIN)
      .send(baseGame({ title: "Sane Date", date_added: 1786301752144 }));

    expect(res.status).toBe(201);
    expect(res.body.date_added).toBe(1786301752144);
  });
});

describe("completion date lifecycle", () => {
  it("stamps date_completed on entering completed", async () => {
    const created = await request(app)
      .post("/api/games")
      .set(ORIGIN)
      .send(baseGame({ title: "Stamp On Complete", status: "playing" }));
    expect(created.status).toBe(201);

    const res = await request(app)
      .put(`/api/games/${created.body.id}`)
      .set(ORIGIN)
      .send({ status: "completed" });

    expect(res.status).toBe(200);
    expect(typeof res.body.date_completed).toBe("number");
  });

  it("keeps the original date when a completed game is re-opened and re-finished", async () => {
    // date_completed is a historical record, not a cache of current status.
    // Leaving "completed" keeps the stamp, and re-completing must NOT stamp a
    // new one — otherwise replaying a game would rewrite its history and the
    // monthly completion chart would move a real event to today.
    const created = await request(app)
      .post("/api/games")
      .set(ORIGIN)
      .send(baseGame({ title: "Replayed Game", status: "playing" }));
    const id = created.body.id;

    const first = await request(app)
      .put(`/api/games/${id}`)
      .set(ORIGIN)
      .send({ status: "completed" });
    const originalDate = first.body.date_completed;
    expect(typeof originalDate).toBe("number");

    const reopened = await request(app)
      .put(`/api/games/${id}`)
      .set(ORIGIN)
      .send({ status: "playing" });
    expect(reopened.body.date_completed).toBe(originalDate);

    const again = await request(app)
      .put(`/api/games/${id}`)
      .set(ORIGIN)
      .send({ status: "completed" });
    expect(again.body.date_completed).toBe(originalDate);
  });

  it("honours an explicit date_completed over the automatic stamp", async () => {
    const created = await request(app)
      .post("/api/games")
      .set(ORIGIN)
      .send(baseGame({ title: "Backdated Finish", status: "playing" }));
    const id = created.body.id;

    const res = await request(app)
      .put(`/api/games/${id}`)
      .set(ORIGIN)
      .send({ status: "completed", date_completed: 1783881000000 });

    expect(res.status).toBe(200);
    expect(res.body.date_completed).toBe(1783881000000);
  });

  it("clears the date when the client explicitly sends null", async () => {
    const created = await request(app)
      .post("/api/games")
      .set(ORIGIN)
      .send(baseGame({ title: "Undated Finish", status: "playing" }));
    const id = created.body.id;

    await request(app).put(`/api/games/${id}`).set(ORIGIN).send({ status: "completed" });
    const res = await request(app)
      .put(`/api/games/${id}`)
      .set(ORIGIN)
      .send({ status: "playing", date_completed: null });

    expect(res.status).toBe(200);
    expect(res.body.date_completed).toBeNull();
  });
});

describe("poster_url validation", () => {
  it("rejects a protocol-relative URL", async () => {
    // "//evil.example/beacon.png" satisfies a bare startsWith("/") check, and the
    // client renders poster_url straight into an <img src> — so accepting it
    // turned a hostile import file into a request to an attacker-chosen host.
    // Production CSP img-src blocks the load, but dev mode serves no CSP at all.
    const res = await request(app)
      .post("/api/games")
      .set(ORIGIN)
      .send(baseGame({ title: "Protocol Relative", poster_url: "//evil.example/beacon.png" }));

    expect(res.status).toBe(400);
  });

  it("rejects a protocol-relative URL in an import row", async () => {
    const res = await request(app)
      .post("/api/import")
      .set(ORIGIN)
      .send({ games: [baseGame({ title: "Imported Beacon", poster_url: "//evil.example/beacon.png" })] });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toBe(1);
  });

  it("still accepts a normal local poster path", async () => {
    const res = await request(app)
      .post("/api/games")
      .set(ORIGIN)
      .send(baseGame({ title: "Local Poster", poster_url: "/posters/abc-123.png" }));

    expect(res.status).toBe(201);
    expect(res.body.poster_url).toBe("/posters/abc-123.png");
  });

  it("still accepts a remote https poster", async () => {
    const res = await request(app)
      .post("/api/games")
      .set(ORIGIN)
      .send(baseGame({ title: "Remote Poster", poster_url: "https://images.igdb.com/x.jpg" }));

    expect(res.status).toBe(201);
  });
});

describe("DELETE /api/wipe", () => {
  it("empties the library but keeps the wishlist and settings", async () => {
    // Documents the real contract. The UI toast once claimed "all local data
    // cleared", which was false; this test pins what actually survives so the
    // wording and the handler cannot drift apart again.
    await request(app).post("/api/wishlist").set(ORIGIN).send({ title: "Survivor Wishlist" });

    const res = await request(app).delete("/api/wipe").set(ORIGIN);
    expect(res.status).toBe(200);

    const games = await request(app).get("/api/games");
    expect(games.body).toHaveLength(0);

    const wishlist = await request(app).get("/api/wishlist");
    expect(wishlist.body.map((w: { title: string }) => w.title)).toContain("Survivor Wishlist");
  });
});
