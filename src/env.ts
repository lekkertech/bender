import dotenv from 'dotenv';
dotenv.config();

export type Config = {
  socketMode: boolean;
  botToken: string;
  appToken?: string;
  signingSecret?: string;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  allowedChannels?: Set<string>;
  defaultReplyMode: 'thread' | 'channel';
};

function parseBool(val: string | undefined, fallback = false): boolean {
  if (val == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(val.toLowerCase());
}

export function loadConfig(): Config {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const port = Number(process.env.PORT || 3000);
  const logLevel = (process.env.LOG_LEVEL || 'info') as Config['logLevel'];
  const allowedChannels = (process.env.ALLOWED_CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const defaultReplyMode = (process.env.DEFAULT_REPLY_MODE || 'thread') as Config['defaultReplyMode'];

  if (!botToken) {
    throw new Error('Missing SLACK_BOT_TOKEN');
  }

  const socketMode = !!appToken && !parseBool(process.env.FORCE_HTTP, false);

  if (!socketMode && !signingSecret) {
    throw new Error('HTTP (Events API) requires SLACK_SIGNING_SECRET. Set SLACK_APP_TOKEN to use Socket Mode.');
  }

  return {
    socketMode,
    botToken,
    appToken,
    signingSecret,
    port,
    logLevel,
    allowedChannels: allowedChannels.length ? new Set(allowedChannels) : undefined,
    defaultReplyMode,
  };
}
