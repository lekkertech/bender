# Deploy

This guide outlines deployment patterns for both Socket Mode (no public URL) and Events API (public HTTPS). Choose one approach and follow its checklist.

## Option A: Socket Mode
Pros: simpler networking, no public URL, works from anywhere. Cons: long-lived connection, not serverless-friendly by default.

Checklist:
- Ensure `SLACK_APP_TOKEN` (`xapp-…`, `connections:write`) and `SLACK_BOT_TOKEN` are set.
- Run a process that connects to Slack via Socket Mode.
- Use a process manager (systemd, PM2, Docker, or a PaaS) to restart on crash.
- Expose a local health endpoint (optional) for liveness checks.

Suitable platforms:
- Render (Background Worker), Fly.io (App), Heroku (Worker), Railway, Docker on VM/Kubernetes.

## Option B: Events API (HTTPS)
Pros: stateless HTTP, easy autoscaling/serverless. Cons: requires a public URL and signature verification.

Checklist:
- Expose `POST /slack/events` over HTTPS.
- Verify Slack signatures (v0 signatures) using `SLACK_SIGNING_SECRET`.
- Ack within ~3s; offload slow work to background jobs.
- Use `SLACK_BOT_TOKEN` for Web API responses.

Suitable platforms:
- GCP Cloud Run, AWS Lambda + API Gateway, Azure Functions, Fly.io, Render, Vercel (with raw body handling).

## Health, Logs, Metrics
- Health: `/healthz` returns 200 with build info.
- Logs: include `event_id`, `team_id`, `channel`, `user`, `handler`, result status.
- Metrics: count events by type, handler latency, Web API rate-limit hits.

## Scaling and Reliability
- Horizontal scale: ensure idempotency and deduplication across replicas.
- Use a short TTL cache or datastore for `event_id` dedupe.
- Respect Slack Web API rate limits; implement retries with exponential backoff and jitter.

## CI/CD Notes
- Run lint/tests on every change.
- Block deploy if secrets are missing.
- Optionally run a canary with reduced event share before full rollout.

