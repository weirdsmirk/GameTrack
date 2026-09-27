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

## Production

Build the frontend and server:

```bash
npm run build
```

Start the production server:

```bash
npm run start
```

## Useful commands

```bash
npm test                   # run tests
npm run typecheck          # check TypeScript
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

GameTrack is designed for personal, local use. Keep regular copies of the `data/` directory.