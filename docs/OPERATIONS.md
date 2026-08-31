# Operations Runbook

Day-2 operations for your Slack bot: monitoring, rotation, and recovery.

## Monitoring
- Liveness: monitor process up and socket connected (Socket Mode) or HTTP 2xx rate (Events API).
- Error rate: alert on spikes in handler failures and Web API 4xx/5xx.
- Rate limits: track 429 responses and retry behavior.

## Rotating Secrets
1. Create new tokens in Slack app settings.
2. Update secrets in your manager and deployment environment.
3. Restart/redeploy the app.
4. Remove old tokens after validation.

## Scaling
- Horizontal scale is safe with idempotent handlers and `event_id` dedupe.
- For background jobs, use a queue with visibility timeouts and retry policies.

## Incident Response
- Capture minimal context in logs for failed events (`event_id`, `team_id`, `channel`, `user`).
- Triage by handler; disable problematic handlers via a feature flag if supported.
- If tokens leak, rotate immediately and purge from logs.

## Backups & Upgrades
- No user data by default; if you store state, back it up.
- Roll forward strategy preferred; maintain ability to roll back a previous image.


## Boom Game Ordering and Data Notes

Effective 2025-09-10, the Boom game podium is computed by earliest Slack message timestamp (`event.ts`), not by order of receipt over WebSocket. This re-ranks recorded messages, so out-of-order delivery cannot reorder them.

Effective 2026-08-31, every valid in-window message is recorded before any clown judgment, and the full-house announcement waits for a grace window (`BOOM_ANNOUNCE_GRACE_MS`, default 15000ms; 0 announces immediately). Both guard the same race, proven in production on 2026-08-31 and reproduced in `tests/boom.race.test.ts`: Slack delivered the true 3rd-by-ts hadeda entry after the 4th had filled the podium, so the old code clowned it unrecorded and the 4th-by-ts entry kept bronze. A message is clowned only when it holds no place on the settled podium, or when it arrives after the day's results are announced. A displaced entry (recorded, then out-ranked by a straggler with an earlier `ts` during the grace window) is not retroactively clowned; it simply gets no medal.

Key points:
- Podium calculation:
  - Winners are determined by earliest unique user timestamps per game/day.
  - Tie-breakers: first by the raw Slack `ts` string, then by `user_id` for determinism.
- Data model:
  - New raw message ledger stored under `messages[date][game]` (each item: `user_id`, `channel_id`, `message_ts`, `created_at`).
  - Legacy `placements[date][game]` is retained for backward compatibility and used only when no `messages` exist for that date/game.
- Migration:
  - No manual migration required. Existing historical podiums continue to work via the legacy `placements`.
  - As new events arrive, `messages` will be populated automatically and used for ordering.
- Troubleshooting:
  - If podium order appears incorrect, verify the Slack `ts` values in logs alongside `event_id`.
  - Ensure TIMEZONE (default Africa/Johannesburg) is correct, as date bucketing uses local day.
  - Dedupe by `event_id` still applies; duplicates with the same `user_id` and `message_ts` are ignored in storage.

Relevant implementation:
- Store (timestamp-based podium, raw messages, crown monotonicity): [src/features/boom/store.ts](../src/features/boom/store.ts)
- Boom feature handler (passes Slack `ts` into Store): [src/features/boom/index.ts](../src/features/boom/index.ts)
- Tests (coverage for out-of-order timestamps): [tests/store.test.ts](../tests/store.test.ts)

## Chat Passive History Capture

Effective 2025-09-10, the chat feature records all messages in allowed channels (both top-level and thread replies), including posts from human users and bot/integrations. This expands context beyond only direct mentions to the bot.

Details:
- Scope: all messages in allowed channels, including thread replies and bot/integration posts.
- Dedupe: entries are deduplicated by (channel_id, ts, role) to avoid double-storing the same message across different handlers.
- Pruning: same caps as before — bounded by chatHistoryMaxTurns and chatHistoryMaxChars.
- Assistant replies: not explicitly appended by the chat feature; they are captured passively via the message event stream.

Operational notes:
- Ensure CHAT_ALLOWED_CHANNELS limits where context is accumulated, if desired.
- If you need to clear context: use the admin-only “@bot clear chat [all]” commands.
- For debugging, “@bot context” shows the current channel transcript and high-level counts across channels.

## Boom Game Day Settlement

Effective 2026-08-28, a Boom day no longer needs every game to reach three entrants before it is
announced. A day is settled the moment all required games have three unique entrants, and
otherwise once its noon window closes at 13:00 local time.

Key points:
- Trigger: `announceClosedDays` runs at the top of the message handler, on `@bot leaderboard`, and
  on a 60s interval when `app.client` is available (absent in the unit-test harness).
- Backfill bound: `ANNOUNCE_BACKFILL_DAYS = 2`. Days whose window closed longer ago are skipped, so
  deploying this change cannot post podiums for days that stalled months ago. Those days stay
  unannounced.
- Partial podiums: a game with one or two entrants scores 3 and 2 points as usual; a game with no
  entrants renders `— no entries`.
- Friday crown: written to `weekly_kings` / `weekly_crowned` only after `chat.postMessage` succeeds,
  so a rate-limited crown post is retried rather than leaving a king nobody was told about. A week
  with no results is left uncrowned instead of being marked crowned.
- Weekend/holiday notice: tracked in process memory per date, so one reply per weekend day. A
  restart resets the tracker and can produce a second notice.

Relevant implementation:
- Announce path (`announceDay`, `postDailyPodium`, `postWeeklyCrown`, `announceClosedDays`): [src/features/boom/index.ts](../src/features/boom/index.ts)
- Store helpers (`recordedDates`, `hasAnyPlacement`, `channelForDate`): [src/features/boom/store.ts](../src/features/boom/store.ts)
- Window helpers (`noonWindowEndMs`, `isWorkdayDate`, `neededGamesForDate`): [src/features/boom/rules.ts](../src/features/boom/rules.ts)
- Tests: [tests/boom.feature.test.ts](../tests/boom.feature.test.ts)
