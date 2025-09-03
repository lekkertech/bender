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
- App mention: `@YourAppName help` produces a help message (threaded).
- Keyword trigger: posting phrase in an allowed channel yields expected reply.
- Bot ignore: the bot ignores its own messages and other bot messages.
- Private channels: behavior works when invited to a private channel (if enabled).
- DMs: works or gracefully rejects, per your scope design.
- Error path: simulate a handler exception; verify error logging and safe user feedback.

## Pre-Deploy Validation
- Confirm scopes and events match your implementation.
- Verify secrets present in the environment.
- Run unit/integration tests and lint.
- Dry-run deployment to staging workspace before production.

