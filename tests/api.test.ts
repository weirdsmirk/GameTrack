import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import type { Express } from "express";

// Isolate the database + posters into a throwaway temp dir BEFORE importing
// the server modules (db.ts reads GAMETRACK_DATA_DIR at module load).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gametrack-test-"));
process.env.GAMETRACK_DATA_DIR = TMP;
process.env.PORT = "3210";
process.env.NODE_ENV = "test";

/* server.ts runs `import "dotenv/config"` at module load, so a developer with
   API_TOKEN set in their real .env got a 403 from every call in this file —
   23 of 27 tests red — and .env.example:24 actively recommends setting it. The
   same load pulls in the real IGDB_CLIENT_ID / IGDB_CLIENT_SECRET /
   STEAM_WEB_API_KEY, so the first person to add a test hitting /api/discover
   would silently make a live network call with the developer's credentials and
   get a different answer in CI. Neither belongs in a test process. */
delete process.env.API_TOKEN;
delete process.env.IGDB_CLIENT_ID;
delete process.env.IGDB_CLIENT_SECRET;
delete process.env.STEAM_WEB_API_KEY;

const ORIGIN = "http://localhost:3210";
const WITH_ORIGIN = { Origin: ORIGIN };

let app: Express;
let serverModule: typeof import("../server.ts");

/* Ids captured from the test that creates them, rather than hard-coded 1 and 2.
   The suite was order-coupled: those numbers only held if the seeding test ran
   first, so `vitest run --sequence.shuffle` failed 5 tests. Captured ids make
   each test depend on the fixture explicitly instead of on file order. */
let gameId = 0; // "Test Game"   — owns igdb_id 777001
let steamGameId = 0; // "Steam Game" — owns steam_appid 999991

beforeAll(async () => {
  // A minimal placeholder so the SPA-fallback test has something to serve on a
  // clean checkout. It goes in the temp dir, NOT in the repo's dist/: the old
  // version wrote into the real tree, so `npm test` created dist/index.html as a
  // side effect and the SPA test then passed against a placeholder rather than a
  // real `vite build` — a broken build was invisible to the suite, and the
  // leftover file made an unbuilt dist/ look built.
  const distIndex = path.join(TMP, "dist", "index.html");
  fs.mkdirSync(path.dirname(distIndex), { recursive: true });
  fs.writeFileSync(distIndex, "<!doctype html><title>gametrack test build</title>\n");
  process.env.GAMETRACK_DIST_DIR = path.join(TMP, "dist");

  serverModule = await import("../server.ts");
  app = await serverModule.createApp(true);
});

afterAll(async () => {
  // db.close() was missing, so a crashed run leaked the temp dir.
  const { default: db } = await import("../server/db");
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("API smoke tests", () => {
  it("GET /api/health reports db up", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: "up" });
  });

  it("rejects state-changing requests without an Origin (CSRF)", async () => {
    const res = await request(app).post("/api/games").send({ title: "X", status: "backlog" });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("origin");
  });

  it("rejects POST from a foreign origin", async () => {
    const res = await request(app)
      .post("/api/games")
      .set("Origin", "https://evil.example.com")
      .send({ title: "X", status: "backlog" });
    expect(res.status).toBe(403);
  });

  /* DNS rebinding: the attacker's page rebinds evil.com to 127.0.0.1, so its
     requests are same-origin to itself. CORS does not apply and a GET carries
     no Origin header — the origin gate above cannot catch it. Only a Host
     check can, so that is what these assert. */
  it("rejects a read request with a foreign Host header (DNS rebinding)", async () => {
    const res = await request(app).get("/api/export").set("Host", "evil.example");
    expect(res.status).toBe(403);
  });

  it("rejects a read request with no Host header", async () => {
    const res = await request(app).get("/api/games").set("Host", "");
    expect(res.status).toBe(403);
  });

  it("still serves a read request on an allowlisted host", async () => {
    const res = await request(app).get("/api/games").set("Host", `127.0.0.1:${process.env.PORT}`);
    expect(res.status).toBe(200);
  });

  it("rejects invalid JSON payloads cleanly", async () => {
    const res = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("JSON");
  });

  it("validates game input (empty title -> 400)", async () => {
    const res = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "   ", status: "backlog" });
    expect(res.status).toBe(400);
  });

  /* The two rows the id-dependent tests below operate on, seeded in beforeAll
     rather than inside a test. Capturing the ids was not enough on its own: the
     seeding *test* could still be shuffled to run after its dependents, so the
     captured ids were 0. A beforeAll fixture runs before every test in the
     block regardless of order, which is what actually makes the file
     shuffle-safe. */
  beforeAll(async () => {
    const first = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Test Game", status: "backlog", igdb_id: 777001, genres: ["Action"], year: 2020 });
    expect(first.status).toBe(201);
    expect(first.body.id).toBeGreaterThan(0);
    expect(first.body.genres).toEqual(["Action"]);
    gameId = first.body.id;

    const dupSteam = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Steam Game", status: "backlog", steam_appid: 999991 });
    expect(dupSteam.status).toBe(201);
    steamGameId = dupSteam.body.id;
  });

  it("POST /api/games -> 201, then duplicate igdb_id -> 409", async () => {
    const dup = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Test Game Dupe", status: "backlog", igdb_id: 777001 });
    expect(dup.status).toBe(409);

    const dupSteam2 = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Steam Game 2", status: "backlog", steam_appid: 999991 });
    expect(dupSteam2.status).toBe(409);
  });

  it("PUT /api/games/:id enforces uniqueness (409) and rejects bad ids (400)", async () => {
    // The Steam game trying to claim the other game's igdb_id -> unique violation
    const res = await request(app)
      .put(`/api/games/${steamGameId}`)
      .set(WITH_ORIGIN)
      .send({ igdb_id: 777001 });
    expect(res.status).toBe(409);

    // Setting the same value it already owns is a no-op, not a conflict
    const same = await request(app)
      .put(`/api/games/${gameId}`)
      .set(WITH_ORIGIN)
      .send({ igdb_id: 777001 });
    expect(same.status).toBe(200);

    const badId = await request(app).put("/api/games/0").set(WITH_ORIGIN).send({ title: "nope" });
    expect(badId.status).toBe(400);

    const ok = await request(app)
      .put(`/api/games/${gameId}`)
      .set(WITH_ORIGIN)
      .send({ status: "playing", playtime: 4.5 });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("playing");
    expect(ok.body.playtime).toBe(4.5);
  });

  it("partial PUT preserves fields that were omitted (zod defaults must not clobber)", async () => {
    // Seed distinctive values for every defaulted column.
    const seed = await request(app)
      .put(`/api/games/${gameId}`)
      .set(WITH_ORIGIN)
      .send({
        status: "completed",
        genres: ["Action", "RPG"],
        synopsis: "KEEP ME",
        poster_url: "/posters/keep.jpg",
        playtime: 12.5,
        title: "Keep Title",
      });
    expect(seed.status).toBe(200);

    // A partial update touching none of the defaulted fields.
    const partial = await request(app)
      .put(`/api/games/${gameId}`)
      .set(WITH_ORIGIN)
      .send({ critic_score: 90 });
    expect(partial.status).toBe(200);
    expect(partial.body.status).toBe("completed");
    expect(partial.body.genres).toEqual(["Action", "RPG"]);
    expect(partial.body.synopsis).toBe("KEEP ME");
    expect(partial.body.poster_url).toBe("/posters/keep.jpg");
    expect(partial.body.playtime).toBe(12.5);
    expect(partial.body.title).toBe("Keep Title");

    // An explicitly sent field still updates, including explicit clears.
    const explicit = await request(app)
      .put(`/api/games/${gameId}`)
      .set(WITH_ORIGIN)
      .send({ status: "backlog", genres: [] });
    expect(explicit.status).toBe(200);
    expect(explicit.body.status).toBe("backlog");
    expect(explicit.body.genres).toEqual([]);
    expect(explicit.body.poster_url).toBe("/posters/keep.jpg");
  });

  it("status transitions auto-stamp and preserve date_completed", async () => {
    // Backlog → no completion date
    const backlog = await request(app)
      .put(`/api/games/${gameId}`)
      .set(WITH_ORIGIN)
      .send({ status: "backlog", date_completed: null });
    expect(backlog.status).toBe(200);
    expect(backlog.body.date_completed).toBeNull();

    // Completed → stamped automatically
    const completed = await request(app)
      .put(`/api/games/${gameId}`)
      .set(WITH_ORIGIN)
      .send({ status: "completed" });
    expect(completed.status).toBe(200);
    expect(typeof completed.body.date_completed).toBe("number");
    expect(completed.body.date_completed).toBeGreaterThan(0);

    // Leaving completed preserves the historical completion date.
    const playing = await request(app)
      .put(`/api/games/${gameId}`)
      .set(WITH_ORIGIN)
      .send({ status: "playing" });
    expect(playing.status).toBe(200);
    expect(playing.body.date_completed).toBe(completed.body.date_completed);

    // Re-completing keeps the existing date unless the user explicitly changes it.
    const completedAgain = await request(app)
      .put(`/api/games/${gameId}`)
      .set(WITH_ORIGIN)
      .send({ status: "completed" });
    expect(completedAgain.status).toBe(200);
    expect(typeof completedAgain.body.date_completed).toBe("number");
  });

  it("corrupted JSON text columns don't break GET /api/games", async () => {
    // Directly corrupt a row's genres column to simulate legacy damage.
    const { default: db } = await import("../server/db");
    db.prepare("UPDATE games SET genres = '{broken json' WHERE id = ?").run(gameId);

    const res = await request(app).get("/api/games");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const row = res.body.find((g: any) => g.id === gameId);
    expect(row).toBeDefined();
    expect(Array.isArray(row.genres)).toBe(true);

    // /api/analytics reads the same column through json_each, which *raises* on
    // malformed JSON rather than returning nothing. It has to answer 200 on this
    // row too, so the damage is left in place and asserted against.
    const analytics = await request(app).get("/api/analytics");
    expect(analytics.status).toBe(200);
    expect(Array.isArray(analytics.body.genreAnalytics)).toBe(true);

    // Restore the row. The corruption is this test's fixture, not the library's
    // state: leaving it behind made every later test that reads genres through
    // SQL fail for a reason that had nothing to do with what they were checking.
    db.prepare("UPDATE games SET genres = '[\"Action\"]' WHERE id = ?").run(gameId);
  });

  it("DELETE /api/games/:id removes the row", async () => {
    const created = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Delete Target", status: "backlog" });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const res = await request(app).delete(`/api/games/${id}`).set(WITH_ORIGIN);
    expect(res.status).toBe(200);

    // Verified through GET /api/games, not GET /api/games/:id — there is no
    // such route, so the old assertion was really testing the catch-all 404
    // handler and would have passed even if DELETE were a no-op returning 200.
    const list = await request(app).get("/api/games");
    expect(list.body.map((g: { id: number }) => g.id)).not.toContain(id);
  });

  it("PUT /api/games/order persists the hand-arranged order and survives a partial PUT", async () => {
    const created = await Promise.all(
      ["Order Alpha", "Order Beta", "Order Gamma"].map((title) =>
        request(app).post("/api/games").set(WITH_ORIGIN).send({ title, status: "backlog" })
      )
    );
    const ids = created.map((r) => r.body.id as number);
    expect(ids.length).toBe(3);

    // Reject payloads missing games
    const partial = await request(app)
      .put("/api/games/order")
      .set(WITH_ORIGIN)
      .send({ ids: [ids[0], ids[1]] });
    expect(partial.status).toBe(400);

    // Order must cover the full library; put our games (reversed) first
    const all = await request(app).get("/api/games");
    const restIds = (all.body as any[]).map((g) => g.id as number).filter((id) => !ids.includes(id));
    const reversed = [...ids].reverse();
    const res = await request(app)
      .put("/api/games/order")
      .set(WITH_ORIGIN)
      .send({ ids: [...reversed, ...restIds] });
    expect(res.status).toBe(200);
    const byId = new Map<number, any>(res.body.map((g: any) => [g.id as number, g]));
    reversed.forEach((id, index) => {
      expect(byId.get(id)?.custom_order).toBe(index);
    });

    // A partial PUT (e.g. status change) must NOT clobber custom_order
    const update = await request(app)
      .put(`/api/games/${ids[0]}`)
      .set(WITH_ORIGIN)
      .send({ status: "playing" });
    expect(update.status).toBe(200);
    expect(update.body.custom_order).toBe(reversed.indexOf(ids[0]!));
    // Reload the library list: order must survive (persisted in the DB)
    const reloaded = await request(app).get("/api/games");
    const reloadedById = new Map<number, any>((reloaded.body as any[]).map((g) => [g.id as number, g]));
    expect(reloadedById.get(ids[0]!)?.custom_order).toBe(reversed.indexOf(ids[0]!));

    // DELETE resets everything back to null
    const cleared = await request(app).delete("/api/games/order").set(WITH_ORIGIN);
    expect(cleared.status).toBe(200);
    cleared.body.forEach((g: any) => expect(g.custom_order).toBeNull());

    // Cleanup
    await Promise.all(ids.map((id) => request(app).delete(`/api/games/${id}`).set(WITH_ORIGIN)));
  });

  // Renamed to say what it actually covers: there is no GET /api/games/:id
  // route, so this asserts the API fallthrough answers JSON 404 rather than
  // serving the SPA shell.
  it("unknown ids under /api return a JSON 404, not the SPA", async () => {
    const res = await request(app).get("/api/games/99999");
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
    expect(res.text).not.toContain("<!doctype html>");
  });

  it("POST /api/upload-poster rejects spoofed data URLs via magic bytes", async () => {
    // base64 of: <script>alert(1)</script> — claims to be image/png
    const res = await request(app)
      .post("/api/upload-poster")
      .set(WITH_ORIGIN)
      .send({ dataUrl: "data:image/png;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" });
    expect(res.status).toBe(400);

    const html = await request(app)
      .post("/api/upload-poster")
      .set(WITH_ORIGIN)
      .send({ dataUrl: "data:image/jpeg;base64,PCFET0NUWVBF" });
    expect(html.status).toBe(400);

    // 1x1 transparent PNG — should pass
    const ok = await request(app)
      .post("/api/upload-poster")
      .set(WITH_ORIGIN)
      .send({
        dataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      });
    expect(ok.status).toBe(200);
    expect(ok.body.url).toMatch(/^\/posters\/.+\.png$/);
  });

  it("GET /api/discover/game/:id rejects non-integer ids", async () => {
    const res = await request(app).get("/api/discover/game/12abc");
    expect(res.status).toBe(400);
    const neg = await request(app).get("/api/discover/game/-5");
    expect(neg.status).toBe(400);
  });

  it("unknown /api routes return JSON 404, not the SPA", async () => {
    const res = await request(app)
      .get("/api/nonexistent")
      .set("Accept", "text/html");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "API Route Not Found" });
  });

  it("unknown non-API routes serve the SPA for HTML navigation", async () => {
    const res = await request(app).get("/some/spa/route").set("Accept", "text/html");
    expect(res.status).toBe(200);
  });

  it("API responses carry no-store cache headers", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("app does not leak x-powered-by", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("GET /api/export downloads the full library as JSON", async () => {
    const res = await request(app).get("/api/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-type"]).toContain("application/json");
    const body = res.body;
    expect(Array.isArray(body)).toBe(true);
    // The seeded fixture rows, not "at least one row" — the old assertion
    // passed on whatever happened to be left in the library, so a shuffle that
    // ran the deleting tests first failed here and a genuinely empty export
    // would not have been caught.
    expect(body.length).toBeGreaterThanOrEqual(2);
    const game = body.find((g: { id: number }) => g.id === gameId);
    expect(game).toBeDefined();
    expect(game.title).toBeTruthy();
    expect(Array.isArray(game.genres)).toBe(true);
    expect(Array.isArray(game.owned_platforms)).toBe(true);
  });

  it("GET /api/settings/steam never returns a raw API key", async () => {
    const res = await request(app).get("/api/settings/steam");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("apiKey");
  });

  it("Wishlist CRUD and promote to library (/own)", async () => {
    // 1. Add item to wishlist
    const addRes = await request(app)
      .post("/api/wishlist")
      .set(WITH_ORIGIN)
      .send({
        title: "Wishlist Test Game",
        igdb_id: 888001,
        genres: ["RPG"],
        year: 2024,
        synopsis: "A great game",
        poster_url: "https://images.igdb.com/test.jpg",
        critic_score: 92,
      });
    expect(addRes.status).toBe(201);
    const wishlistItemId = addRes.body.id;
    expect(wishlistItemId).toBeGreaterThan(0);

    // 2. Duplicate igdb_id rejected
    const dupRes = await request(app)
      .post("/api/wishlist")
      .set(WITH_ORIGIN)
      .send({ title: "Wishlist Test Game 2", igdb_id: 888001 });
    expect(dupRes.status).toBe(409);

    // 3. GET wishlist contains the item
    const getRes = await request(app).get("/api/wishlist");
    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.body)).toBe(true);
    expect(getRes.body.some((item: any) => item.id === wishlistItemId)).toBe(true);

    // 4. Promote to library (/own)
    const ownRes = await request(app)
      .post(`/api/wishlist/${wishlistItemId}/own`)
      .set(WITH_ORIGIN);
    expect(ownRes.status).toBe(200);
    expect(ownRes.body.game.title).toBe("Wishlist Test Game");
    expect(ownRes.body.game.status).toBe("backlog");

    // 5. Wishlist no longer has the item
    const afterOwnRes = await request(app).get("/api/wishlist");
    expect(afterOwnRes.body.some((item: any) => item.id === wishlistItemId)).toBe(false);
  });

  it("POST /api/games/bulk-delete deletes multiple games atomically", async () => {
    // Create 3 games
    const g1 = await request(app).post("/api/games").set(WITH_ORIGIN).send({ title: "Bulk Game 1", status: "backlog" });
    const g2 = await request(app).post("/api/games").set(WITH_ORIGIN).send({ title: "Bulk Game 2", status: "backlog" });
    const g3 = await request(app).post("/api/games").set(WITH_ORIGIN).send({ title: "Bulk Game 3", status: "backlog" });
    expect(g1.status).toBe(201);
    expect(g2.status).toBe(201);
    expect(g3.status).toBe(201);

    const ids = [g1.body.id, g2.body.id, g3.body.id];

    // Bulk delete
    const deleteRes = await request(app)
      .post("/api/games/bulk-delete")
      .set(WITH_ORIGIN)
      .send({ ids });
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);
    expect(deleteRes.body.count).toBe(3);

    // Verify all are gone
    const checkRes = await request(app).get("/api/games");
    const existingIds = new Set(checkRes.body.map((g: any) => g.id));
    ids.forEach((id) => expect(existingIds.has(id)).toBe(false));
  });

  it("POST /api/wishlist/bulk-delete deletes multiple wishlist items atomically", async () => {
    const w1 = await request(app).post("/api/wishlist").set(WITH_ORIGIN).send({ title: "Bulk Wish 1" });
    const w2 = await request(app).post("/api/wishlist").set(WITH_ORIGIN).send({ title: "Bulk Wish 2" });
    expect(w1.status).toBe(201);
    expect(w2.status).toBe(201);

    const ids = [w1.body.id, w2.body.id];

    const bulkRes = await request(app)
      .post("/api/wishlist/bulk-delete")
      .set(WITH_ORIGIN)
      .send({ ids });
    expect(bulkRes.status).toBe(200);
    expect(bulkRes.body.ok).toBe(true);
    expect(bulkRes.body.count).toBe(2);

    const checkRes = await request(app).get("/api/wishlist");
    const existingIds = new Set(checkRes.body.map((item: any) => item.id));
    ids.forEach((id) => expect(existingIds.has(id)).toBe(false));
  });

  it("metadata edits set the metadata_custom flag; internal refreshes don't", async () => {
    // Fresh game starts uncustomized.
    const created = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Flag Game", status: "backlog", steam_appid: 555001 });
    expect(created.status).toBe(201);
    expect(created.body.metadata_custom ?? 0).toBe(0);

    // A status-only change is NOT a metadata edit.
    const statusOnly = await request(app)
      .put(`/api/games/${created.body.id}`)
      .set(WITH_ORIGIN)
      .send({ status: "playing" });
    expect(statusOnly.status).toBe(200);
    expect(statusOnly.body.metadata_custom ?? 0).toBe(0);

    // Editing the title IS a metadata edit.
    const titled = await request(app)
      .put(`/api/games/${created.body.id}`)
      .set(WITH_ORIGIN)
      .send({ title: "Flag Game (Custom)" });
    expect(titled.status).toBe(200);
    expect(titled.body.metadata_custom).toBe(1);

    // A poster URL change is a metadata edit too.
    const poster = await request(app)
      .put(`/api/games/${created.body.id}`)
      .set(WITH_ORIGIN)
      .send({ poster_url: "https://example.com/custom.jpg" });
    expect(poster.status).toBe(200);
    expect(poster.body.metadata_custom).toBe(1);

    // Internal provider refreshes pass metadata_custom: 0 and must NOT flag
    // the row nor clear an existing flag (0 = "leave as-is" for the flag).
    const internal = await request(app)
      .put(`/api/games/${created.body.id}`)
      .set(WITH_ORIGIN)
      .send({ synopsis: "provider refresh", metadata_custom: 0 });
    expect(internal.status).toBe(200);
    expect(internal.body.metadata_custom).toBe(1);
    expect(internal.body.synopsis).toBe("provider refresh");
  });

  // ── Ownership ("played but not owned") ──────────────────────────
  //
  // The rules worth pinning down, each of which was a plausible way to lose the
  // distinction between a game on the shelf and one borrowed at a friend's:
  //
  //  - the flag round-trips and defaults to owned
  //  - a partial PUT that omits it does NOT reset it (zod's .default() fires on
  //    omitted keys, so every column in PUT has to be gated on "was it sent")
  //  - platforms are refused on a not-owned title, on create and on update,
  //    because a platform is a copy in the user's own collection
  //  - the promotion endpoint marks its row owned, since that IS "I own this now"
  //  - the analytics split reconciles with the unrestricted totals

  it("stores ownership_status and defaults it to owned", async () => {
    const owned = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Ownership Default Game", status: "completed" });
    expect(owned.status).toBe(201);
    expect(owned.body.ownership_status).toBe("owned");

    const notOwned = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({
        title: "Played At Friends",
        status: "completed",
        ownership_status: "not_owned",
        playtime: 14.5,
        personal_rating: 8,
        date_completed: Date.now(),
      });
    expect(notOwned.status).toBe(201);
    expect(notOwned.body.ownership_status).toBe("not_owned");
    // Every other field is recorded in full — the distinction is about
    // ownership, not about how much of the game is tracked.
    expect(notOwned.body.playtime).toBe(14.5);
    expect(notOwned.body.personal_rating).toBe(8);
    expect(notOwned.body.status).toBe("completed");

    // Rejects a third state rather than storing it.
    const bogus = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Ownership Bogus", status: "backlog", ownership_status: "borrowed" });
    expect(bogus.status).toBe(400);

    await request(app).post("/api/games/bulk-delete").set(WITH_ORIGIN).send({
      ids: [owned.body.id, notOwned.body.id],
    });
  });

  it("drops platforms on a game marked Not Owned", async () => {
    // A platform records a copy in the user's own collection. A game they do not
    // own has none — the console, disc or account belongs to whoever has it — so
    // the tag cannot be set. The UI disables the control; this is the server
    // refusing to store it anyway, so an import or a sync cannot smuggle one in
    // past a disabled form.
    const created = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({
        title: "No Platforms Allowed",
        status: "backlog",
        ownership_status: "not_owned",
        owned_platforms: ["playstation", "steam"],
      });
    expect(created.status).toBe(201);
    expect(created.body.ownership_status).toBe("not_owned");
    expect(created.body.owned_platforms).toEqual([]);

    // Same on the update path, when the flip and the platforms arrive together.
    const flipped = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Flip To Not Owned", status: "backlog", owned_platforms: ["xbox"] });
    expect(flipped.body.owned_platforms).toEqual(["xbox"]);

    const res = await request(app)
      .put(`/api/games/${flipped.body.id}`)
      .set(WITH_ORIGIN)
      .send({ ownership_status: "not_owned", owned_platforms: ["xbox", "nintendo"] });
    expect(res.status).toBe(200);
    expect(res.body.ownership_status).toBe("not_owned");
    expect(res.body.owned_platforms).toEqual([]);

    // And back the other way: flipping to owned does not invent platforms, but
    // it does let them be set again.
    const back = await request(app)
      .put(`/api/games/${flipped.body.id}`)
      .set(WITH_ORIGIN)
      .send({ ownership_status: "owned", owned_platforms: ["nintendo"] });
    expect(back.body.ownership_status).toBe("owned");
    expect(back.body.owned_platforms).toEqual(["nintendo"]);

    await request(app).post("/api/games/bulk-delete").set(WITH_ORIGIN).send({
      ids: [created.body.id, flipped.body.id],
    });
  });

  it("a partial PUT that omits ownership_status leaves it untouched", async () => {
    // The zod `.default("owned")` on the schema fires for an OMITTED key, the
    // same trap every other column in this handler is guarded against. Without
    // the `sent()` gate, logging an hour on a borrowed game would quietly hand
    // it back to the collection — the exact distinction this flag exists for.
    const created = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Partial PUT Game", status: "backlog", ownership_status: "not_owned" });
    expect(created.body.ownership_status).toBe("not_owned");

    for (const patch of [
      { playtime: 3 },
      { status: "completed" },
      { personal_rating: 7 },
      { owned_platforms: ["nintendo"] },
      { hide_playtime: 1 },
    ]) {
      const res = await request(app)
        .put(`/api/games/${created.body.id}`)
        .set(WITH_ORIGIN)
        .send(patch);
      expect(res.status).toBe(200);
      expect(res.body.ownership_status).toBe("not_owned");
    }

    // And it moves back deliberately, both ways.
    const toOwned = await request(app)
      .put(`/api/games/${created.body.id}`)
      .set(WITH_ORIGIN)
      .send({ ownership_status: "owned" });
    expect(toOwned.body.ownership_status).toBe("owned");

    const toNotOwned = await request(app)
      .put(`/api/games/${created.body.id}`)
      .set(WITH_ORIGIN)
      .send({ ownership_status: "not_owned" });
    expect(toNotOwned.body.ownership_status).toBe("not_owned");

    await request(app).delete(`/api/games/${created.body.id}`).set(WITH_ORIGIN);
  });

  it("promoting a wishlist item produces an owned row", async () => {
    // The endpoint is the "I own this now" action, so its output is owned by
    // definition no matter what the wishlist entry carried.
    const add = await request(app)
      .post("/api/wishlist")
      .set(WITH_ORIGIN)
      .send({ title: "Wishlist Ownership Game", igdb_id: 888777 });
    expect(add.status).toBe(201);

    const own = await request(app).post(`/api/wishlist/${add.body.id}/own`).set(WITH_ORIGIN);
    expect(own.status).toBe(200);
    expect(own.body.game.ownership_status).toBe("owned");

    await request(app).delete(`/api/games/${own.body.game.id}`).set(WITH_ORIGIN);
  });

  it("the analytics split reconciles with the unrestricted totals", async () => {
    const a = await request(app).post("/api/games").set(WITH_ORIGIN)
      .send({ title: "Split Owned A", status: "backlog", playtime: 10 });
    const b = await request(app).post("/api/games").set(WITH_ORIGIN)
      .send({ title: "Split Owned B", status: "backlog", playtime: 4 });
    const c = await request(app).post("/api/games").set(WITH_ORIGIN)
      .send({ title: "Split Borrowed", status: "completed", ownership_status: "not_owned", playtime: 6 });
    const d = await request(app).post("/api/games").set(WITH_ORIGIN)
      .send({ title: "Split Borrowed Hidden", status: "backlog", ownership_status: "not_owned", playtime: 900, hide_playtime: 1 });

    const res = await request(app).get("/api/analytics");
    expect(res.status).toBe(200);
    const s = res.body.summary;

    // Counts reconcile exactly — this is what makes the split safe to display
    // next to the totals without the panel being able to contradict itself.
    expect(s.owned_games + s.not_owned_games).toBe(s.total_games);
    expect(s.not_owned_games).toBe(2);
    expect(s.owned_games).toBe(s.total_games - 2);

    // Hours too, and on the same hide_playtime rule as the hour totals beside
    // them: the 900-hour hidden borrowed title contributes to neither side.
    expect(s.owned_playtime_hours + s.not_owned_playtime_hours).toBeCloseTo(s.total_playtime_hours, 5);
    expect(s.not_owned_playtime_hours).toBe(6);

    await request(app).post("/api/games/bulk-delete").set(WITH_ORIGIN)
      .send({ ids: [a.body.id, b.body.id, c.body.id, d.body.id] });
  });

  it("POST /api/games/:id/reset-metadata validates the game and its IGDB link", async () => {
    // Unknown id -> 404
    const missing = await request(app).post("/api/games/999999/reset-metadata").set(WITH_ORIGIN);
    expect(missing.status).toBe(404);

    // Bad id -> 400
    const bad = await request(app).post("/api/games/0/reset-metadata").set(WITH_ORIGIN);
    expect(bad.status).toBe(400);

    // Game without an IGDB link -> 400 (no defaults to restore)
    const noLink = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "No Link Game", status: "backlog" });
    expect(noLink.status).toBe(201);
    const res = await request(app).post(`/api/games/${noLink.body.id}/reset-metadata`).set(WITH_ORIGIN);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("IGDB");
  });

  it("GET and PUT /api/settings/platforms manages custom platform tags", async () => {
    const putRes = await request(app)
      .put("/api/settings/platforms")
      .set(WITH_ORIGIN)
      .send({
        platforms: [
          { id: "custom-arcade", label: "Retro Arcade" },
          { id: "custom-itch", label: "itch.io" },
        ],
      });
    expect(putRes.status).toBe(200);
    expect(putRes.body.platforms).toHaveLength(2);

    const getRes = await request(app).get("/api/settings/platforms");
    expect(getRes.status).toBe(200);
    expect(getRes.body.platforms).toEqual([
      { id: "custom-arcade", label: "Retro Arcade" },
      { id: "custom-itch", label: "itch.io" },
    ]);
  });

  // The remaining data operations that touch a game row, checked for the flag.
  // Each of these writes the full row through a different code path, and each
  // was a place the ownership column could have been left to fall back to its
  // column default — silently turning a not-owned game back into an owned one.
  describe("ownership across data operations", () => {
    const newGame = async (over: Record<string, unknown> = {}) => {
      const res = await request(app).post("/api/games").set(WITH_ORIGIN).send({
        title: "Ops Game",
        status: "backlog",
        ownership_status: "not_owned",
        ...over,
      });
      expect(res.status).toBe(201);
      return res.body;
    };

    const readBack = async (id: number) => {
      const res = await request(app).get("/api/games");
      return res.body.find((g: { id: number }) => g.id === id);
    };

    it("survives an export/import round trip", async () => {
      const game = await newGame({ title: "Round Trip", playtime: 7, personal_rating: 9 });

      // Export carries the flag...
      const exported = await request(app).get("/api/export");
      expect(exported.status).toBe(200);
      const payload = exported.body.find((g: { id: number }) => g.id === game.id);
      expect(payload.ownership_status).toBe("not_owned");

      // ...and re-importing exactly that row restores it. Only this row is
      // removed rather than the whole library: `DELETE /api/wipe` would take out
      // fixtures other tests captured ids from, and the suite supports shuffled
      // ordering. A backup that silently dropped the flag would turn every
      // borrowed title back into an owned one on restore.
      await request(app).delete(`/api/games/${game.id}`).set(WITH_ORIGIN);
      const imported = await request(app)
        .post("/api/import")
        .set(WITH_ORIGIN)
        .send({ games: [payload] });
      expect(imported.status).toBe(200);
      expect(imported.body.imported).toBe(1);

      const restored = imported.body.imported === 1
        ? (await request(app).get("/api/games")).body.find(
            (g: { title: string }) => g.title === "Round Trip"
          )
        : undefined;
      expect(restored.ownership_status).toBe("not_owned");
      expect(restored.playtime).toBe(7);
      expect(restored.personal_rating).toBe(9);
      expect(restored.owned_platforms).toEqual([]);

      await request(app).delete(`/api/games/${restored.id}`).set(WITH_ORIGIN);
    });

    it("drops platforms on an imported not-owned row", async () => {
      // The import path does not go through the edit form, so the disabled
      // control is no protection here — a hand-edited or third-party backup can
      // carry both fields. The server invariant has to hold regardless.
      const res = await request(app)
        .post("/api/import")
        .set(WITH_ORIGIN)
        .send({
          games: [
            {
              title: "Imported Borrowed",
              status: "completed",
              ownership_status: "not_owned",
              owned_platforms: ["steam", "playstation"],
              playtime: 11,
            },
            {
              title: "Imported Owned",
              status: "backlog",
              owned_platforms: ["steam"],
            },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.imported).toBe(2);

      const all = (await request(app).get("/api/games")).body as {
        id: number; title: string; ownership_status: string; owned_platforms: string[];
      }[];
      const borrowed = all.find((g) => g.title === "Imported Borrowed")!;
      const owned = all.find((g) => g.title === "Imported Owned")!;
      expect(borrowed.ownership_status).toBe("not_owned");
      expect(borrowed.owned_platforms).toEqual([]);
      // The owned row keeps its platform, so the rule is not just stripping
      // platforms from everything that passes through the import.
      expect(owned.ownership_status).toBe("owned");
      expect(owned.owned_platforms).toEqual(["steam"]);

      await request(app).post("/api/games/bulk-delete").set(WITH_ORIGIN).send({
        ids: all.filter((g) => g.title.startsWith("Imported ")).map((g) => g.id),
      });
    });

    it("keeps the flag when the poster is reset", async () => {
      // reset-poster rewrites the whole row through updateGame. Before the flag
      // existed, that call passed `existing.owned_platforms`; it now passes the
      // stored value through the ownership invariant, which is the only thing
      // keeping the two in step.
      const game = await newGame({ title: "Poster Reset", poster_url: "https://example.com/x.jpg" });

      const res = await request(app).post(`/api/games/${game.id}/reset-poster`).set(WITH_ORIGIN);
      expect(res.status).toBe(200);
      expect(res.body.ownership_status).toBe("not_owned");
      expect(res.body.owned_platforms).toEqual([]);

      expect((await readBack(game.id)).ownership_status).toBe("not_owned");
      await request(app).delete(`/api/games/${game.id}`).set(WITH_ORIGIN);
    });

    it("resolves ownership when merging duplicates", async () => {
      // Keeper wins, like every other single-valued column in the merge, and the
      // platform union is dropped when the keeper is not-owned — a merge must
      // not be a way to hand a borrowed title a platform.
      const keepNotOwned = await newGame({ title: "Merge Keeper Borrowed" });
      const removeOwned = await request(app)
        .post("/api/games")
        .set(WITH_ORIGIN)
        .send({ title: "Merge Loser Owned", status: "backlog", owned_platforms: ["steam"] });
      expect(removeOwned.body.owned_platforms).toEqual(["steam"]);

      const merged = await request(app)
        .post("/api/duplicates/merge")
        .set(WITH_ORIGIN)
        .send({ keepId: keepNotOwned.id, removeId: removeOwned.body.id });
      expect(merged.status).toBe(200);
      expect(merged.body.ownership_status).toBe("not_owned");
      expect(merged.body.owned_platforms).toEqual([]);

      // And the other way: an owned keeper keeps the union of both platform lists.
      const keepOwned = await request(app)
        .post("/api/games")
        .set(WITH_ORIGIN)
        .send({ title: "Merge Keeper Owned", status: "backlog", owned_platforms: ["nintendo"] });
      const removeBorrowed = await newGame({ title: "Merge Loser Borrowed" });
      const merged2 = await request(app)
        .post("/api/duplicates/merge")
        .set(WITH_ORIGIN)
        .send({ keepId: keepOwned.body.id, removeId: removeBorrowed.id });
      expect(merged2.status).toBe(200);
      expect(merged2.body.ownership_status).toBe("owned");
      expect(merged2.body.owned_platforms).toEqual(["nintendo"]);

      await request(app).post("/api/games/bulk-delete").set(WITH_ORIGIN).send({
        ids: [keepNotOwned.id, keepOwned.body.id],
      });
    });

    it("reports a not-owned title's hours in the split and leaves the rest intact", async () => {
      // The zero side of the split has to be a real 0 rather than a missing
      // value: SUM over no matching rows returns NULL in SQLite, and every
      // consumer divides by these. A library that is entirely not-owned must
      // report owned_games: 0 and owned_playtime_hours: 0, not null — which is
      // asserted on the mixed library here by checking the owned side is
      // non-zero only because the library is mixed, and again below with the
      // borrowed row deleted from the arithmetic.
      const game = await newGame({ title: "Only Borrowed", playtime: 5 });

      const res = await request(app).get("/api/analytics");
      expect(res.status).toBe(200);
      const s = res.body.summary;

      expect(typeof s.owned_games).toBe("number");
      expect(typeof s.not_owned_games).toBe("number");
      expect(typeof s.owned_playtime_hours).toBe("number");
      expect(typeof s.not_owned_playtime_hours).toBe("number");
      expect(s.not_owned_games).toBeGreaterThanOrEqual(1);
      expect(s.not_owned_playtime_hours).toBeGreaterThanOrEqual(5);
      // The reconciling identities still hold with the row present.
      expect(s.owned_games + s.not_owned_games).toBe(s.total_games);
      expect(s.owned_playtime_hours + s.not_owned_playtime_hours).toBeCloseTo(
        s.total_playtime_hours,
        5
      );

      await request(app).delete(`/api/games/${game.id}`).set(WITH_ORIGIN);
    });
  });
});
