import dotenv from 'dotenv';
dotenv.config();

export type Scoring = 'random' | 'legacy';

const SCORING_MODES: readonly Scoring[] = ['random', 'legacy'];

const DEFAULT_CHAT_SYSTEM_PROMPT =
  'You are a helpful Slack bot. Keep replies concise, actionable, and friendly. Use plain text suitable for Slack. Avoid long lists and code fences unless explicitly requested.';

function parseScoring(val: string | undefined): Scoring {
  const mode = (val || 'random') as Scoring;
  if (!SCORING_MODES.includes(mode)) {
    throw new Error(`BOOM_SCORING must be one of ${SCORING_MODES.join(', ')}; got "${val}"`);
  }
  return mode;
}

export type Config = {
  socketMode: boolean;
  botToken: string;
  appToken?: string;
  signingSecret?: string;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  allowedChannels?: Set<string>;
  defaultReplyMode: 'thread' | 'channel';

  features: Set<string>;
  boomScoring: Scoring;
  chatAllowedChannels?: Set<string>;
  chatConfigPath?: string;

  openaiApiKey?: string;
  openaiModel: string;

  chatEnabled: boolean;
  chatHistoryMaxTurns: number;
  chatHistoryMaxChars: number;
  chatInputMaxChars: number;
  chatReplyMaxTokens: number;
  chatTemperature: number;
  chatSystemPrompt: string;
};

type SlackTransport = Pick<
  Config,
  'socketMode' | 'botToken' | 'appToken' | 'signingSecret' | 'port' | 'logLevel'
>;

type ChannelRouting = Pick<Config, 'allowedChannels' | 'chatAllowedChannels' | 'defaultReplyMode'>;

type BoomSettings = Pick<Config, 'features' | 'boomScoring'>;

type ChatSettings = Pick<
  Config,
  | 'chatConfigPath'
  | 'openaiApiKey'
  | 'openaiModel'
  | 'chatEnabled'
  | 'chatHistoryMaxTurns'
  | 'chatHistoryMaxChars'
  | 'chatInputMaxChars'
  | 'chatReplyMaxTokens'
  | 'chatTemperature'
  | 'chatSystemPrompt'
>;

function parseBool(val: string | undefined, fallback = false): boolean {
  if (val == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(val.toLowerCase());
}

function parseCsv(val: string | undefined): string[] {
  return (val || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCsvSet(val: string | undefined): Set<string> | undefined {
  const items = parseCsv(val);
  return items.length ? new Set(items) : undefined;
}

function loadSlackTransport(): SlackTransport {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    throw new Error('Missing SLACK_BOT_TOKEN');
  }
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const socketMode = !!appToken && !parseBool(process.env.FORCE_HTTP, false);
  if (!socketMode && !signingSecret) {
    throw new Error('HTTP (Events API) requires SLACK_SIGNING_SECRET. Set SLACK_APP_TOKEN to use Socket Mode.');
  }
  return {
    socketMode,
    botToken,
    appToken,
    signingSecret,
    port: Number(process.env.PORT || 3000),
    logLevel: (process.env.LOG_LEVEL || 'info') as Config['logLevel'],
  };
}

function loadChannelRouting(): ChannelRouting {
  return {
    allowedChannels: parseCsvSet(process.env.ALLOWED_CHANNELS),
    chatAllowedChannels: parseCsvSet(process.env.CHAT_ALLOWED_CHANNELS),
    defaultReplyMode: (process.env.DEFAULT_REPLY_MODE || 'channel') as Config['defaultReplyMode'],
  };
}

function loadBoomSettings(): BoomSettings {
  const featuresList = parseCsv(process.env.FEATURES || 'boom,chat').map((s) => s.toLowerCase());
  return {
    features: new Set(featuresList),
    boomScoring: parseScoring(process.env.BOOM_SCORING),
  };
}

function loadChatSettings(): ChatSettings {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  return {
    openaiApiKey,
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-nano',
    chatConfigPath: process.env.CHAT_CONFIG || 'data/chat-config.json',
    chatEnabled: parseBool(process.env.CHAT_ENABLED, !!openaiApiKey),
    chatHistoryMaxTurns: Number(process.env.CHAT_HISTORY_MAX_TURNS || 20),
    chatHistoryMaxChars: Number(process.env.CHAT_HISTORY_MAX_CHARS || 16000),
    chatInputMaxChars: Number(process.env.CHAT_INPUT_MAX_CHARS || 4000),
    chatReplyMaxTokens: Number(process.env.CHAT_REPLY_MAX_TOKENS || 512),
    chatTemperature:
      process.env.CHAT_TEMPERATURE != null ? Number(process.env.CHAT_TEMPERATURE) : 0.7,
    chatSystemPrompt: process.env.CHAT_SYSTEM_PROMPT || DEFAULT_CHAT_SYSTEM_PROMPT,
  };
}

export function loadConfig(): Config {
  return {
    ...loadSlackTransport(),
    ...loadChannelRouting(),
    ...loadBoomSettings(),
    ...loadChatSettings(),
  };
}
