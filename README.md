# GameTrack

A local game library and backlog tracker. Track what you own, what you're
playing, playtime, ratings, and completion dates. Includes Steam sync, IGDB
discovery, filters, analytics, and Markdown/CSV/JSON export.

React + TypeScript on Vite, Express, and SQLite via `better-sqlite3`. Data stays
on your machine.

## Requirements

Node.js 22 or newer, and npm.

## Setup

```bash
npm install
```

Optionally create a `.env` in the project root. The app runs without one; add
what you need:

```env
# Discover and metadata lookup (https://dev.twitch.tv/console/apps)
IGDB_CLIENT_ID=
IGDB_CLIENT_SECRET=

# Steam library sync and playtime
STEAM_WEB_API_KEY=

# Required if you expose the app beyond localhost
API_TOKEN=
```

## Run

```bash
npm run dev
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001).

## Production

```bash
npm run build   # typechecks, then builds the client and server bundles
npm start
```

`dist-server/server.cjs` resolves its dependencies from `node_modules` at
runtime, so it has to stay in the project root.

If you serve this beyond localhost, set `API_TOKEN` and put it behind TLS. It's a
personal single-user server.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Typecheck and build for production |
| `npm start` | Run the production server |
| `npm run typecheck` | Check types only |
| `npm run clean` | Delete build output |

## Data

Everything lives in `data/`, which isn't committed. The database is the single
file `data/database.sqlite`; uploaded posters go in `data/posters/`. Point
`GAMETRACK_DATA_DIR` elsewhere if you want them somewhere else.

There are no automatic backups and no second copy of the database. If you want
one, `Settings → Export Library JSON` writes a snapshot wherever you choose.

## Layout

- `src/` — React app and components
- `server/` — SQLite setup and API routes
- `data/` — local data, not committed