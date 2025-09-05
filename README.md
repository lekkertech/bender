# Slack Bot (TypeScript, Slack Bolt)

Minimal Slack bot using TypeScript and Slack Bolt. Defaults to Socket Mode (no public URL), with optional Events API (HTTP) support.

## Features
- Boom Game module (isolated):
  - Detect single-emoji messages in `#capetown` between 12:00:00–12:59:59
  - Per-game podium scoring: 1st=5, 2nd=3, 3rd=1 (unique users)
  - Count valid emoji posts; when thresholds met (≥3 of each), post daily podium + week-to-date leaderboard
  - Immediately crown weekly winner(s) after Friday :boom: placement; leaderboard resets weekly (Mon)
  - If any boom emoji is posted outside the window, after a game’s podium is full, or after the day is closed, the bot adds a :clown_face: reaction on that message
- Fun interactions (mentions):
  - Commands are optional and defined via `FUN_CONFIG` (see `data/fun-commands.json.example`). There are no built-in defaults.
  - If no commands are configured, only the chat fallback (below) is used for non-"leaderboard" mentions.
  - Rate limits: 1 request per user per minute, 20 requests per channel per minute
- Chat fallback for non-command mentions:
  - When a user mentions the bot and it’s not a defined Fun command (and not "leaderboard"), the bot replies using an AI fallback.
  - History is in-memory only, keyed by channel, and pruned by configurable caps. Replies honor `DEFAULT_REPLY_MODE` (thread or channel).
  - Configure via CHAT_* env vars; see docs/CONFIG.md.
- Socket Mode by default; optional Events API
- Incoming event logging to aid development
- Channel allowlist and dedupe middleware in place
- Feature toggles via `FEATURES` env (default: `boom,fun`)

## Setup
1. Create a Slack app and bot user. See `docs/SETUP.md`.
2. Copy `.env.example` to `.env` and fill values.
3. Install deps and run locally:
   ```bash
   npm install
   # Dev (hot reload) using tsx (stable on Node 22/24)
   npm run dev

   # If dev has issues, run the compiled app:
   npm run build && npm start
   ```

## Environment
- Socket Mode (default): requires `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`.
- Events API: requires `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` (and a public HTTPS URL).

See `docs/CONFIG.md` for more details.

## Scripts
- `npm run dev` — run with tsx (watch mode)
- `npm run dev:run` — run once with tsx
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run compiled app from `dist/`
 - `npm run serve` — production runner (builds if needed, then starts)

## Slack Configuration
- Bot Token Scopes:
  - `chat:write`
  - `app_mentions:read`
  - `channels:history` (public channels) and optionally `groups:history` (private channels)
  - `reactions:write` (to add reactions for wins and clowning)
- Event Subscriptions → Subscribe to bot events:
  - `app_mention` (for fun commands)
  - `message.channels` (public channel messages)
  - `message.groups` (private channels, if used)
- Reinstall the app after adding scopes/events, then invite it to your channels.

## Config
- Set in `.env`:
  - `TIMEZONE=Africa/Johannesburg`
  - `ALLOWED_CHANNELS=C0919MX7KJS` (your `#capetown` channel ID)
  - Optionally `HOLIDAYS=YYYY-MM-DD,YYYY-MM-DD` to add extra dates
  - Chat fallback is configurable via `CHAT_*` variables. See docs/CONFIG.md.

## Holidays
- Seeded SA public holidays for 2025 at `data/holidays/za-2025.json`.
- To adjust or add another year, place a JSON file at `data/holidays/za-<year>.json` containing an array of `YYYY-MM-DD` dates.

## Storage
- Uses a simple JSON file at `data/store.json` for wins, counts, daily announcements, and weekly crowns. No native modules required.

## Private Channels
- If you later want to react to private-channel messages, add the `groups:history` scope and subscribe to the `message.groups` bot event in your Slack app settings, then reinstall the app.

## Production: Auto‑start and Keep Alive

You can run the bot on server boot and keep it alive using either systemd (recommended) or PM2. The app reads `.env` from the repo root via `dotenv`, so ensure it exists and is correct.

### Option 1: systemd (recommended)

1) Edit `systemd/slack-bot.service` if needed:
   - Set `User`/`Group` to a non‑root service account (recommended).
   - Set `WorkingDirectory` and the `ExecStart` path to your deployed repo path.

2) Install and enable:
```bash
sudo cp systemd/slack-bot.service /etc/systemd/system/slack-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now slack-bot
```

3) Logs and management:
```bash
sudo systemctl status slack-bot
sudo journalctl -u slack-bot -f
sudo systemctl restart slack-bot
```

Notes:
- The unit runs `scripts/run-prod.sh`, which builds if needed and then launches the compiled app. Remove the install/build steps if your deployment pipeline already builds artifacts.
- To update: pull changes, then `sudo systemctl restart slack-bot`.

### Option 2: PM2

If you prefer PM2:
```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # follow the printed command to enable on boot
```

Logs and management:
```bash
pm2 logs slack-bot-ts
pm2 restart slack-bot-ts
pm2 status
```
