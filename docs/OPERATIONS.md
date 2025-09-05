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

