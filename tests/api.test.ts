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

const ORIGIN = "http://localhost:3210";
const WITH_ORIGIN = { Origin: ORIGIN };

let app: Express;
let serverModule: typeof import("../server.ts");

beforeAll(async () => {
  // The SPA fallback serves dist/index.html in non-dev mode; create a minimal
  // placeholder when no build exists so a clean checkout can run the suite.
  const distIndex = path.join(__dirname, "..", "dist", "index.html");
  if (!fs.existsSync(distIndex)) {
    fs.mkdirSync(path.dirname(distIndex), { recursive: true });
    fs.writeFileSync(distIndex, "<!doctype html><title>gametrack test build</title>\n");
  }
  serverModule = await import("../server.ts");
  app = await serverModule.createApp(true);
});

afterAll(() => {
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

  it("POST /api/games -> 201, then duplicate igdb_id -> 409", async () => {
    const first = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Test Game", status: "backlog", igdb_id: 777001, genres: ["Action"], year: 2020 });
    expect(first.status).toBe(201);
    expect(first.body.id).toBeGreaterThan(0);
    expect(first.body.genres).toEqual(["Action"]);

    const dup = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Test Game Dupe", status: "backlog", igdb_id: 777001 });
    expect(dup.status).toBe(409);

    const dupSteam = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Steam Game", status: "backlog", steam_appid: 999991 });
    expect(dupSteam.status).toBe(201);

    const dupSteam2 = await request(app)
      .post("/api/games")
      .set(WITH_ORIGIN)
      .send({ title: "Steam Game 2", status: "backlog", steam_appid: 999991 });
    expect(dupSteam2.status).toBe(409);
  });

  it("PUT /api/games/:id enforces uniqueness (409) and rejects bad ids (400)", async () => {
    // Game 2 ("Steam Game") trying to claim game 1's igdb_id -> unique violation
    const res = await request(app)
      .put("/api/games/2")
      .set(WITH_ORIGIN)
      .send({ igdb_id: 777001 });
    expect(res.status).toBe(409);

    // Setting the same value it already owns is a no-op, not a conflict
    const same = await request(app)
      .put("/api/games/1")
      .set(WITH_ORIGIN)
      .send({ igdb_id: 777001 });
    expect(same.status).toBe(200);

    const badId = await request(app).put("/api/games/0").set(WITH_ORIGIN).send({ title: "nope" });
    expect(badId.status).toBe(400);

    const ok = await request(app)
      .put("/api/games/1")
      .set(WITH_ORIGIN)
      .send({ status: "playing", playtime: 4.5 });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("playing");
    expect(ok.body.playtime).toBe(4.5);
  });

  it("partial PUT preserves fields that were omitted (zod defaults must not clobber)", async () => {
    // Seed distinctive values for every defaulted column.
    const seed = await request(app)
      .put("/api/games/1")
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
      .put("/api/games/1")
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
      .put("/api/games/1")
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
      .put("/api/games/1")
      .set(WITH_ORIGIN)
      .send({ status: "backlog", date_completed: null });
    expect(backlog.status).toBe(200);
    expect(backlog.body.date_completed).toBeNull();

    // Completed → stamped automatically
    const completed = await request(app)
      .put("/api/games/1")
      .set(WITH_ORIGIN)
      .send({ status: "completed" });
    expect(completed.status).toBe(200);
    expect(typeof completed.body.date_completed).toBe("number");
    expect(completed.body.date_completed).toBeGreaterThan(0);

    // Leaving completed preserves the historical completion date.
    const playing = await request(app)
      .put("/api/games/1")
      .set(WITH_ORIGIN)
      .send({ status: "playing" });
    expect(playing.status).toBe(200);
    expect(playing.body.date_completed).toBe(completed.body.date_completed);

    // Re-completing keeps the existing date unless the user explicitly changes it.
    const completedAgain = await request(app)
      .put("/api/games/1")
      .set(WITH_ORIGIN)
      .send({ status: "completed" });
    expect(completedAgain.status).toBe(200);
    expect(typeof completedAgain.body.date_completed).toBe("number");
  });

  it("corrupted JSON text columns don't break GET /api/games", async () => {
    // Directly corrupt a row's genres column to simulate legacy damage.
    const { default: db } = await import("../server/db");
    db.prepare("UPDATE games SET genres = '{broken json' WHERE id = 1").run();

    const res = await request(app).get("/api/games");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const row = res.body.find((g: any) => g.id === 1);
    expect(row).toBeDefined();
    expect(Array.isArray(row.genres)).toBe(true);
  });

  it("DELETE /api/games/:id works", async () => {
    const res = await request(app).delete("/api/games/2").set(WITH_ORIGIN);
    expect(res.status).toBe(200);
    const gone = await request(app).get("/api/games/2");
    expect(gone.status).toBe(404);
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

  it("GET /api/games/:id -> 404 for missing", async () => {
    const res = await request(app).get("/api/games/99999");
    expect(res.status).toBe(404);
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
    expect(body.length).toBeGreaterThanOrEqual(1);
    const game = body[0];
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

  it("GET /api/export/db downloads a valid SQLite database snapshot", async () => {
    const res = await request(app).get("/api/export/db").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.sqlite3");
    expect(res.headers["content-disposition"]).toContain("gametrack-backup-");
    expect(res.headers["content-disposition"]).toContain(".db");
    // SQLite files start with the magic header "SQLite format 3\0".
    const body = res.body as Buffer;
    expect(body.length).toBeGreaterThan(100);
    expect(body.subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
    // The temp snapshot is removed once the transfer completes.
    await new Promise((r) => setTimeout(r, 100));
    const leftovers = fs.readdirSync(TMP).filter((f) => f.startsWith(".backup-"));
    expect(leftovers).toEqual([]);
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
});
