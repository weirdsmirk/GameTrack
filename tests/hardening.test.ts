/**
 * Regressions for the production-hardening pass. Each test names the specific
 * failure it exists to prevent, because every one of them was a live bug rather
 * than a hypothetical.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import type { Express } from "express";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gametrack-hardening-"));
process.env.GAMETRACK_DATA_DIR = TMP;
process.env.PORT = "3212";
process.env.NODE_ENV = "test";

delete process.env.API_TOKEN;
delete process.env.IGDB_CLIENT_ID;
delete process.env.IGDB_CLIENT_SECRET;
delete process.env.STEAM_WEB_API_KEY;

const ORIGIN = "http://localhost:3212";
const WITH_ORIGIN = { Origin: ORIGIN };

let app: Express;

beforeAll(async () => {
  const distIndex = path.join(TMP, "dist", "index.html");
  fs.mkdirSync(path.dirname(distIndex), { recursive: true });
  fs.writeFileSync(distIndex, "<!doctype html><title>gametrack test build</title>\n");
  process.env.GAMETRACK_DIST_DIR = path.join(TMP, "dist");
  const serverModule = await import("../server.ts");
  app = await serverModule.createApp(true);
});

afterAll(async () => {
  const { default: db } = await import("../server/db");
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const newGame = async (title: string, extra: Record<string, unknown> = {}) => {
  const res = await request(app).post("/api/games").set(WITH_ORIGIN).send({ title, ...extra });
  expect(res.status).toBe(201);
  return res.body.id as number;
};

describe("poster_url cannot be pointed off-origin", () => {
  it("rejects the protocol-relative form", async () => {
    const res = await request(app).post("/api/games").set(WITH_ORIGIN)
      .send({ title: "Protocol Relative", poster_url: "//evil.example/beacon.png" });
    expect(res.status).toBe(400);
  });

  it("rejects the BACKSLASH form of the same escape", async () => {
    /* The bug this pins: the guard was `!val.startsWith("//")`, which a leading
       "/\" sails straight past — while WHATWG URL parsing treats "\" as "/" in the
       relative-slope state, so the browser resolves it to the attacker's origin.
       Verified: new URL("/\\evil.example/x.png", "https://app.example/").href is
       "https://evil.example/x.png". A hostile import file therefore planted a
       tracking pixel on every card render. Production CSP blocked it; dev mode,
       which ships no CSP, did not. */
    const res = await request(app).post("/api/games").set(WITH_ORIGIN)
      .send({ title: "Backslash Relative", poster_url: "/\\evil.example/beacon.png" });
    expect(res.status).toBe(400);
  });

  it("rejects a backslash anywhere in an otherwise-local path", async () => {
    const res = await request(app).post("/api/games").set(WITH_ORIGIN)
      .send({ title: "Mid Backslash", poster_url: "/posters\\..\\evil.png" });
    expect(res.status).toBe(400);
  });

  it("still accepts the legitimate forms", async () => {
    for (const [title, poster] of [
      ["Local Poster", "/posters/abc.png"],
      ["Https Poster", "https://images.igdb.com/x.webp"],
      ["Http Poster", "http://example.com/x.png"],
      ["No Poster", ""],
    ] as const) {
      const res = await request(app).post("/api/games").set(WITH_ORIGIN).send({ title, poster_url: poster });
      expect(res.status, `${title} (${poster})`).toBe(201);
    }
  });

  it("rejects the same escapes through the import path, not just direct writes", async () => {
    // Import is the realistic delivery vehicle for a hostile file, so the check
    // has to hold there too — it runs the same schema per row.
    const res = await request(app).post("/api/import").set(WITH_ORIGIN)
      .send({ games: [{ title: "Hostile Backup", poster_url: "/\\evil.example/beacon.png" }] });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toBe(1);
  });
});

describe("a malformed JSON column cannot wedge the write path", () => {
  it("PUT succeeds against a row whose owned_platforms is a JSON object", async () => {
    /* `safeJsonParse` used to accept any `typeof === "object"`, so a stored '{}'
       passed as the string[] every caller assumes. The read side then handed the
       client an object (breaking the CSV export's .join), and the write side fed
       it to normalizePlatformIds, whose `for (const p of platforms)` threw
       "platforms is not iterable" INSIDE the update transaction — so the endpoint
       answered 500 for every field, forever, on an unrepairable row. */
    const id = await newGame("Shape Hole", { owned_platforms: ["steam"] });
    const { default: db } = await import("../server/db");
    db.prepare("UPDATE games SET owned_platforms = ? WHERE id = ?").run("{}", id);

    const res = await request(app).put(`/api/games/${id}`).set(WITH_ORIGIN)
      .send({ title: "Shape Hole Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Shape Hole Renamed");
    // And the read is an array again, not the object that was stored.
    expect(Array.isArray(res.body.owned_platforms)).toBe(true);
  });

  it("PUT succeeds when genres is a JSON object rather than an array", async () => {
    const id = await newGame("Genres Hole");
    const { default: db } = await import("../server/db");
    db.prepare("UPDATE games SET genres = ? WHERE id = ?").run('{"0":"RPG"}', id);

    const res = await request(app).put(`/api/games/${id}`).set(WITH_ORIGIN)
      .send({ title: "Genres Hole Renamed" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.genres)).toBe(true);
  });
});

describe("a fresh game defaults to one playthrough, not zero", () => {
  it("reports times_played 1 for a newly created row", async () => {
    const id = await newGame("Defaults");
    const list = await request(app).get("/api/games").set(WITH_ORIGIN);
    const row = list.body.find((g: { id: number }) => g.id === id);
    // The client renders `Played 1×` from this; a 0 or undefined would read as
    // "never played" and hide the badge entirely.
    expect(row.times_played).toBe(1);
    expect(row.replay_playtime).toBe(0);
  });
});

describe("the ownership/platform invariant still holds on every write path", () => {
  it("a not-owned game is stripped of platforms no matter how they arrive", async () => {
    const viaCreate = await request(app).post("/api/games").set(WITH_ORIGIN).send({
      title: "Borrowed Create", ownership_status: "not_owned", owned_platforms: ["playstation"],
    });
    expect(viaCreate.status).toBe(201);
    expect(viaCreate.body.owned_platforms).toEqual([]);

    const viaPut = await request(app).post("/api/games").set(WITH_ORIGIN)
      .send({ title: "Borrowed Put", ownership_status: "not_owned" });
    const flipped = await request(app).put(`/api/games/${viaPut.body.id}`).set(WITH_ORIGIN)
      .send({ owned_platforms: ["steam", "xbox"] });
    expect(flipped.body.owned_platforms).toEqual([]);
  });

  it("an omitted ownership_status on a partial PUT does not silently reset the flag", async () => {
    const id = await newGame("Not Owned Keep", { ownership_status: "not_owned" });
    const res = await request(app).put(`/api/games/${id}`).set(WITH_ORIGIN)
      .send({ title: "Not Owned Keep Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.ownership_status).toBe("not_owned");
  });
});