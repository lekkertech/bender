import type { Config } from '../../env.js';
import type { ChatEntry } from './types.js';

export function clipInput(s: string, max: number): string {
  if (!s) return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function pruneHistoryInPlace(arr: ChatEntry[], maxTurns: number, maxChars: number): void {
  // 1) Cap by turns (approx pairs → 2 entries per turn)
  const maxEntries = Math.max(2, Math.floor(maxTurns) * 2);
  while (arr.length > maxEntries) arr.shift();

  // 2) Cap by total characters across rendered transcript
  const renderLen = (items: ChatEntry[]) =>
    items.reduce((n, e) => n + (e.role === 'user' ? 6 : 10) + e.text.length + 1, 0); // "User: " ~6; "Assistant: " ~10
  if (renderLen(arr) <= maxChars) return;

  // Drop from oldest until within limit
  while (arr.length > 1 && renderLen(arr) > maxChars) {
    arr.shift();
  }
}

export function buildTranscript(arr: ChatEntry[], maxChars: number): string {
  // Render chronological; if still too long, drop from the start until within cap
  const labelFor = (e: ChatEntry) =>
    e.author != null ? e.author : e.role === 'user' ? (e.uid ? `<@${e.uid}>` : 'User') : 'Assistant';
  const lines = arr.map((e) => `${labelFor(e)}: ${e.text}`);
  let start = 0;
  let text = lines.join('\n');
  while (text.length > maxChars && start < lines.length - 1) {
    start++;
    text = lines.slice(start).join('\n');
  }
  return text;
}

export function inAllowedChannelChat(cfg: Config, channel?: string): boolean {
  // Chat feature: if CHAT_ALLOWED_CHANNELS is unset, allow any channel the bot is in.
  const set = cfg.chatAllowedChannels;
  if (!set) return true;
  return channel ? set.has(channel) : false;
}

export function preferredThreadTs(cfg: Config, ev: any): string | undefined {
  // Channel mode: always reply in channel (never thread), regardless of where the mention occurred
  if (cfg.defaultReplyMode === 'channel') {
    return undefined;
  }
  // Thread mode: always thread the reply (start a thread if none)
  return ev.thread_ts || ev.ts;
}

export function stripLeadingBotMention(text: string): string {
  // Remove the first leading mention token (assumed bot) and surrounding whitespace
  return String(text || '').replace(/^\s*<@[^>]+>\s*/i, '');
}

export function cleanedLower(text: string): string {
  return stripLeadingBotMention(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isLeaderboardCommand(text: string): boolean {
  return cleanedLower(text) === 'leaderboard';
}