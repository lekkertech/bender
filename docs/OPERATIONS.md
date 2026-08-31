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


## Boom Game Scoring: 5-Minute Tally Windows

Scoring is no longer order-based. Each game (`boom`, `hadeda`, `wednesday`) tallies everyone who
posts its emoji, then hands out points at random.

- Tally window:
  - The first valid entry of the day for a game opens a window of `BOOM_ENTRY_WINDOW_MS` (default
    5 minutes), anchored to that entry's Slack `ts` — not to arrival time.
  - The close is clamped to the end of the noon window (12:59:59.999 local), so a game opened at
    12:57 closes at 12:59:59.999 rather than running to 13:02, where entries would be rejected as
    outside the noon window. Inside the noon window, the tally window is authoritative.
  - Points are assigned `ENTRY_GRACE_MS` (3s) *after* the close, so a message sent just inside the
    window but delivered a moment late still makes the tally. Eligibility is judged on the
    message's own `ts`, so late delivery never buys extra time.
  - One entry per user per game: the first valid post is recorded and gets a
    `:white_check_mark:` reaction to acknowledge it.
  - A repeat post by a user who already entered that game is ignored completely — no entrant, no
    `counts` increment, no stored message — and gets `:clown_face:`. `counts[date][game]`
    therefore equals the number of entrants.
  - Entries after the window closes get `:clown_face:` and score nothing.
- Point assignment:
  - When the window closes, the `n` entrants are given a random permutation of `1..n`: one gets
    `n`, another `n-1`, down to `1`. No duplicates, no gaps, no ties.
  - The assignment is written once to `awards[date][game]` and is never re-rolled — restarts,
    re-announcements and leaderboard queries all read the same stored result.
  - Medal reactions (`:first_place_medal:` …) go to the three biggest point earners' messages.
    Because the awards are flushed before the reactions are sent, medals are marked done in
    `medalled[date][game]` only once every reaction has landed; a crash or Slack failure in between
    leaves them outstanding and the next catch-up re-applies them. A medal already on the message
    (`already_reacted`) counts as landed.
- Announcement:
  - Daily results post once every game required that day has settled (Wednesdays require
    `wednesday` too). The Friday crown follows the Friday results.
  - Each post is marked done (`daily_announced`, `weekly_crowned`, and `weekly_kings` for the
    crown's winners) only after Slack accepts it. A failed post leaves the work outstanding and
    `pendingAnnouncements()` re-offers it to the next catch-up, so a transient rate-limit at 12:05
    delays the results instead of dropping them. The results post and the crown retry
    independently — a lost crown never re-posts the results, and leaves no record of a crown nobody
    saw. Retries (results, crown, medals) are limited to the last 2 days, so an older failure is not
    resurrected into the channel.
- Timers and recovery:
  - Windows are settled by an in-process timer. If the bot restarts mid-window, the window is
    settled by a background sweep (every 30s) or by the next message in the channel, using the
    channel recorded with the entries. The sweep runs with `app.logger`, so failures on this path
    are logged rather than swallowed.
- Migration:
  - On first start, the Store stamps `random_scoring_from` with the local date *after* today. The
    deploy day and everything before it keep legacy 3-2-1 podium scoring, so historical
    leaderboards and crowns are unchanged; random scoring begins at the next local midnight.
  - Stamping tomorrow rather than today is deliberate: deploying mid-day onto a store that already
    holds a scored, announced day would otherwise drop that day's legacy points out of
    `weeklyTotals` and let the sweep re-roll it into results contradicting the podium already
    posted in the channel. Pre-cutover dates are never settled, swept or announced.
  - Consequence: if you deploy during the noon window, that day plays out under the old scoring
    and gets no automatic daily results post (the old announce trigger is gone). Deploy outside
    12:00–13:00 local to avoid it.
  - A game recorded but not yet settled contributes 0 to the leaderboard — provisional points
    never leak into `@bot leaderboard` mid-window.
- Troubleshooting:
  - Points look wrong: check `awards[date][game]` in `data/store.json`; it is the single source of
    truth for scoring, and `awarded_at` shows when the window closed.
  - Results never posted: confirm every required game for that date has an `awards` entry. A game
    nobody entered never opens a window, so the day cannot complete.
  - Results settled but not posted: the Slack call failed. Check the logs; the next message in the
    channel or the 30s sweep retries it. `daily_announced[date]` missing while `awards[date]` is
    complete is exactly that state.

## Boom Game Ordering and Data Notes

Effective 2025-09-10, the Boom game podium is computed by earliest Slack message timestamp (`event.ts`), not by order of receipt over WebSocket. This prevents out-of-order delivery from affecting results. Since the move to random point assignment (see above), timestamps no longer decide who wins — they decide when the tally window opens and closes, and which of a user's messages counts as their entry.

Key points:
- Timestamp use:
  - One entry per user per game/day: their earliest message by `ts`.
  - Tie-breakers: first by the raw Slack `ts` string, then by `user_id` for determinism.
  - Legacy podium helpers (`getPlacements`, `placementsCount`, `PODIUM_WEIGHTS`) remain only to score dates before `random_scoring_from`.
- Data model:
  - Raw message ledger stored under `messages[date][game]` (each item: `user_id`, `channel_id`, `message_ts`, `created_at`).
  - Settled scores stored under `awards[date][game]` (each item: `user_id`, `points`, `channel_id`, `message_ts`, `awarded_at`).
  - `medalled[date][game]` records when medal reactions were successfully applied.
  - `random_scoring_from` marks the first date scored by random point assignment.
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
