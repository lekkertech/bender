export type ChatRole = 'user' | 'assistant';

export type ChatEntry = {
  role: ChatRole;
  text: string;
  ts: string;
  uid?: string;
  author?: string;
};

export type ChatDefaultConfig = {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
};

export type PromptRecord = {
  text: string;
  setById: string;
  setByName?: string;
  ts: string; // ISO8601
};

export type ChatConfigFile = {
  default?: ChatDefaultConfig;
  defaultChat?: ChatDefaultConfig; // legacy support
  promptHistory?: PromptRecord[];
};