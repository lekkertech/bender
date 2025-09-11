import type { ChatEntry } from './types.js';
import type { Config } from '../../env.js';
import { clipInput, pruneHistoryInPlace } from './helpers.js';

/**
 * In-memory state for chat history (channel-scoped).
 * Lost on process restart.
 */

// Channel-scoped transcript history (top-level channel messages only; exclude threads)
const channelHistory = new Map<string, ChatEntry[]>();

export function getChannelHistory(channelId: string): ChatEntry[] {
  let hist = channelHistory.get(channelId);
  if (!hist) {
    hist = [];
    channelHistory.set(channelId, hist);
  }
  return hist;
}

export function pushHistory(cfg: Config, channelId: string, entry: ChatEntry): void {
  const hist = getChannelHistory(channelId);
  const clipped: ChatEntry = { ...entry, text: clipInput(entry.text, cfg.chatInputMaxChars) };
  // Deduplicate by ts to avoid double-capturing the same Slack message across listeners
  const exists = hist.some((e) => e.ts === clipped.ts);
  if (exists) return;
  hist.push(clipped);
  pruneHistoryInPlace(hist, cfg.chatHistoryMaxTurns, cfg.chatHistoryMaxChars);
}

export function clearAllHistory(): { channels: number; totalEntries: number } {
  let totalEntries = 0;
  for (const arr of channelHistory.values()) totalEntries += arr.length;
  const channels = channelHistory.size;
  channelHistory.clear();
  return { channels, totalEntries };
}

export function clearChannelHistory(channelId: string): number {
  const hist = channelHistory.get(channelId) || [];
  const entries = hist.length;
  channelHistory.delete(channelId);
  return entries;
}

export function listChannelSummaries(): Array<{ channelId: string; entries: number }> {
  const out: Array<{ channelId: string; entries: number }> = [];
  for (const [cid, arr] of channelHistory.entries()) {
    out.push({ channelId: cid, entries: arr.length });
  }
  return out;
}

export { channelHistory };