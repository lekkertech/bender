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

Effective 2025-09-10, the Boom game podium is computed by earliest Slack message timestamp (`event.ts`), not by order of receipt over WebSocket. This prevents out-of-order delivery from affecting results.

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
