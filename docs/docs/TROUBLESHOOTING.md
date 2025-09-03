# Troubleshooting

Common issues and how to resolve them.

## Events Not Arriving
- Events API: URL not verified or failing signature check. Inspect server logs.
- Socket Mode: App token invalid or socket disconnected (network/firewall).
- Missing scopes or not invited to the channel.

## 401 invalid_auth / 403 not_authed
- `SLACK_BOT_TOKEN` is wrong or revoked. Reinstall or rotate.
- Multiple workspaces/environments mixing tokens.

## 403 not_in_channel
- The bot is not a member of the channel. Invite it with `/invite @YourAppName`.

## 429 rate_limited
- Too many Web API calls. Implement backoff and batching. Consider posting a single summary reply instead of many.

## Duplicate Replies
- Slack retried event delivery. Ensure `event_id` deduplication with a short TTL cache or datastore.

## Signature Verification Fails (Events API)
- Ensure raw body is used when computing HMAC.
- Check timestamp skew; allow ±300s.
- Confirm you’re using the Signing Secret (not a token).

## Message Formatting Looks Off
- Use Slack Block Kit and test with the Block Kit Builder.
- Respect threading: set `thread_ts` to reply in-thread.

