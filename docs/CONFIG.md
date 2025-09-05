# Configuration

Define configuration via environment variables and keep secrets out of source control. Below are the common settings for both Socket Mode and Events API.

## Environment Variables
- `SLACK_BOT_TOKEN`: Bot User OAuth token (`xoxb-…`). Required.
- `SLACK_SIGNING_SECRET`: Slack app signing secret. Required for Events API.
- `SLACK_APP_TOKEN`: App-level token (`xapp-…`) with `connections:write`. Required for Socket Mode.
- `PORT`: HTTP port for Events API servers (e.g., `3000`). Optional; default depends on framework.
- `LOG_LEVEL`: `debug`, `info`, `warn`, `error`. Optional; default `info`.
- `ALLOWED_CHANNELS`: Comma-separated channel IDs allowed to interact (e.g., `C0123,C0456`). Optional.
- `DEFAULT_REPLY_MODE`: `thread` or `channel`. Optional; default `thread`.
- `FEATURES`: Comma-separated list of features to enable. Defaults to `boom,fun` if unset. Valid values: `boom`, `fun`.
- `OPENAI_API_KEY`: Enable Fun bundle (AI) commands when set.
- `OPENAI_MODEL`: Defaults to `gpt-4.1-nano`. Override to another model if desired.
- `FUN_ALLOWED_CHANNELS`: Optional override allowlist for Fun bundle only; if unset, Fun responds in any channel the bot is a member of.
- `FUN_CONFIG`: Path to a JSON file defining Fun commands (regex patterns and prompt templates). Defaults to `data/fun-commands.json` if present; otherwise built-in defaults apply. See `data/fun-commands.json.example`.

### Rate Limits (built-in defaults)
- Per-user: 1 request/minute (Fun bundle)
- Per-channel: 20 requests/minute (Fun bundle)

## Sample `.env` (do not commit)
```
SLACK_BOT_TOKEN=xoxb-XXXXXXXXXXXX-YYYYYYYYYYYYY-ZZZZZZZZZZZZZZZ
SLACK_SIGNING_SECRET=abc123yoursecret
SLACK_APP_TOKEN=xapp-1-A1234567890-abcdef.yoursecret
PORT=3000
LOG_LEVEL=info
ALLOWED_CHANNELS=C01ABCDEF,C02GHIJKL
DEFAULT_REPLY_MODE=thread

# Features
FEATURES=boom,fun

# Fun bundle (AI)
OPENAI_API_KEY=sk-xxxx
OPENAI_MODEL=gpt-4.1-nano
# FUN_ALLOWED_CHANNELS=C0123,C0456
# (If unset, Fun responds in any channel the bot is in)
# FUN_CONFIG=data/fun-commands.json
```

## Notes
- Use a secrets manager in production (AWS Secrets Manager, GCP Secret Manager, 1Password, Vault).
- Rotate tokens regularly and after suspected compromise.
- If using Events API behind a proxy, ensure the raw body required for signature verification is available to your framework.

