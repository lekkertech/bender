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
  - Noon window: posting `:boom:` / `💥`, `:hadeda-boom:`, and (Wed only) `:wednesday-boom:` between 12:00–12:59 records counts and entries.
  - The first valid entry per emoji opens a 5-minute tally window; each accepted entry is reacted to with `:white_check_mark:` straight away, and nothing is scored until the window closes.
  - When the window closes, each of the `n` unique entrants gets a unique random amount between 1 and `n` (verify no duplicate amounts and no gaps), and the top three earners get medal reactions.
  - Posting the same emoji again after your first entry: `:clown_face:`, no acknowledgement, and `counts` unchanged (still one per entrant).
  - Outside window, after a game's window closed, or after the day is closed: bot adds `:clown_face:` reaction and awards nothing.
  - Daily results auto-post once every required game for the day has settled.
  - Friday crown posts weekly winners right after the Friday daily results.
  - A first entry at ~12:57 closes its window at 12:59:59 rather than 13:02, and entries at 13:00+ are clowned.
  - Restart mid-window: after restarting the bot, the pending window still settles (on the next message in the channel, or within ~30s via the background sweep).
  - Deploy day: dates before the stamped `random_scoring_from` stay on legacy 3-2-1 scoring and are never settled or re-rolled — deploy outside 12:00–13:00 so a day in progress is not split across the two scoring rules.
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

