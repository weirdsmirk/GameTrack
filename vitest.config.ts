import { defineConfig } from "vitest/config";

/**
 * `pool: "forks"` and `fileParallelism: false`.
 *
 * Four of these files each build a full Express app over their own temp SQLite
 * database (`createApp(true)`). Under the default `threads` pool the suite failed
 * roughly 1 run in 12 with a supertest-level socket error — `socket hang up`,
 * `ECONNRESET`, or `Parse Error: Expected HTTP/, RTSP/ or ICE/` — landing on a
 * *different* test each time. better-sqlite3 is a native addon whose connections
 * are not safe to share across worker threads, and several real HTTP servers
 * being brought up and torn down over those handles is what the parser tripped on.
 * `forks` gives each worker a real process; serialising the files removes the
 * remaining concurrency from app construction. Together this cut the observed rate
 * substantially (see the caveat below) and cost well under a second at this size.
 *
 * KNOWN ISSUE, NOT YET FIXED: a residual ~1-in-15 flake remains, of the same
 * socket-level family. Measured, not assumed:
 *   - server-backed files alone .......... 10/10 clean
 *   - jsdom component files alone ........ 10/10 clean
 *   - an explicit list of all 12 files ... 25/25 clean
 *   - plain `vitest run` / `--sequence.shuffle` ... ~1/12 fails
 * so it is order-dependent and cross-file, not a defect in any single file or in
 * the app. `db.close()` in the per-file `afterAll` was the obvious suspect and
 * removing it changed nothing (still 1/20). Not yet root-caused; do not treat a
 * lone socket error as a real regression without re-running.
 *
 * Generous timeouts below: the server files import and migrate a real database,
 * and the first run pays for better-sqlite3's native load.
 */
export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});