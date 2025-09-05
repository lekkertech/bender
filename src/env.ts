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

  // New feature/config fields
  features: Set<string>; // e.g., {'boom','fun'}
  funAllowedChannels?: Set<string>; // override for Fun bundle if provided
  funConfigPath?: string; // JSON file with fun commands, default data/fun-commands.json

  // OpenAI configuration (Fun bundle)
  openaiApiKey?: string;
  openaiModel: string; // default: gpt-4.1-nano
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

  // Channel allowlists
  const allowedChannelsArr = (process.env.ALLOWED_CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const funAllowedChannelsArr = (process.env.FUN_ALLOWED_CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Reply mode
  const defaultReplyMode = (process.env.DEFAULT_REPLY_MODE || 'channel') as Config['defaultReplyMode'];

  // Features toggle (default both enabled)
  const featuresStr = process.env.FEATURES || 'boom,fun';
  const featuresList = featuresStr
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const features = new Set(featuresList);

  // OpenAI config (Fun bundle)
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL || 'gpt-4.1-nano';

  // Fun config file path
  const funConfigPath = process.env.FUN_CONFIG || 'data/fun-commands.json';

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
    allowedChannels: allowedChannelsArr.length ? new Set(allowedChannelsArr) : undefined,
    defaultReplyMode,

    // New fields
    features,
    funAllowedChannels: funAllowedChannelsArr.length ? new Set(funAllowedChannelsArr) : undefined,
    funConfigPath,
    openaiApiKey,
    openaiModel,
  };
}
