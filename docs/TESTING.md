# Testing

Strategies and checklists to validate your Slack bot.

## Local Testing
- Socket Mode: run locally with `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`; no public URL needed.
- Events API: expose a temporary tunnel (e.g., ngrok/Cloudflared) for Slack to reach your `POST /slack/events` endpoint; ensure raw body is available for signature verification.

## Unit Tests
- Handlers: given an event payload, assert correct Web API calls are issued.
- Utilities: signature verification, dedup, allowlist checks.
- Rate-limit handling: ensure retry/backoff logic behaves as expected.

## Integration Tests
- Mock Slack Web API responses (200, 429) and assert retries.
- Replay recorded event payloads for `app_mention` and `message.channels`.

## Manual Test Checklist
- Feature toggles:
  - With `FEATURES=boom,fun`, both modules respond as expected.
  - With `FEATURES=boom`, Fun commands are ignored.
  - With `FEATURES=fun`, Boom scoring and leaderboard are inactive.
- Channel allowlist:
  - Messages in channels not listed in `ALLOWED_CHANNELS` (or `FUN_ALLOWED_CHANNELS` for Fun) are ignored.
- Boom module:
  - Noon window: posting `:boom:` / `💥`, `:hadeda-boom:`, and (Wed only) `:wednesday-boom:` between 12:00–12:59 records counts and podiums.
  - Outside window or after podium full/day closed: bot adds `:clown_face:` reaction.
  - Daily podium auto-post when each required game reaches 3 valid posts.
  - Friday crown after first Friday `:boom:` podium placement posts weekly winners.
  - `@bot leaderboard` prints week-to-date leaderboard with current king(s).
- Fun module (app mentions):
  - `@bot haiku spring in cape town` replies with a 3-line haiku in-channel by default (threaded if DEFAULT_REPLY_MODE=thread).
  - `@bot roast @user` returns a short playful roast. `@bot roast @user spicy` allows a spicier version.
  - `@bot compliment @user` returns a short sincere compliment.
  - `@bot emojify Friday lunch plans` returns an emoji sequence, minimal text.
  - `@bot slang za That meeting was chaotic` returns localized SA slang variant.
  - `@bot dadjoke` returns one clean dad joke.
  - `@bot leaderboard` is ignored by Fun and handled by Boom.
- Rate limits (Fun):
  - Per-user: more than 1 request in 60s yields an ephemeral “rate limited” message.
  - Per-channel: after 20 requests in 60s, subsequent requests are rate limited.
- Thread behavior:
  - Replies occur in-channel by default.
  - Set `DEFAULT_REPLY_MODE=thread` to force threaded replies (starts a thread if none exists).
  - Even when invoked inside a thread, if `DEFAULT_REPLY_MODE=channel` the bot replies in-channel.
- Bot ignore: the bot ignores its own messages and other bots/system messages.
- Error path: simulate a thrown exception in a handler; verify error logging and that the bot remains responsive.

## Pre-Deploy Validation
- Confirm scopes and events match your implementation: `app_mentions:read`, `chat:write`, `channels:history` and optionally `groups:history`, `reactions:write`.
- Verify secrets present in the environment (`SLACK_BOT_TOKEN`, and `SLACK_APP_TOKEN` for Socket Mode or `SLACK_SIGNING_SECRET` for Events API; `OPENAI_API_KEY` for Fun).
- Run unit/integration tests and lint.
- Dry-run deployment to a staging workspace before production.

