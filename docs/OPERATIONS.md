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


## Boom Game Scoring: The 12:00-12:05 Entry Window

Scoring is no longer order-based. Each game (`boom`, `hadeda`, `wednesday`) tallies everyone who
posts its emoji inside one fixed window, then hands out points at random.

- Entry window:
  - The window opens at **12:00:00.000 local** and shuts `BOOM_ENTRY_WINDOW_MS` later (default
    5 minutes, so 12:05:00.000, exclusive). It is the same window for every game and for every
    workday, and it does not move: it opens at noon whether or not anyone posts.
  - Nothing about the window depends on the entries. A first post at 12:04:00 gets 60 seconds of
    tallying, not a fresh 5 minutes; a post at 11:59:59 is early and a post at 12:05:00 is late.
  - Eligibility is decided by the message's own Slack `ts` alone — not by when the event was
    delivered, and not by whether anyone else posted first.
  - Points are assigned `ENTRY_GRACE_MS` (5s) *after* the close, at 12:05:05. This exists only so
    a message sent inside the window but delivered a moment late still makes the tally; because
    eligibility is judged on `ts`, the grace never buys anyone extra time to post.
  - One entry per user per game: the first valid post is recorded and gets a
    `:white_check_mark:` reaction to acknowledge it.
  - A repeat post by a user who already entered that game is ignored completely — no entrant, no
    `counts` increment, no stored message — and gets `:clown_face:`. `counts[date][game]`
    therefore equals the number of entrants.
  - Any game emoji outside the window — before 12:00, after 12:05, or later in the noon hour —
    gets `:clown_face:` and scores nothing.
- Point assignment:
  - When the window shuts, the `n` entrants of each game are given a random permutation of `1..n`:
    one gets `n`, another `n-1`, down to `1`. No duplicates, no gaps, no ties.
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
  - Every game of a date settles at the same instant, so a required game nobody entered settles
    empty at 12:05:05 and renders as `— no entries`. Without that the day's results — and, on a
    Friday, the week's crown — would stall forever on a game nobody played. Only a date somebody
    actually played settles at all, so a quiet workday produces no post.
  - Each post is marked done (`daily_announced`, `weekly_crowned`, and `weekly_kings` for the
    crown's winners) only after Slack accepts it. A failed post leaves the work outstanding and
    `pendingAnnouncements()` re-offers it to the next catch-up, so a transient rate-limit at 12:05
    delays the results instead of dropping them. The results post and the crown retry
    independently — a lost crown never re-posts the results, and leaves no record of a crown nobody
    saw.
  - Announcing is bounded to the last 2 days (`isWithinRetryWindow`), and the gate sits in
    `announceDay` itself rather than only in the retry sweep — otherwise a restart after a long
    outage would settle a weeks-old day and post its podium into the channel. Such a day still
    settles, so its scores are right; it just never announces.
- Timers and recovery:
  - The window is settled by a single in-process timer per date, armed by the first recorded entry.
    If the bot restarts mid-window, the date is settled instead by a background sweep (every 30s)
    or by the next message in the channel, using the channel recorded with the entries. The sweep
    runs with `app.logger`, so failures on this path are logged rather than swallowed.
- Migration:
  - On first start, the Store stamps `random_scoring_from` with today's local date. Everything
    before it keeps legacy 3-2-1 podium scoring, so historical leaderboards and crowns are
    unchanged. Pre-cutover dates are never settled, swept or announced.
  - The cutover is today, not tomorrow, because the legacy full-house announce trigger no longer
    exists: a day left in the legacy era would be scored 3-2-1 and then never posted, so a morning
    deploy would silently swallow that whole day.
  - The exception is a deploy onto a day whose results are already out (`daily_announced[today]`
    set by the old build). That date keeps legacy scoring and the cutover moves to tomorrow —
    re-scoring it would drop its legacy points out of `weeklyTotals` and contradict a podium
    people have already read.
  - Deploying mid-window is safe: entries already recorded for today are picked up when the window
    settles, rather than being stranded. Anyone who posted before the deploy is still an entrant.
  - A game recorded but not yet settled contributes 0 to the leaderboard — provisional points
    never leak into `@bot leaderboard` mid-window.
- Troubleshooting:
  - Points look wrong: check `awards[date][game]` in `data/store.json`; it is the single source of
    truth for scoring, and `awarded_at` shows when the window closed.
  - Results never posted: confirm every required game for that date has an `awards` entry. A game
    nobody entered gets an empty `awards` array at 12:05:05; if one is missing entirely, the day
    had no entrants at all (nothing to announce) or the process was down across 12:05 and has seen
    no message since.
  - Results settled but not posted: the Slack call failed. Check the logs; the next message in the
    channel or the 30s sweep retries it. `daily_announced[date]` missing while `awards[date]` is
    complete is exactly that state.

## Boom Game Ordering and Data Notes

Effective 2025-09-10, the Boom game podium is computed by earliest Slack message timestamp (`event.ts`), not by order of receipt over WebSocket. This prevents out-of-order delivery from affecting results. Since the move to random point assignment (see above), timestamps no longer decide who wins — the window is fixed at 12:00-12:05 local. They decide only whether a message falls inside it, and which of a user's messages counts as their entry.

Effective 2026-08-31, a valid in-window message is recorded before any clown judgment is made. This guards a race proven in production on 2026-08-31 and reproduced in `tests/boom.race.test.ts`: Slack delivered the true 3rd-by-ts hadeda entry after a later one had already filled the old three-place podium, so the message was clowned without ever being recorded. Under random scoring there is no place left to lose — every unique entrant inside the entry window is recorded and scores whatever order the events arrive in — and the `ENTRY_GRACE_MS` deferral covers the same delay for a message sent just inside the window.

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

## Boom Game Day Settlement

Effective 2026-08-28, a Boom day no longer needs every game to reach three entrants before it is
announced. Under random scoring (see above) every game settles on the one fixed 12:00-12:05 window,
so the number of entrants never blocks a day: a required game nobody entered simply settles empty
at 12:05:05 alongside the games that were played.

Key points:
- Trigger: `catchUp` runs at the top of the message handler, on `@bot leaderboard`, and on a 30s
  interval when `app.client` is available (absent in the unit-test harness).
- Backfill bound: announcing, and every retry (results, crown, medals), is limited to the last
  2 days. A day that stalled longer ago still settles, so its scores stay right, but stays
  unannounced rather than being posted into the channel out of nowhere.
- Days nobody played: only a date with at least one entrant is settled this way, so a quiet
  workday produces no post at all.
- Partial games: a game with one or two entrants awards `1` / `2..1` as usual; a game with no
  entrants gets an empty `awards` array and renders `— no entries`.
- Friday crown: written to `weekly_kings` / `weekly_crowned` only after `chat.postMessage` succeeds,
  so a rate-limited crown post is retried rather than leaving a king nobody was told about.
- Weekend/holiday notice: tracked in process memory per date, so one reply per weekend day. A
  restart resets the tracker and can produce a second notice.

Relevant implementation:
- Announce path (`announceDay`, `postDailyResults`, `postWeeklyCrown`, `settleDay`, `catchUp`): [src/features/boom/index.ts](../src/features/boom/index.ts)
- Store helpers (`duePending`, `pendingAnnouncements`, `hasAnyEntry`, `channelForDate`): [src/features/boom/store.ts](../src/features/boom/store.ts)
- Window helpers (`windowOpensAtMs`, `windowClosesAtMs`, `windowSettlesAtMs`, `inEntryWindow`, `neededGamesForDate`): [src/features/boom/rules.ts](../src/features/boom/rules.ts)
- Tests: [tests/boom.feature.test.ts](../tests/boom.feature.test.ts), [tests/boom.race.test.ts](../tests/boom.race.test.ts)
