# GameTrack

GameTrack is a personal game library and backlog tracker that runs on your computer. Keep track of games you own or want to play, their status, playtime, ratings, and completion dates. You can also browse games, sync playtime from Steam, and view library stats.

Your library is stored locally in `data/`.

## Run it locally

You need Node.js 22 or newer and npm.

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001) in your browser.

GameTrack works without API keys. To browse the IGDB game catalog, add `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` to a `.env` file in the project folder. To sync your Steam library and playtime, add `STEAM_WEB_API_KEY`. You can get IGDB credentials from the [Twitch Developer Console](https://dev.twitch.tv/console/apps); Steam API keys are available from [Steam](https://steamcommunity.com/dev/apikey).

Your library database and poster images are saved in `data/`. Export a JSON copy from **Settings → Export Library JSON** if you want a backup.
