import type { Config } from '../../env.js';
import { shouldBypassRateLimit, isWorkspaceAdmin } from '../../util/admin.js';
import type { ChatDefaultConfig, ChatEntry } from './types.js';
import {
  stripLeadingBotMention,
  preferredThreadTs,
  buildTranscript,
} from './helpers.js';
import {
  getChannelHistory,
  pushHistory as pushStateHistory,
  listChannelSummaries,
  clearAllHistory,
  clearChannelHistory,
} from './state.js';
import { updateDefaultPromptOnDisk, loadChatConfig } from './config.js';
import { OpenAIClient } from '../../ai/openai.js';
import { RateLimiter } from '../../util/rateLimit.js';

type Deps = {
  cfg: Config;
  chatCfgPath?: string;
  getDefaultChat: () => ChatDefaultConfig | null;
  setDefaultChat: (c: ChatDefaultConfig | null) => void;
  ai: OpenAIClient;
  userLimiter: RateLimiter;
  channelLimiter: RateLimiter;
};

export function createChatHandlers(deps: Deps) {
  const { cfg, chatCfgPath, getDefaultChat, setDefaultChat, ai, userLimiter, channelLimiter } = deps;

  const handleClearContext = async (ev: any, client: any, logger: any): Promise<boolean> => {
    const rawText = String(ev.text || '');
    const afterBotTrimEarly = stripLeadingBotMention(rawText).trim();
    const clearAllMatch = afterBotTrimEarly.match(/^clear\s+(chat|context)\s+all\s*$/i);
    const clearOneMatch = clearAllMatch ? null : afterBotTrimEarly.match(/^clear\s+(chat|context)\s*$/i);
    if (!clearAllMatch && !clearOneMatch) return false;

    const isAdmin = await isWorkspaceAdmin(client as any, ev.user);
    if (!isAdmin) {
      try {
        await client.chat.postEphemeral({
          channel: ev.channel,
          user: ev.user,
          text: 'Only workspace admins or users in ADMIN_USER_IDS may clear chat context.',
        });
      } catch {}
      return true;
    }

    if (clearAllMatch) {
      const { channels, totalEntries } = clearAllHistory();
      logger?.debug?.({ userId: ev.user, channels, totalEntries }, 'chat: cleared all channel contexts');
      try {
        await client.chat.postEphemeral({
          channel: ev.channel,
          user: ev.user,
          text: `Cleared chat context for ${channels} channel${channels === 1 ? '' : 's'} (${totalEntries} message${totalEntries === 1 ? '' : 's'}).`,
        });
      } catch {}
      return true;
    } else {
      const entries = clearChannelHistory(ev.channel);
      logger?.debug?.({ userId: ev.user, channel: ev.channel, entries }, 'chat: cleared channel context');
      try {
        await client.chat.postEphemeral({
          channel: ev.channel,
          user: ev.user,
          text: `Cleared chat context for this channel (${entries} message${entries === 1 ? '' : 's'}).`,
        });
      } catch {}
      return true;
    }
  };

  const handleShowContext = async (ev: any, client: any, _logger: any): Promise<boolean> => {
    const rawText = String(ev.text || '');
    const afterBotTrimEarly = stripLeadingBotMention(rawText).trim();
    const showContext = /^context$/i.test(afterBotTrimEarly);
    if (!showContext) return false;

    const isAdmin = await isWorkspaceAdmin(client as any, ev.user);
    if (!isAdmin) {
      try {
        await client.chat.postEphemeral({
          channel: ev.channel,
          user: ev.user,
          text: 'Only workspace admins or users in ADMIN_USER_IDS may view chat context.',
        });
      } catch {}
      return true;
    }

    const lines: string[] = [];
    const chId = String(ev.channel || '');
    const hist = getChannelHistory(chId);

    // Current channel context
    lines.push('*Chat Context — Current Channel*');
    if (!hist.length) {
      lines.push('_No history for this channel._');
    } else {
      const transcript = buildTranscript(hist, Math.min(cfg.chatHistoryMaxChars, 3500));
      lines.push(transcript);
    }

    // All channels summary
    lines.push('');
    lines.push('*Chat Context — All Channels*');
    const all = listChannelSummaries();
    lines.push(`Total channels with history: ${all.length}`);
    if (all.length) {
      for (const { channelId, entries } of all) {
        lines.push(`• ${channelId} — ${entries} entr${entries === 1 ? 'y' : 'ies'}`);
      }
    }

    try {
      await client.chat.postMessage({
        channel: ev.channel,
        text: lines.join('\n'),
      });
    } catch {}
    return true;
  };

  const handleShowPrompt = async (ev: any, client: any): Promise<boolean> => {
    const rawText = String(ev.text || '');
    const afterBotTrim = stripLeadingBotMention(rawText).trim();
    const showPromptMatch = afterBotTrim.match(/^show\s+prompt\s*$/i);
    if (!showPromptMatch) return false;

    const defaults = getDefaultChat();
    const effective = ((defaults?.systemPrompt ?? cfg.chatSystemPrompt) || '').trim();
    let meta = null as null | { by?: string; when?: string };
    if (chatCfgPath) {
      const file = loadChatConfig(chatCfgPath);
      const last = file?.promptHistory && file.promptHistory[0];
      if (last) {
        meta = {
          by: last.setById ? `<@${last.setById}>${last.setByName ? ` (${last.setByName})` : ''}` : undefined,
          when: last.ts,
        };
      }
    }
    const lines: string[] = [];
    lines.push('*Current chat system prompt:*');
    lines.push(effective ? effective : '_using built-in default (CHAT_SYSTEM_PROMPT)_');
    if (meta?.by || meta?.when) {
      lines.push('');
      lines.push(`Last set by: ${meta.by ?? 'n/a'}`);
      lines.push(`When: ${meta.when ?? 'n/a'}`);
    }
    try {
      await client.chat.postEphemeral({
        channel: ev.channel,
        user: ev.user,
        text: lines.join('\n'),
      });
    } catch {}
    return true;
  };

  const handleSetPrompt = async (ev: any, client: any): Promise<boolean> => {
    const rawText = String(ev.text || '');
    const afterBotTrim = stripLeadingBotMention(rawText).trim();
    const updateDefaultMatch = afterBotTrim.match(/^set\s+prompt\s+([\s\S]+)$/i);
    if (!updateDefaultMatch) return false;

    const isAdmin = await isWorkspaceAdmin(client as any, ev.user);
    if (!isAdmin) {
      try {
        await client.chat.postEphemeral({
          channel: ev.channel,
          user: ev.user,
          text: 'Only workspace admins or users in ADMIN_USER_IDS may update the prompt.',
        });
      } catch {}
      return true;
    }
    if (!chatCfgPath) {
      try {
        await client.chat.postEphemeral({
          channel: ev.channel,
          user: ev.user,
          text: 'Chat config path not set. Set CHAT_CONFIG to a writable JSON file (e.g., data/chat-config.json).',
        });
      } catch {}
      return true;
    }

    const newPrompt = updateDefaultMatch[1].trim();
    let setterName: string | undefined;
    try {
      const info: any = await (client as any)?.users?.info?.({ user: ev.user });
      const user = info?.user;
      const profile = user?.profile || {};
      setterName =
        (profile.display_name && String(profile.display_name).trim()) ||
        (profile.real_name && String(profile.real_name).trim()) ||
        (user?.name ? String(user.name) : undefined);
    } catch {}

    try {
      const res = updateDefaultPromptOnDisk(chatCfgPath, newPrompt, { id: ev.user, name: setterName });
      setDefaultChat(res.defaultChat); // hot-reload in-memory default
      await client.chat.postEphemeral({
        channel: ev.channel,
        user: ev.user,
        text: `Updated default system prompt. Kept ${res.promptHistory.length} in history (latest 10).`,
      });
    } catch (e) {
      await client.chat.postEphemeral({
        channel: ev.channel,
        user: ev.user,
        text: `Failed to update default prompt: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    return true;
  };

  const allowThroughRateLimit = async (ev: any, client: any, logger: any): Promise<boolean> => {
    const bypass = await shouldBypassRateLimit(client as any, ev.user);
    if (!bypass) {
      const uok = userLimiter.consume('user', ev.user);
      const cok = channelLimiter.consume('channel', ev.channel);
      if (!uok || !cok) {
        try {
          await client.chat.postEphemeral({
            channel: ev.channel,
            user: ev.user,
            text: 'Easy there — you are rate limited. Try again in a minute.',
          });
        } catch {}
        return false;
      }
    } else {
      logger?.debug?.({ userId: ev.user, channel: ev.channel }, 'admin/owner bypassed rate limit');
    }
    return true;
  };

  const handleChatResponse = async (ev: any, client: any, logger: any): Promise<void> => {
    // Ensure channel history container exists
    getChannelHistory(ev.channel);

    const raw = String(ev.text || '');
    const afterBot = stripLeadingBotMention(raw);
    const afterBotTrim = afterBot.trim();
    const replyThreadTs = preferredThreadTs(cfg, ev);

    // Append current user message (deduped)
    const userMsg: ChatEntry = {
      role: 'user',
      text: afterBotTrim,
      ts: String(ev.ts || ''),
      uid: String(ev.user || ''),
    };
    pushStateHistory(cfg, ev.channel, userMsg);

    // Debug metrics (do not include transcript in model prompt)
    const hist = getChannelHistory(ev.channel);
    logger?.debug?.(
      {
        channel: ev.channel,
        entries: hist.length,
        chatHistoryMaxTurns: cfg.chatHistoryMaxTurns,
        chatHistoryMaxChars: cfg.chatHistoryMaxChars,
        chatReplyMaxTokens: cfg.chatReplyMaxTokens,
        chatTemperature: cfg.chatTemperature,
      },
      'chat: invoking OpenAI'
    );

    // Build messages from captured channel history (system + prior turns + current turn)
    const defaults = getDefaultChat();
    const systemPrompt = defaults?.systemPrompt ?? cfg.chatSystemPrompt;
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
    if (systemPrompt && systemPrompt.trim()) {
      messages.push({ role: 'system', content: systemPrompt.trim() });
    }
    for (const e of hist) {
      const role = e.role === 'assistant' ? 'assistant' : 'user';
      messages.push({ role, content: e.text });
    }
    const promptCacheKey = `chat:${ev.channel}${replyThreadTs ? '#' + replyThreadTs : ''}`;
    const outText = await ai.chatCompletion(messages, {
      temperature: defaults?.temperature ?? cfg.chatTemperature,
      maxCompletionTokens: defaults?.maxTokens ?? cfg.chatReplyMaxTokens,
      promptCacheKey,
      logger,
    });

    const post: any = { channel: ev.channel, text: outText };
    if (replyThreadTs) post.thread_ts = replyThreadTs;
    const sent = await client.chat.postMessage(post);
    // Record assistant message in history (capture even if posted in a thread)
    pushStateHistory(cfg, ev.channel, {
      role: 'assistant',
      text: outText,
      ts: String((sent as any)?.ts || Date.now()),
      author: 'Assistant',
    });
  };

  return {
    handleClearContext,
    handleShowContext,
    handleShowPrompt,
    handleSetPrompt,
    allowThroughRateLimit,
    handleChatResponse,
  };
}