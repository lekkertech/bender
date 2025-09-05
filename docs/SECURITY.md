# Security

Security practices for building and operating your Slack bot.

## Principles
- Least privilege: grant only required scopes and events.
- Secret hygiene: never commit tokens; rotate regularly.
- Input validation: treat all message content as untrusted.
- Defense in depth: verify signatures, dedupe events, validate channel allowlist.

## Secrets
- `SLACK_BOT_TOKEN` (`xoxb-…`), `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` (`xapp-…`).
- Store in a secrets manager; grant minimal runtime access.
- Rotate on a schedule or upon exposure; document the rotation runbook.

## Signature Verification (Events API)
- Use `X-Slack-Signature` and `X-Slack-Request-Timestamp` headers.
- Construct the base string `v0:{timestamp}:{raw_body}`; HMAC-SHA256 with `SLACK_SIGNING_SECRET`.
- Compare digest with constant-time equality. Reject if older than a small skew (e.g., 5 minutes).

## Permissions & Channel Controls
- Restrict bot interactions to specific channels via `ALLOWED_CHANNELS` (IDs).
- Consider runtime checks to prevent posting in unauthorized channels.

## Logging & Privacy
- Avoid logging message bodies unless necessary for debugging.
- Scrub tokens, emails, and PII from logs.
- Set log retention and access controls.

## Dependency & Supply Chain
- Pin versions; use lockfiles.
- Enable automated vulnerability scanning.
- Review Slack app manifest changes before rollout.

