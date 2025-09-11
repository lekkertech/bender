import type { App } from '@slack/bolt';
import type { Config } from '../../env.js';
import { OpenAIClient } from '../../ai/openai.js';
import { RateLimiter } from '../../util/rateLimit.js';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { ChatDefaultConfig, ChatEntry, ChatRole } from './types.js';
import { inAllowedChannelChat, isLeaderboardCommand } from './helpers.js';
import { pushHistory } from './state.js';
import { loadChatConfig } from './config.js';
import { createChatHandlers } from './handlers.js';

export function registerChatFeature(app: App, cfg: Config) {
  // Resolve optional chat config path (relative to cwd if not absolute)
  const chatCfgPath = cfg.chatConfigPath
    ? (isAbsolute(cfg.chatConfigPath)
        ? cfg.chatConfigPath
        : join(process.cwd(), cfg.chatConfigPath))
    : undefined;

  // Load optional default chat settings from JSON
  const initialCfg = chatCfgPath && existsSync(chatCfgPath) ? loadChatConfig(chatCfgPath) : null;
  let defaultChat: ChatDefaultConfig | null = initialCfg?.default || initialCfg?.defaultChat || null;

  const ai = new OpenAIClient(cfg.openaiApiKey, cfg.openaiModel);

  // Rate limits: per-user 1/min, per-channel 20/min
  const userLimiter = new RateLimiter({ capacity: 1, refillTokens: 1, refillIntervalMs: 60_000 });
  const channelLimiter = new RateLimiter({ capacity: 20, refillTokens: 20, refillIntervalMs: 60_000 });

  // Construct handlers (SOLID: encapsulate chat orchestration/logic)
  const handlers = createChatHandlers({
    cfg,
    chatCfgPath,
    getDefaultChat: () => defaultChat,
    setDefaultChat: (c) => {
      defaultChat = c;
    },
    ai,
    userLimiter,
    channelLimiter,
  });

  // Passive capture: record all channel messages (users and bots), but only top-level (exclude threads).
  app.message(async ({ message, logger }) => {
    try {
      const m = message as any;
      if (!m) return;
      if (!inAllowedChannelChat(cfg, m.channel)) return;

      // Ignore edits/deletes and thread broadcasts
      const st = String(m.subtype || '');
      if (st === 'message_changed' || st === 'message_deleted' || st === 'thread_broadcast') return;
      // Exclude thread replies from context (only keep top-level channel messages)
      if (m.thread_ts && String(m.thread_ts) !== String(m.ts)) return;

      const tsStr = String(m.ts || '');
      const textRaw = String(m.text || '');
      if (!tsStr || !textRaw) return;

      const role: ChatRole = st === 'bot_message' ? 'assistant' : 'user';
      const uid = typeof m.user === 'string' ? m.user : undefined;
      const author = role === 'assistant' ? (m.username ? String(m.username) : 'Assistant') : undefined;

      const entry: ChatEntry = { role, text: textRaw, ts: tsStr, uid, author };
      pushHistory(cfg, m.channel, entry);
    } catch (err) {
      logger?.error?.(err);
    }
  });

  // Orchestrator for app_mention handling (delegates to handlers)
  app.event('app_mention', async ({ event, client, logger }) => {
    try {
      const ev = event as any;
      if (!inAllowedChannelChat(cfg, ev.channel)) return;
      if (isLeaderboardCommand(ev.text || '')) return;

      if (await handlers.handleClearContext(ev, client, logger)) return;
      if (await handlers.handleShowContext(ev, client, logger)) return;
      if (await handlers.handleShowPrompt(ev, client)) return;
      if (await handlers.handleSetPrompt(ev, client)) return;

      if (!ai.enabled()) {
        try {
          await client.chat.postEphemeral({
            channel: ev.channel,
            user: ev.user,
            text: 'AI is not configured. Set OPENAI_API_KEY to enable chat.',
          });
        } catch {}
        return;
      }

      if (!(await handlers.allowThroughRateLimit(ev, client, logger))) return;

      await handlers.handleChatResponse(ev, client, logger);
    } catch (err) {
      logger?.error?.(err);
    }
  });
}