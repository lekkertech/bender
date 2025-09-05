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
  - With `FEATURES=boom,chat`, both modules respond as expected.
  - With `FEATURES=boom`, Chat is inactive.
  - With `FEATURES=chat`, Boom scoring and leaderboard are inactive.
- Channel allowlist:
  - Messages in channels not listed in `ALLOWED_CHANNELS` (or `CHAT_ALLOWED_CHANNELS` for Chat) are ignored.
- Boom module:
  - Noon window: posting `:boom:` / `💥`, `:hadeda-boom:`, and (Wed only) `:wednesday-boom:` between 12:00–12:59 records counts and podiums.
  - Outside window or after podium full/day closed: bot adds `:clown_face:` reaction.
  - Daily podium auto-post when each required game reaches 3 valid posts.
  - Friday crown after first Friday `:boom:` podium placement posts weekly winners.
  - `@bot leaderboard` prints week-to-date leaderboard with current king(s).
- Chat module (app mentions):
  - `@bot hello there` yields an AI reply in-channel by default (threaded if `DEFAULT_REPLY_MODE=thread`).
  - `@bot help` prints brief usage depending on your system prompt.
  - Admin can update default prompt: `@bot chat update default prompt You are our concise Slack copilot...`
  - `@bot leaderboard` is ignored by Chat and handled by Boom.
- Rate limits (Chat):
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
- Verify secrets present in the environment (`SLACK_BOT_TOKEN`, and `SLACK_APP_TOKEN` for Socket Mode or `SLACK_SIGNING_SECRET` for Events API; `OPENAI_API_KEY` for Chat).
- Run unit/integration tests and lint.
- Dry-run deployment to a staging workspace before production.

