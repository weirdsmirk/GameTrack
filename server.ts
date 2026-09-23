import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import path from "path";
import crypto from "crypto";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import compression from "compression";
import { apiRouter, ensureDailyBackup } from "./server/routes";
import db from "./server/db";
import { DATA_DIR, DIST_DIR, POSTERS_DIR, ensureDataDir } from "./server/paths";

const PORT = Number.parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "127.0.0.1";

// A shared secret enables a lightweight bearer-token gate on all /api routes.
// When unset, the server trusts loopback access (single-user local mode).
const API_TOKEN = (process.env.API_TOKEN || "").trim();

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`Invalid PORT value: ${process.env.PORT}`);
  process.exit(1);
}

// Fail-closed: never bind to a non-loopback interface without a token.
// Otherwise any host that can reach the server gains full read/write/wipe.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
if (!API_TOKEN && HOST !== "127.0.0.1" && !LOOPBACK_HOSTS.has(HOST)) {
  console.error(
    "Refusing to start: binding to a non-loopback host requires API_TOKEN. " +
      "Set API_TOKEN in the environment (and pass it with every request) to expose the server."
  );
  process.exit(1);
}

ensureDataDir();

const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  ...(HOST !== "127.0.0.1" && HOST !== "localhost" ? [`http://${HOST}:${PORT}`] : []),
  // Explicit allowlist for deployment behind a real hostname/port.
  ...(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean),
]);

function tokenMatches(supplied: string): boolean {
  // Hash both sides first so a length mismatch can't leak the token length
  // through response timing before the constant-time compare runs.
  const a = crypto.createHash("sha256").update(supplied).digest();
  const b = crypto.createHash("sha256").update(API_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Build the express app without binding a port — used by the real server
 * (startServer) and by supertest in the API smoke tests. `production` skips
 * the Vite dev middleware and enables the strict CSP.
 */
export async function createApp(production = false) {
  const IS_PRODUCTION = production;
  const app = express();
  app.disable("x-powered-by");
  // Blindly trusting proxy headers makes every rate limit spoofable via a
  // forged X-Forwarded-For when no proxy is actually in front. Default: trust
  // nothing; operators behind a reverse proxy set TRUST_PROXY ("1", "loopback", ...).
  const TRUST_PROXY = (process.env.TRUST_PROXY || "").trim();
  app.set("trust proxy", TRUST_PROXY === "" ? false : Number.isNaN(Number(TRUST_PROXY)) ? TRUST_PROXY : Number(TRUST_PROXY));

  app.use(
    helmet({
      contentSecurityPolicy: IS_PRODUCTION
        ? {
            directives: {
              defaultSrc: ["'self'"],
              imgSrc: [
                "'self'",
                "data:",
                "https://images.igdb.com",
                "https://images.unsplash.com",
                "https://shared.cloudflare.steamstatic.com",
                "https://cdn.akamai.steamstatic.com",
                "https://cdn.cloudflare.steamstatic.com",
                "https://avatars.steamstatic.com",
                "https://avatars.akamai.steamstatic.com",
              ],
              styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
              fontSrc: ["'self'", "https://fonts.gstatic.com"],
              // Inline pre-paint scripts (theme + boot watchdog) are allowlisted
              // by content hash — strict 'self' otherwise.
              scriptSrc: [
                "'self'",
                "'sha256-IfX3zdfWtflM4c5LI8bjvAslWdZSg+McvPC4zV9NcKo='",
                "'sha256-VoY+16A4k/+tlxh36bABOBpkr6Zc2BX99Nr1ZRvLlU4='",
              ],
              connectSrc: ["'self'"],
              frameAncestors: ["'none'"],
              baseUri: ["'self'"],
              objectSrc: ["'none'"],
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
    })
  );

  // ── CSRF / origin protection ─────────────────────────────────────
  // State-changing requests from a browser always carry an Origin header.
  // Reject requests that are missing it or come from a non-allowlisted
  // origin (also covers the DNS-rebinding + prefix-confusion cases). Runs
  // before CORS so blocked requests return a clean 403, never a 500.
  const stateChanging = ["POST", "PUT", "DELETE"];
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!stateChanging.includes(req.method)) return next();
    // Origins are case-insensitive (scheme/host); normalize before comparing
    // so a differently-cased but allowlisted origin isn't wrongly rejected.
    const origin = req.headers.origin?.trim().toLowerCase();
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: "Forbidden: Invalid request origin." });
    }
    next();
  });

  app.use(
    cors({
      origin: (origin, callback) => {
        // Same-origin requests (no Origin header) are allowed; foreign origins
        // pass through WITHOUT CORS headers — the browser then drops the
        // response. (State-changing foreign requests never get this far.)
        callback(null, !origin || ALLOWED_ORIGINS.has(origin));
      },
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      credentials: true,
    })
  );

  app.use(compression());

  // ── Bearer-token auth gate (optional, disabled in local mode) ────
  if (API_TOKEN) {
    app.use("/api", (req: Request, res: Response, next: NextFunction) => {
      const header = req.headers.authorization || "";
      const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!supplied || !tokenMatches(supplied)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      next();
    });
  }

  // ── Rate limiting (API only — static assets stay unlimited) ──────
  // Mounted BEFORE the body parsers below: throttling must happen before
  // express buffers up to 80mb of request body, otherwise the per-route
  // limits on import/upload/restore are unreachable padding.
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  });
  app.use("/api", apiLimiter);

  const strictLimiter = rateLimit({
    // Discover traffic is paginated (every scroll batch is a request), search
    // as you type (each debounce pause is a request) and opens a details modal
    // per card — all of it served from the server-side IGDB cache. 20/min was
    // throttling legitimate browsing into 429s, which the UI rendered as an
    // endless "Loading more games…" spinner.
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests to this endpoint, please slow down." },
  });
  app.use("/api/discover", strictLimiter);

  const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many uploads, please slow down." },
  });
  app.use("/api/upload-poster", uploadLimiter);

  const syncLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 2,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Steam sync is already running or too frequent." },
  });
  app.use("/api/sync/steam", syncLimiter);

  // Steam-link attempts burn upstream Steam Web API calls — throttle hard
  // to keep the per-key quota safe and prevent profile-existence probing.
  // Scoped to PUT only: the frontend fires GET /api/settings/steam on every
  // Settings open, which must not consume link-attempt quota.
  const steamLinkLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many Steam link attempts, please slow down." },
  });
  app.put("/api/settings/steam", steamLinkLimiter);

  // Wiping deletes the whole library — throttle hard even though the UI
  // already gates it behind a typed confirmation.
  const wipeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many wipe attempts, please slow down." },
  });
  app.delete("/api/wipe", wipeLimiter);

  // Bigger per-route body limits: library imports and base64 poster uploads
  // legitimately exceed the default 1mb. These MUST be mounted before the
  // global parser — express parses the body on the first matching middleware,
  // so a 1mb global parser mounted first would 413 every large import/upload.
  app.use("/api/import", express.json({ limit: "25mb" }));
  app.use("/api/upload-poster", express.json({ limit: "4mb" }));
  app.use("/api/backups/restore-file", express.raw({ type: () => true, limit: "80mb" }));

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  // ── Request logging (access log) ─────────────────────────────────
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      if (req.path.startsWith("/api")) {
        console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
      }
    });
    next();
  });

  // No-cache headers for all API responses
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    next();
  });

  app.use("/api", apiRouter);

  // JSON 404 for unknown API routes — before the Vite/SPA fallback so dev
  // mode returns the same shape as production instead of an HTML 200.
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "API Route Not Found" });
  });

  // Serve locally uploaded custom posters from the data directory.
  // Filenames embed a timestamp + random id, so each URL is unique and
  // immutable — browsers never need to revalidate them.
  app.use(
    "/posters",
    express.static(POSTERS_DIR, {
      maxAge: "30d",
      immutable: true,
      etag: true,
      fallthrough: true,
    })
  );

  if (!IS_PRODUCTION) {
    console.log("Starting in DEVELOPMENT mode with Vite Middleware...");
    // Lazy-load Vite only in dev so the production bundle (e.g. Docker's
    // --omit=dev install) never has to resolve the devDependency.
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: {
        middlewareMode: true,
        // The app writes the sqlite DB (and profile.json) into data/ all the
        // time — watching it would make Vite full-reload the page on every
        // write. Build outputs must be ignored for the same reason.
        watch: { ignored: ["**/data/**", "**/dist/**", "**/dist-server/**", "**/*.tsbuildinfo"] },
        fs: {
          // Vite's dev server otherwise serves ANY file under the project root
          // — including the live SQLite database, its backups, and uploaded
          // posters — to any client that can reach the port, unauthenticated,
          // with no Origin gate on GET (DNS-rebinding reachable). Keep Vite's
          // built-in denies (.env, TLS keys) and add the data directory.
          deny: [".env", ".env.*", "*.{crt,pem}", DATA_DIR, `${DATA_DIR}/**`],
        },
      },
      appType: "spa",
    });
    // Belt-and-suspenders for plain-URL paths (fs.deny above covers /@fs/...):
    // never hand data-dir contents, env files, git metadata, or server sources
    // to the dev middleware — respond 404 before Vite sees the request.
    const DEV_SECRET_PREFIXES = ["/data", "/.env", "/.git", "/server", "/scripts", "/dist-server", "/coverage"];
    app.use((req: Request, res: Response, next: NextFunction) => {
      const p = req.path.replace(/\\/g, "/").toLowerCase();
      if (DEV_SECRET_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) {
        return res.status(404).send("Not Found");
      }
      next();
    });
    app.use(vite.middlewares);
  } else {
    console.log("Starting in PRODUCTION mode...");
    // Hashed assets (immutable) — everything else falls through to the SPA handler.
    app.use(
      "/assets",
      express.static(path.join(DIST_DIR, "assets"), {
        maxAge: "1y",
        immutable: true,
        etag: true,
      })
    );
    // Top-level static files (favicon, robots.txt, ...) — short cache.
    app.use(express.static(DIST_DIR, { index: false, maxAge: "1h", etag: true }));

    // SPA fallback: only for extensionless, HTML-accepting navigation requests.
    app.get("*", (req: Request, res: Response) => {
      if (req.path.startsWith("/api/")) {
        return res.status(404).json({ error: "API Route Not Found" });
      }
      const hasExtension = path.extname(req.path) !== "";
      if (hasExtension || !req.accepts("html")) {
        return res.status(404).send("Not Found");
      }
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(DIST_DIR, "index.html"), (err) => {
        // Without a callback an ENOENT (dist not built yet) would dump the
        // absolute filesystem path into the response body.
        if (err && !res.headersSent) {
          console.error("SPA fallback failed to serve index.html:", err.message);
          res.status(500).send("Internal Server Error");
        }
      });
    });
  }

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const errorObj = err as Record<string, unknown> | undefined;
    const errorMessage = err instanceof Error ? err.message : String(err || "Request failed");
    console.error("Global Error Handler:", errorMessage);
    if (errorObj?.type === "entity.too.large") {
      return res.status(413).json({ error: "Request payload too large" });
    }
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "Invalid JSON payload" });
    }
    const status = typeof errorObj?.status === "number" && Number.isInteger(errorObj.status) ? errorObj.status : 500;
    res.status(status).json({ error: status >= 500 ? "Internal Server Error" : errorMessage });
  });

  return app;
}

async function startServer() {
  const IS_PRODUCTION = process.env.NODE_ENV === "production";
  const app = await createApp(IS_PRODUCTION);

  // One local snapshot per day (keeps 5) — fire-and-forget, never blocks boot.
  void ensureDailyBackup();

  const server = app.listen(PORT, HOST, () => {
    console.log(`GameTrack server running on http://${HOST}:${PORT}${API_TOKEN ? " (API token auth enabled)" : ""}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use.`);
    } else {
      console.error("Server error:", err);
    }
    process.exit(1);
  });

  // Graceful shutdown: let active requests finish before exiting.
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    server.close(() => {
      console.log("Server closed.");
      db.close();
      console.log("Database connection closed. Exiting.");
      process.exit(0);
    });
    // Force exit if connections refuse to drain.
    setTimeout(() => {
      console.error("Forced shutdown after timeout.");
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Tests import this module to build an app via createApp() — never start the
// real listener (or schedule real Steam/IGDB calls) inside the test process.
if (process.env.NODE_ENV !== "test") {
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
