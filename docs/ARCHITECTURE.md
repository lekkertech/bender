# Architecture

This document describes a simple, reliable architecture for a Slack channel bot. It supports both Socket Mode and Events API delivery.

## Components
- Slack Platform: Delivers events and hosts the Web API.
- Transport:
  - Socket Mode: persistent WebSocket from your app to Slack.
  - Events API: Slack sends signed HTTPS requests to your endpoint.
- Bot App: Your process with event routing, handlers, and responses.
- Message Handlers: Functions that implement your bot’s behaviors.
- Persistence (optional): For deduplication, state, and metrics.

## Event Flow

### Socket Mode
1. App connects to Slack via WebSocket using `SLACK_APP_TOKEN`.
2. Slack delivers events over the socket.
3. Your app acknowledges events quickly (frameworks handle this for you).
4. Your app routes to handlers and responds via Web API using `SLACK_BOT_TOKEN`.

### Events API (HTTPS)
1. Slack sends an HTTP POST to your public endpoint (e.g., `/slack/events`).
2. Verify the request signature using `SLACK_SIGNING_SECRET`.
3. Acknowledge within ~3 seconds (200 OK) to avoid retries.
4. Route to handlers; use Web API to reply asynchronously if work is slow.

## Message Handling Pipeline
1. Ingress: Receive event payload; validate and parse.
2. Security: Verify Slack signature (Events API) or token validity (Socket Mode).
3. Dedup: Use `event_id` to prevent duplicate processing.
4. Routing: Based on `event.type` and message content:
   - `app_mention` → mention handler
   - `message.channels` → keyword handler (ignore bot and thread/system messages)
5. Business Logic: Execute intent (help, echo, command dispatch, etc.).
6. Respond: Prefer thread replies by default; fall back to channel.
7. Observe: Log, metric counters, and error capture.

## Boom Feature

The boom game ships two scoring mechanisms. `BOOM_SCORING` selects one at startup and exactly one
set of handlers is installed; there is no runtime branch between them.

| Path | Responsibility |
|---|---|
| `src/features/boom/index.ts` | Constructs the `Store` and delegates to one orchestration. |
| `src/features/boom/legacy/index.ts` | 3-2-1 podium: the noon hour is the window, a game closes on three unique entrants, announcement is held for `BOOM_ANNOUNCE_GRACE_MS`. |
| `src/features/boom/random/index.ts` | Randomised points: a fixed 12:00-12:05 window, every unique entrant draws a distinct value in 1..n when it settles. |
| `src/features/boom/random/announce.ts` | The randomised path's results post and Friday crown. |
| `src/features/boom/leaderboard.ts` | The `app_mention` leaderboard, shared by both, parameterised by the mode's catch-up. |
| `src/features/boom/rules.ts` | Pure date, emoji and window helpers for both mechanisms. |
| `src/features/boom/store.ts` | JSON persistence for both, plus the per-date mode stamp. |

### How a date knows which mechanism scored it

`Store.addEntry` stamps a date `random` and `Store.addPlacement` stamps it `legacy`, each only if
the date is not already stamped. The write path names the mechanism, so the `Store` needs no mode
argument and a read never stamps.

`Store.scoringFor(date)` reads that stamp, falling back to the `random_scoring_from` cutover left
by an earlier build, then to `legacy`. `weeklyTotals` dispatches per date through it, so a week
spanning a `BOOM_SCORING` change sums each day under the rules that scored it. No day is ever
part-one and part-the-other, and changing the flag cannot re-score a day already played.

The decision and its alternatives are recorded in `docs/adr/0001-boom-scoring-mode-flag.md`.

## Recommended Conventions
- Acknowledge fast: never block ack on long work.
- Thread replies: respond in the same thread (`thread_ts`) when present.
- Ignore bots: skip events from your own bot and other integrations.
- Idempotency: store processed `event_id` or use a short TTL cache.
- Backoff: respect Slack Web API rate limits; retry with jitter.

## Framework Notes
- Slack Bolt (Node/Python) offers built-in routing, ack, and signature verification.
- Any HTTP framework works if you implement signature verification and routing.

## Minimal Handler Set
- `help`: list supported commands and examples.
- `echo`: echo back text for testing.
- `ping`: reply with `pong` to validate liveness.

