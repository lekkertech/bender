# Setup

This guide walks you through creating a Slack app, configuring scopes and events, and obtaining tokens for a bot that responds to channel messages.

## 1) Create the Slack App
- Go to https://api.slack.com/apps → Create New App → From scratch.
- App name: choose a concise name (e.g., "Channel Buddy").
- Pick your workspace.

## 2) Add a Bot User
- In your app settings: Features → App Home → Show Tabs → Ensure "Only show tabs in App Home" is fine.
- Click "Add Legacy Bot User" if prompted or ensure the Bot User is enabled.
- Set a display name and default username if desired.

## 3) Required OAuth Scopes (Bot Token)
Grant only what you need (least privilege). At minimum for channel responses:
- `chat:write`: Send messages as the bot
- `app_mentions:read`: Receive `@app` mention events
- `channels:read`: Read channel list (for membership checks)
- `channels:history`: Read messages in public channels (for keyword triggers)

Optional scopes depending on needs:
- `groups:history`: Read messages in private channels the bot is in
- `im:history`: Read messages in DMs (if supporting DMs)
- `reactions:write`: Add reactions as the bot
- `files:write`: Upload files as the bot

Add these under: Features → OAuth & Permissions → Scopes → Bot Token Scopes.

## 4) Choose Transport: Socket Mode or Events API

### Option A: Socket Mode (no public URL)
- Enable Socket Mode: Features → Socket Mode → Enable.
- Create an App-Level Token: Basic Information → App-Level Tokens → Generate with scope `connections:write`.
- You will use: App Token (`xapp-…`) and Bot Token (`xoxb-…`).

### Option B: Events API (public HTTPS URL)
- You need a public, TLS-terminated URL (e.g., Cloud Run, Fly.io, Render, or behind API Gateway).
- Slack signs requests; you must verify the signature using the Signing Secret.
- You will use: Signing Secret, Bot Token (`xoxb-…`).

## 5) Subscribe to Events
Go to Features → Event Subscriptions.
- Enable Events.
- For Events API, set the Request URL to your server’s `POST /slack/events` endpoint and complete URL verification.
- Subscribe to Bot Events:
  - `app_mention`
  - `message.channels` (for public channel keyword triggers)
  - Optionally: `message.groups` (private channels), `message.im` (DMs)

Notes:
- Slack may redeliver events; use `event_id` deduplication and acknowledge quickly.
- Avoid responding to messages from your own bot (check `subtype == "bot_message"` or `event.bot_id`).

## 6) Install the App
- Features → OAuth & Permissions → Install to Workspace.
- On success, copy the Bot User OAuth Token (`xoxb-…`).

## 7) Collect Credentials
You’ll need the following secrets:
- Bot User OAuth Token: `SLACK_BOT_TOKEN` (`xoxb-…`)
- Signing Secret: `SLACK_SIGNING_SECRET` (Events API only)
- App-Level Token: `SLACK_APP_TOKEN` (`xapp-…`, Socket Mode only)

Store these in a secure secret manager or env vars. See `docs/CONFIG.md`.

## 8) Add the Bot to Channels
- In Slack, invite the bot to a channel: `/invite @YourAppName`.
- For private channels, a member must invite it.

## 9) Verify Basic Behavior
- Mention the bot: `@YourAppName help` and verify it receives events.
- If using keyword triggers, post a test keyword phrase and verify handling.

Next: Pick an architecture and implement handlers. See `docs/ARCHITECTURE.md`.

