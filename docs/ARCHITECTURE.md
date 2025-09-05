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

