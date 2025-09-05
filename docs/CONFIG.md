# Configuration

Define configuration via environment variables and keep secrets out of source control. Below are the common settings for both Socket Mode and Events API.

## Environment Variables
- `SLACK_BOT_TOKEN`: Bot User OAuth token (`xoxb-…`). Required.
- `SLACK_SIGNING_SECRET`: Slack app signing secret. Required for Events API.
- `SLACK_APP_TOKEN`: App-level token (`xapp-…`) with `connections:write`. Required for Socket Mode.
- `PORT`: HTTP port for Events API servers (e.g., `3000`). Optional; default depends on framework.
- `LOG_LEVEL`: `debug`, `info`, `warn`, `error`. Optional; default `info`.
- `ALLOWED_CHANNELS`: Comma-separated channel IDs allowed to interact (e.g., `C0123,C0456`). Optional.
- `DEFAULT_REPLY_MODE`: `thread` or `channel`. Optional; default `channel`.
- `FEATURES`: Comma-separated list of features to enable. Defaults to `boom,chat` if unset. Valid values: `boom`, `chat`.
- `OPENAI_API_KEY`: Enable Chat feature (AI) when set.
- `OPENAI_MODEL`: Defaults to `gpt-4.1-nano`. Override to another model if desired.
- `CHAT_ALLOWED_CHANNELS`: Optional override allowlist for the Chat feature; if unset, Chat responds in any channel the bot is a member of.
- `CHAT_CONFIG`: Optional path to a JSON file defining default chat settings (e.g., `systemPrompt`, `temperature`, `maxTokens`). Defaults to `data/chat-config.json`. See `data/chat-config.json.example`.
- Chat (in-memory, channel-scoped; respects DEFAULT_REPLY_MODE):
  - `CHAT_ENABLED` (default: true if `OPENAI_API_KEY` is set)
  - `CHAT_HISTORY_MAX_TURNS` (default: 20)
  - `CHAT_HISTORY_MAX_CHARS` (default: 16000)
  - `CHAT_INPUT_MAX_CHARS` (default: 4000)
  - `CHAT_REPLY_MAX_TOKENS` (default: 512)
  - `CHAT_TEMPERATURE` (default: 0.7)
  - `CHAT_SYSTEM_PROMPT` (default provided; customize as needed)

### Rate Limits (built-in defaults)
- Per-user: 1 request/minute (Chat feature)
- Per-channel: 20 requests/minute (Chat feature)

## Sample `.env` (do not commit)
```
SLACK_BOT_TOKEN=xoxb-XXXXXXXXXXXX-YYYYYYYYYYYYY-ZZZZZZZZZZZZZZZ
SLACK_SIGNING_SECRET=abc123yoursecret
SLACK_APP_TOKEN=xapp-1-A1234567890-abcdef.yoursecret
PORT=3000
LOG_LEVEL=info
ALLOWED_CHANNELS=C01ABCDEF,C02GHIJKL
DEFAULT_REPLY_MODE=channel

# Features
FEATURES=boom,chat

# Chat feature (AI)
OPENAI_API_KEY=sk-xxxx
OPENAI_MODEL=gpt-4.1-nano
# CHAT_ALLOWED_CHANNELS=C0123,C0456
# (If unset, Chat responds in any channel the bot is in)
# CHAT_CONFIG=data/chat-config.json

# Chat settings (channel-scoped, in-memory)
# CHAT_ENABLED=true
# CHAT_HISTORY_MAX_TURNS=20
# CHAT_HISTORY_MAX_CHARS=16000
# CHAT_INPUT_MAX_CHARS=4000
# CHAT_REPLY_MAX_TOKENS=512
# CHAT_TEMPERATURE=0.7
# CHAT_SYSTEM_PROMPT=You are a helpful Slack bot. Keep replies concise, actionable, and friendly. Use plain text suitable for Slack. Avoid long lists and code fences unless explicitly requested.
```

## Notes
- Use a secrets manager in production (AWS Secrets Manager, GCP Secret Manager, 1Password, Vault).
- Rotate tokens regularly and after suspected compromise.
- If using Events API behind a proxy, ensure the raw body required for signature verification is available to your framework.

## Chat Behavior
- Trigger: when a user mentions the bot (except "leaderboard", which is handled by Boom).
- Reply placement: honors `DEFAULT_REPLY_MODE` (thread or channel).
- State: in-memory only, keyed by channel id; history is lost on restart.
- Bounded context: trims to `CHAT_HISTORY_MAX_TURNS` and `CHAT_HISTORY_MAX_CHARS`; each incoming message is clipped to `CHAT_INPUT_MAX_CHARS`.
- OpenAI call: uses `CHAT_SYSTEM_PROMPT`, `CHAT_TEMPERATURE`, and `CHAT_REPLY_MAX_TOKENS` (and optionally overrides from `CHAT_CONFIG`).

