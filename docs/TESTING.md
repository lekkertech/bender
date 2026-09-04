# Testing

Strategies and checklists to validate your Slack bot.

## Local Testing
- Socket Mode: run locally with `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`; no public URL needed.
- Events API: expose a temporary tunnel (e.g., ngrok/Cloudflared) for Slack to reach your `POST /slack/events` endpoint; ensure raw body is available for signature verification.

## Scoring-mode regression suites

`tests/legacy.feature.test.ts` and `tests/legacy.race.test.ts` are copied verbatim from the
3-2-1 podium build, with one line added to each `cfg` literal to select `BOOM_SCORING=legacy`.
They exist to prove that switching the flag back reproduces that build's behaviour exactly.

Never edit an assertion, test body or harness function in those two files to make them pass. A
failure there means the legacy orchestration or the store has drifted, and the fix belongs in
`src/`.

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
- Boom module (`BOOM_SCORING=random`, the default):
  - Entry window: posting `:boom:` / `💥`, `:hadeda-boom:`, and (Wed only) `:wednesday-boom:` between 12:00:00 and 12:04:59 records counts and entries.
  - One fixed window per day, 12:00:00–12:05:00, shared by every emoji. It opens at noon whether or not anyone posts: a first entry at 12:04:00 gets 60 seconds, not a fresh 5 minutes. Each accepted entry is reacted to with `:white_check_mark:` straight away, and nothing is scored until the window shuts.
  - When the window closes, each of the `n` unique entrants gets a unique random amount between 1 and `n` (verify no duplicate amounts and no gaps), and the top three earners get medal reactions.
  - Posting the same emoji again after your first entry: `:clown_face:`, no acknowledgement, and `counts` unchanged (still one per entrant).
  - Outside window, after a game's window closed, or after the day is closed: bot adds `:clown_face:` reaction and awards nothing.
  - Daily results auto-post once every required game for the day has settled.
  - Friday crown posts weekly winners right after the Friday daily results.
  - Entries at 11:59:59 or 12:05:00 are clowned, as is anything later in the noon hour: only 12:00:00–12:04:59 counts, judged on the message timestamp rather than delivery time.
  - Restart mid-window: after restarting the bot, the pending window still settles (on the next message in the channel, or within ~30s via the background sweep).
  - Deploy day: the day you deploy is scored and announced under whichever mechanism `BOOM_SCORING` selects, including entries recorded before the deploy. Each date is stamped with the mechanism that first recorded a play on it and is never re-scored, so switching `BOOM_SCORING` and restarting leaves every earlier day exactly as it was posted.
  - A required game nobody played renders `— no entries`, and the day still announces at 12:05:05 — or, if the process was down then, on the next message in the channel or the 30s sweep.
  - Weekend/holiday "Boom isn't played today" notice is posted once per date, not once per poster.
  - The crown is persisted only after its message succeeds; a failed crown post leaves the week uncrowned and retryable.
  - `@bot leaderboard` prints week-to-date leaderboard with current king(s).
- Boom module (`BOOM_SCORING=legacy`):
  - The entry window is the whole noon hour, 12:00:00-12:59:59, and a game closes as soon as three unique users have entered it.
  - First, second and third by message timestamp score 3, 2 and 1; a fourth unique entrant is clowned on arrival.
  - Results are held for `BOOM_ANNOUNCE_GRACE_MS` after the podium fills, so a late-delivered earlier entry can still re-rank.
  - A day that closes short of a full podium still announces, via the background sweep or the next message in the channel.
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

