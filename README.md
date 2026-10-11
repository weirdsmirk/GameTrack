# GameTrack

GameTrack is a simple, personal game tracker that runs locally on your computer. It helps you keep track of the games you own, the ones you want to play, your progress, playtime, ratings, and completion dates. It also lets you browse games, sync playtime from Steam, and see stats about your gaming habits.

Your library is stored locally in `data/`.

## Run it locally

You need Node.js 22 or newer and npm.

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001) in your browser.

GameTrack works without any API keys. To browse games from IGDB, add `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` to a `.env` file in the project folder. To sync your Steam library and playtime, add `STEAM_WEB_API_KEY`.

You can get IGDB credentials from the [Twitch Developer Console](https://dev.twitch.tv/console/apps) and a Steam API key from [Steam](https://steamcommunity.com/dev/apikey).

Your game library and poster images are stored in the `data/` folder. You can also export your library as a JSON file anytime from **Settings → Export Library JSON**.