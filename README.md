# GameTrack

GameTrack is a local game library and backlog tracker. It helps you keep track of the games you own, what you are playing, your playtime, ratings, and completion dates.

It also includes Steam sync, IGDB discovery, library filters, analytics, and Markdown/CSV/JSON exports. Your data is stored locally in SQLite.

## Tech stack

- React and TypeScript
- Vite
- Tailwind CSS
- Node.js and Express
- SQLite with `better-sqlite3`
- Zustand
- IGDB and Steam APIs

## Requirements

- Node.js 22 or newer
- npm

## Setup

Install the dependencies:

```bash
npm install
```

Then create a `.env` file in the project root. Every variable is optional except
where noted, and the server boots fine with an empty one.

```env
# IGDB credentials — required for Discover and metadata lookup.
# From the Twitch Developer Portal (dev.twitch.tv/console/apps); IGDB is
# authenticated through Twitch's client-credentials flow.
IGDB_CLIENT_ID=your_twitch_client_id
IGDB_CLIENT_SECRET=your_twitch_client_secret

# Steam Web API key — required to sync your Steam library and track playtime.
STEAM_WEB_API_KEY=your_steam_web_api_key

# Bearer token for every /api request. Required whenever HOST is not a loopback
# address — the server refuses to start otherwise. Recommended even on loopback
# when the machine is shared. Set the matching VITE_API_TOKEN at build time for
# the web client to send it automatically; it is baked into the bundle, so treat
# it as a same-origin guard rather than a secret.
# API_TOKEN=change-me
# VITE_API_TOKEN=change-me

# Data directory, defaulting to ./data. Useful for container volumes.
# GAMETRACK_DATA_DIR=/path/to/data
# GAMETRACK_DIST_DIR=/path/to/dist

# Server binding and CORS.
# PORT=3001
# HOST=127.0.0.1
# NODE_ENV=development
# Extra browser origins allowed for state-changing requests, comma separated.
# The loopback address is always allowed; add your real domain when deploying.
# ALLOWED_ORIGINS=https://track.example.com

# Express hop count or a named subnet, e.g. "1" or "loopback", when running
# behind a reverse proxy. Leave unset to trust no proxy headers at all.
# TRUST_PROXY=loopback
```

## Run locally

Start the development server:

```bash
npm run dev
```

Then open [http://localhost:3001](http://localhost:3001).

The SQLite database and uploaded posters are stored in `data/` by default. Set `GAMETRACK_DATA_DIR` in `.env` to use another location.

The database is a single file, `data/database.sqlite`. That path is defined once, in `server/paths.ts`, and everything that needs it — the connection and the storage stats — reads it from there. The app takes no automatic backups and writes no second database: there is no backup directory, no snapshot, and no copy of the database anywhere in the project.

## Production

Build the frontend and server:

```bash
npm run build              # typechecks, then builds client and server bundles
```

Start the production server:

```bash
npm run start
```

`dist-server/server.cjs` is emitted with `--packages=external`, so it resolves
its dependencies from `node_modules` at runtime and must stay at the project
root. Moving `dist-server/` somewhere else — which is easy to do when
containerising — breaks it with `Cannot find module 'dotenv/config'`.

Note for a non-loopback deploy: the app is a personal single-user server. If you
expose it beyond localhost, set `API_TOKEN` (the server refuses to start without
it) and put it behind TLS. Plain-HTTP LAN access works, and no TLS means no
HSTS, so a token sent over it is readable on the wire.

## Useful commands

```bash
npm run typecheck          # check TypeScript (also runs as part of npm run build)
npm run clean              # remove build output
```

## Project layout

- `src/` contains the React app and UI components.
- `server/` contains the SQLite setup and API routes.
- `data/` contains local application data and is not committed.

GameTrack is designed for personal, local use, and it does not keep copies for
you. `data/database.sqlite` is the only database; if you want a second copy, take
it yourself — `Settings → Export Library JSON` writes a portable snapshot to a
location you choose, and the file itself is yours to copy or version as you like.