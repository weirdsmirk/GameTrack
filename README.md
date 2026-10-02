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

- Node.js 20 or newer
- npm

## Setup

Install the dependencies:

```bash
npm install
```

Copy the example environment file:

```bash
cp .env.example .env
```

Add IGDB credentials to `.env` if you want to use game discovery and metadata lookup:

```env
IGDB_CLIENT_ID=your_twitch_client_id
IGDB_CLIENT_SECRET=your_twitch_client_secret
```

Steam sync is optional. Add a Steam Web API key if you want to use it:

```env
STEAM_WEB_API_KEY=your_steam_api_key
```

## Run locally

Start the development server:

```bash
npm run dev
```

Then open [http://localhost:3001](http://localhost:3001).

The SQLite database and uploaded posters are stored in `data/` by default. Set `GAMETRACK_DATA_DIR` in `.env` to use another location.

The database is a single file, `data/database.sqlite`. That path is defined once, in `server/paths.ts`, and everything that needs it — the connection, the storage stats, the tests — reads it from there. The app takes no automatic backups and writes no second database: there is no backup directory, no snapshot, and no copy of the database anywhere in the project.

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
npm test                   # run tests
npm run typecheck          # check TypeScript (also runs as part of npm run build)
npm run reset-metadata     # refresh library metadata from IGDB
npm run fetch-igdb-posters # refresh IGDB posters
npm run clean              # remove build output
```

## Project layout

- `src/` contains the React app and UI components.
- `server/` contains the SQLite setup and API routes.
- `scripts/` contains maintenance scripts.
- `tests/` contains API and UI tests.
- `data/` contains local application data and is not committed.

GameTrack is designed for personal, local use, and it does not keep copies for
you. `data/database.sqlite` is the only database; if you want a second copy, take
it yourself — `Settings → Export Library JSON` writes a portable snapshot to a
location you choose, and the file itself is yours to copy or version as you like.

`npm run reset-metadata` re-matches every row against IGDB. It writes nothing
until every row has been looked up and then applies all of it in a single
transaction, so an interrupted run leaves the library exactly as it was. Pass
`--dry-run` to see what it would change first.