import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import type { Express } from "express";

/**
 * Replays — playthrough #2..n against one game row.
 *
 * The invariant under test throughout is that a game's own row stays playthrough
 * #1 with unchanged meaning, and that the denormalised totals on `games` can
 * never disagree with the `playthroughs` rows they summarise. Every mutation
 * recomputes them inside the same transaction, so the assertions here compare
 * the two against each other rather than against hard-coded numbers.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gametrack-replay-test-"));
process.env.GAMETRACK_DATA_DIR = TMP;
process.env.PORT = "3213";
process.env.NODE_ENV = "test";

delete process.env.API_TOKEN;
delete process.env.IGDB_CLIENT_ID;
delete process.env.IGDB_CLIENT_SECRET;
delete process.env.STEAM_WEB_API_KEY;

const ORIGIN = "http://localhost:3213";
const WITH_ORIGIN = { Origin: ORIGIN };

let app: Express;

beforeAll(async () => {
  const distIndex = path.join(TMP, "dist", "index.html");
  fs.mkdirSync(path.dirname(distIndex), { recursive: true });
  fs.writeFileSync(distIndex, "<!doctype html><title>gametrack test build</title>\n");
  process.env.GAMETRACK_DIST_DIR = path.join(TMP, "dist");
  const serverModule = await import("../server.ts");
  // `true` = production wiring (CSP, rate limiting) off; the smoke suite does the
  // same, so both files exercise the same middleware stack.
  app = await serverModule.createApp(true);
});

afterAll(async () => {
  // db.close() is not optional — without it a finished run leaks the temp dir and
  // holds the sqlite file open.
  const { default: db } = await import("../server/db");
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Create a game and return its id. Titles are unique per test to avoid the
 *  import/duplicate detection interfering with the fixtures. */
async function makeGame(title: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/games")
    .set(WITH_ORIGIN)
    .send({ title, status: "completed", playtime: 10, ...extra });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

const getGame = async (id: number) => {
  const res = await request(app).get("/api/games").set(WITH_ORIGIN);
  return res.body.find((g: { id: number }) => g.id === id);
};

const listRuns = async (id: number) => {
  const res = await request(app).get(`/api/games/${id}/playthroughs`).set(WITH_ORIGIN);
  return res.body;
};

describe("replays — the game row stays playthrough #1", () => {
  it("counts a freshly created game as played once", async () => {
    const id = await makeGame("Count Once");
    const game = await getGame(id);
    expect(game.times_played).toBe(1);
    expect(game.replay_playtime).toBe(0);
  });

  it("keeps the game's own playtime as run #1 rather than absorbing replays", async () => {
    const id = await makeGame("Run One Stays Put");
    await request(app)
      .post(`/api/games/${id}/playthroughs`)
      .set(WITH_ORIGIN)
      .send({ status: "completed", playtime: 25 });

    const game = await getGame(id);
    // The game row's playtime is untouched — it is run #1. A design that summed
    // replay hours into it would make saving an edit appear to do nothing.
    expect(game.playtime).toBe(10);
    // The replay hours live in their own column, and the count is 1 + runs.
    expect(game.replay_playtime).toBe(25);
    expect(game.times_played).toBe(2);
  });

  it("replays carry their own status, independent of the game's", async () => {
    const id = await makeGame("Mid Second Run");
    const res = await request(app)
      .post(`/api/games/${id}/playthroughs`)
      .set(WITH_ORIGIN)
      .send({ status: "playing", playtime: 4 });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("playing");
    // The game itself stays completed — this is exactly the state one status
    // per game could not represent.
    expect((await getGame(id)).status).toBe("completed");
  });

  it("defaults a bare 'I replayed this' row to unstarted with no date", async () => {
    const id = await makeGame("Bare Replay");
    const res = await request(app)
      .post(`/api/games/${id}/playthroughs`)
      .set(WITH_ORIGIN)
      .send({});
    expect(res.status).toBe(201);
    // Asserting the absence of invented detail, not a default: the server must
    // not back-date a run the user has only just started logging.
    expect(res.body.date_completed).toBeNull();
    expect(res.body.playtime).toBe(0);
    expect(res.body.sequence).toBe(2);
  });
});

describe("replays — sequence numbering", () => {
  it("numbers replays 2, 3, 4 and keeps them contiguous after a middle delete", async () => {
    const id = await makeGame("Sequenced");
    const created: number[] = [];
    for (const hours of [1, 2, 3]) {
      const res = await request(app)
        .post(`/api/games/${id}/playthroughs`)
        .set(WITH_ORIGIN)
        .send({ status: "completed", playtime: hours });
      created.push(res.body.id);
    }

    let runs = await listRuns(id);
    expect(runs.playthroughs.map((p: { sequence: number }) => p.sequence)).toEqual([2, 3, 4]);
    expect(runs.times_played).toBe(4);

    // Delete the MIDDLE run. A gap here would print as "Replay 2, Replay 4" in
    // the UI, which reads as a missing replay rather than a deleted one.
    const del = await request(app)
      .delete(`/api/playthroughs/${created[1]}`)
      .set(WITH_ORIGIN);
    expect(del.status).toBe(200);

    runs = await listRuns(id);
    expect(runs.playthroughs.map((p: { sequence: number }) => p.sequence)).toEqual([2, 3]);
    expect(runs.times_played).toBe(3);
    // Totals follow the delete: the surviving runs hold 1h + 3h = 4h.
    expect((await getGame(id)).replay_playtime).toBe(4);
  });
});

describe("replays — partial updates preserve omitted fields", () => {
  it("changes only the playtime when that is the only key sent", async () => {
    const id = await makeGame("Partial Update");
    const created = await request(app)
      .post(`/api/games/${id}/playthroughs`)
      .set(WITH_ORIGIN)
      .send({
        status: "completed",
        playtime: 12.5,
        personal_rating: 9,
        date_completed: 1735689600000,
        platform: "Friend console",
        notes: "NG+ run",
      });

    // Zod's `.default()` fires for absent keys on a partial schema, so reading
    // them straight off the parsed body would reset the whole row on any
    // unrelated edit — the same trap the games PUT documents.
    const updated = await request(app)
      .put(`/api/playthroughs/${created.body.id}`)
      .set(WITH_ORIGIN)
      .send({ playtime: 20 });

    expect(updated.status).toBe(200);
    expect(updated.body.playtime).toBe(20);
    expect(updated.body.status).toBe("completed");
    expect(updated.body.personal_rating).toBe(9);
    expect(updated.body.date_completed).toBe(1735689600000);
    expect(updated.body.platform).toBe("Friend console");
    expect(updated.body.notes).toBe("NG+ run");
  });

  it("lets a field be cleared explicitly with null", async () => {
    const id = await makeGame("Clear A Field");
    const created = await request(app)
      .post(`/api/games/${id}/playthroughs`)
      .set(WITH_ORIGIN)
      .send({ status: "completed", personal_rating: 8, platform: "Steam Deck" });

    const cleared = await request(app)
      .put(`/api/playthroughs/${created.body.id}`)
      .set(WITH_ORIGIN)
      .send({ personal_rating: null, platform: null });

    expect(cleared.body.personal_rating).toBeNull();
    expect(cleared.body.platform).toBeNull();
  });
});

describe("replays — aggregates never drift", () => {
  it("stays consistent across create, update and delete", async () => {
    const id = await makeGame("Never Drifts");

    const check = async () => {
      const game = await getGame(id);
      const { playthroughs } = await listRuns(id);
      expect(game.times_played).toBe(playthroughs.length + 1);
      const summed = playthroughs.reduce(
        (acc: number, p: { playtime: number }) => acc + p.playtime,
        0
      );
      expect(game.replay_playtime).toBeCloseTo(summed, 5);
    };

    await check();

    const a = await request(app).post(`/api/games/${id}/playthroughs`).set(WITH_ORIGIN)
      .send({ playtime: 5 });
    await check();

    await request(app).post(`/api/games/${id}/playthroughs`).set(WITH_ORIGIN)
      .send({ playtime: 7.5 });
    await check();

    await request(app).put(`/api/playthroughs/${a.body.id}`).set(WITH_ORIGIN)
      .send({ playtime: 11 });
    await check();

    await request(app).delete(`/api/playthroughs/${a.body.id}`).set(WITH_ORIGIN);
    await check();
  });

  it("reports reconciling analytics figures", async () => {
    const id = await makeGame("Analytics Reconcile");
    await request(app).post(`/api/games/${id}/playthroughs`).set(WITH_ORIGIN)
      .send({ status: "completed", playtime: 12 });

    const res = await request(app).get("/api/analytics").set(WITH_ORIGIN);
    const s = res.body.summary;

    // The three identities a view can rely on to label its figures honestly.
    expect(s.times_played - s.total_games).toBe(s.replay_runs);
    expect(s.total_playtime_hours + s.replay_playtime_hours).toBeCloseTo(
      s.all_playthroughs_hours,
      1
    );
    expect(s.most_times_played).toBeGreaterThanOrEqual(1);
    // Asserted against the summary rather than a literal: this file shares one
    // database, so a hard-coded count would depend on which test ran first. The
    // invariant worth pinning is that the two agree with each other.
    expect(res.body.mostReplayed.times_played).toBe(s.most_times_played);
  });

  it("leaves the registry's first-run total untouched by replay hours", async () => {
    const id = await makeGame("Legacy Total Intact");
    const before = (await request(app).get("/api/analytics").set(WITH_ORIGIN)).body.summary;

    await request(app).post(`/api/games/${id}/playthroughs`).set(WITH_ORIGIN)
      .send({ status: "completed", playtime: 40 });

    const after = (await request(app).get("/api/analytics").set(WITH_ORIGIN)).body.summary;

    // `total_playtime_hours` has always meant first-run hours and is the
    // numerator for the per-game average; widening it silently would inflate an
    // existing stat. The game (and its 10 first-run hours) already exists in
    // the `before` reading, so the assertion is that adding a replay moves this
    // figure by exactly nothing.
    expect(after.total_playtime_hours).toBe(before.total_playtime_hours);
    // Replay hours move only the all-runs figure, and only by what this game added.
    expect(after.replay_playtime_hours).toBeCloseTo(before.replay_playtime_hours + 40, 5);
    expect(after.all_playthroughs_hours).toBeCloseTo(
      before.all_playthroughs_hours + 40,
      1
    );
    // The identity itself, stated directly rather than only through deltas: this
    // is the reconciliation every replay-aware view relies on to label its
    // figures, and it must hold no matter what else the library contains.
    expect(after.all_playthroughs_hours).toBeCloseTo(
      after.total_playtime_hours + after.replay_playtime_hours,
      1
    );
  });
});

describe("replays — data integrity across other operations", () => {
  it("cascades a game delete away its replays", async () => {
    const id = await makeGame("Cascade Target");
    await request(app).post(`/api/games/${id}/playthroughs`).set(WITH_ORIGIN)
      .send({ status: "completed", playtime: 3 });
    await request(app).post(`/api/games/${id}/playthroughs`).set(WITH_ORIGIN)
      .send({ status: "completed", playtime: 4 });

    expect((await listRuns(id)).playthroughs).toHaveLength(2);
    const del = await request(app).delete(`/api/games/${id}`).set(WITH_ORIGIN);
    expect(del.status).toBe(200);

    const gone = await request(app).get(`/api/games/${id}/playthroughs`).set(WITH_ORIGIN);
    expect(gone.status).toBe(404);
  });

  it("keeps a duplicate merge's replays instead of cascading them away", async () => {
    // The whole point of re-parenting: folding two rows of one game together is
    // exactly when a user has logged several runs, and discarding them there
    // would lose the history at the moment it matters most.
    const keeper = await makeGame("Merge Keeper", { igdb_id: undefined });
    const loser = await makeGame("Merge Keeper", { igdb_id: undefined });

    await request(app).post(`/api/games/${keeper}/playthroughs`).set(WITH_ORIGIN)
      .send({ status: "completed", playtime: 4, notes: "keeper-run" });
    for (const [hours, note] of [[8, "loser-run-a"], [3, "loser-run-b"]] as const) {
      await request(app).post(`/api/games/${loser}/playthroughs`).set(WITH_ORIGIN)
        .send({ status: "completed", playtime: hours, notes: note });
    }

    const merged = await request(app)
      .post("/api/duplicates/merge")
      .set(WITH_ORIGIN)
      .send({ keepId: keeper, removeId: loser });
    expect(merged.status).toBe(200);

    const { playthroughs } = await listRuns(keeper);
    // All three survive, renumbered contiguously. Before the ordinals were parked
    // before the move, this hit UNIQUE (game_id, sequence) and answered 409.
    expect(playthroughs.map((p: { sequence: number }) => p.sequence)).toEqual([2, 3, 4]);
    /* ORDER MATTERS — this assertion used to `.sort()` the array, which made it
       blind to exactly the bug it was written for. The merge parks the keeper's
       ordinals and then parks everything again, which sorts the LOSER's runs
       ahead of the keeper's own and pushed the keeper's first replay from 2 to 4.
       The stated contract is that "the loser contributes its replays only", so
       the keeper's run must come first. Asserted in order, deliberately. */
    expect(playthroughs.map((p: { notes: string }) => p.notes))
      .toEqual(["keeper-run", "loser-run-a", "loser-run-b"]);
    expect((await getGame(keeper)).replay_playtime).toBe(15);
  });

  it("does not touch replays on a metadata reset", async () => {
    // reset-metadata restores title/year/genres/synopsis/score/poster and leaves
    // user data alone; replays are user data.
    const id = await makeGame("Reset Keeps Replays");
    await request(app).post(`/api/games/${id}/playthroughs`).set(WITH_ORIGIN)
      .send({ status: "completed", playtime: 9, notes: "survives" });

    // No igdb_id, so the endpoint answers 400 rather than calling IGDB — which is
    // exactly the assertion: the guard rejects the request before touching state.
    const reset = await request(app)
      .post(`/api/games/${id}/reset-metadata`)
      .set(WITH_ORIGIN)
      .send({});
    expect(reset.status).toBe(400);

    const { playthroughs } = await listRuns(id);
    expect(playthroughs).toHaveLength(1);
    expect(playthroughs[0].notes).toBe("survives");
  });

  it("round-trips replays through an export and import", async () => {
    const source = await makeGame("Backup Source");
    await request(app).post(`/api/games/${source}/playthroughs`).set(WITH_ORIGIN)
      .send({
        status: "completed", playtime: 33.25, personal_rating: 7,
        date_completed: 1735689600000, platform: "Steam Deck", notes: "first re-run",
      });
    await request(app).post(`/api/games/${source}/playthroughs`).set(WITH_ORIGIN)
      .send({ status: "playing", playtime: 4 });

    const exported = await request(app).get("/api/export").set(WITH_ORIGIN);
    expect(exported.status).toBe(200);
    const payload = JSON.parse(exported.text);
    const exportedGame = payload.find(
      (g: { title: string }) => g.title === "Backup Source"
    );
    // Nested under the game, so the importer never has to re-resolve ids.
    expect(exportedGame.playthroughs).toHaveLength(2);

    // Retitle so the import is not rejected as a duplicate of an existing row.
    exportedGame.title = "Backup Restored";
    exportedGame.igdb_id = null;
    exportedGame.steam_appid = null;
    const imported = await request(app)
      .post("/api/import")
      .set(WITH_ORIGIN)
      .send({ games: [exportedGame] });
    expect(imported.status).toBe(200);
    expect(imported.body.imported).toBe(1);

    const restored = (await request(app).get("/api/games").set(WITH_ORIGIN)).body.find(
      (g: { title: string }) => g.title === "Backup Restored"
    );
    const { playthroughs } = await listRuns(restored.id);
    expect(playthroughs).toHaveLength(2);
    expect(playthroughs[0].platform).toBe("Steam Deck");
    expect(playthroughs[0].notes).toBe("first re-run");
    expect(playthroughs[1].status).toBe("playing");
    expect(restored.times_played).toBe(3);
    expect(restored.replay_playtime).toBeCloseTo(37.25, 5);
  });

  it("refuses a replay for a game that does not exist", async () => {
    const res = await request(app)
      .post("/api/games/99999999/playthroughs")
      .set(WITH_ORIGIN)
      .send({ status: "completed" });
    expect(res.status).toBe(404);
  });

  it("validates the replay payload", async () => {
    const id = await makeGame("Validation Target");
    const bad = await request(app)
      .post(`/api/games/${id}/playthroughs`)
      .set(WITH_ORIGIN)
      .send({ status: "retired", playtime: -5, personal_rating: 44 });
    expect(bad.status).toBe(400);
    // The rejected request must not have created anything.
    expect((await listRuns(id)).playthroughs).toHaveLength(0);
  });
});