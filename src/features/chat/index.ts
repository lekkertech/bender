import type { App } from '@slack/bolt';
import type { Config } from '../../env.js';
import { OpenAIClient } from '../../ai/openai.js';
import { RateLimiter } from '../../util/rateLimit.js';
import { shouldBypassRateLimit, isWorkspaceAdmin } from '../../util/admin.js';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// In-memory, channel-scoped chat history (lost on restart)
type ChatRole = 'user' | 'assistant';
type ChatEntry = { role: ChatRole; text: string; ts: string };
const channelHistory = new Map<string, ChatEntry[]>();

function clipInput(s: string, max: number): string {
  if (!s) return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function pruneHistoryInPlace(arr: ChatEntry[], maxTurns: number, maxChars: number): void {
  // 1) Cap by turns (approx pairs → 2 entries per turn)
  const maxEntries = Math.max(2, Math.floor(maxTurns) * 2);
  while (arr.length > maxEntries) arr.shift();

  // 2) Cap by total characters across rendered transcript
  const renderLen = (items: ChatEntry[]) =>
    items.reduce((n, e) => n + (e.role === 'user' ? 6 : 10) + e.text.length + 1, 0); // "User: "=6 incl space; "Assistant: " ~10
  if (renderLen(arr) <= maxChars) return;

  // Drop from oldest until within limit
  while (arr.length > 1 && renderLen(arr) > maxChars) {
    arr.shift();
  }
}

function buildTranscript(arr: ChatEntry[], maxChars: number): string {
  // Render chronological; if still too long, drop from the start until within cap
  const lines = arr.map((e) => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.text}`);
  let start = 0;
  let text = lines.join('\n');
  while (text.length > maxChars && start < lines.length - 1) {
    start++;
    text = lines.slice(start).join('\n');
  }
  return text;
}

function inAllowedChannelChat(cfg: Config, channel?: string): boolean {
  // Chat feature: if CHAT_ALLOWED_CHANNELS is unset, allow any channel the bot is in.
  const set = cfg.chatAllowedChannels;
  if (!set) return true;
  return channel ? set.has(channel) : false;
}

function preferredThreadTs(cfg: Config, ev: any): string | undefined {
  // Channel mode: always reply in channel (never thread), regardless of where the mention occurred
  if (cfg.defaultReplyMode === 'channel') {
    return undefined;
  }
  // Thread mode: always thread the reply (start a thread if none)
  return ev.thread_ts || ev.ts;
}

function stripLeadingBotMention(text: string): string {
  // Remove the first leading mention token (assumed bot) and surrounding whitespace
  return String(text || '').replace(/^\s*<@[^>]+>\s*/i, '');
}

function cleanedLower(text: string): string {
  return stripLeadingBotMention(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

function truncate(s: string, max = 800): string {
  if (!s) return s;
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

type ChatDefaultConfig = {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
};

function loadChatDefault(fp: string | undefined): ChatDefaultConfig | null {
  try {
    if (!fp) return null;
    const raw = readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw) as {
      default?: ChatDefaultConfig;
      defaultChat?: ChatDefaultConfig; // allow either key, prefer "default"
    };
    const def = (parsed?.default ?? parsed?.defaultChat) || undefined;
    return def || null;
  } catch {
    return null;
  }
}

/**
 * Chat config file shape.
 */
type PromptRecord = {
  text: string;
  setById: string;
  setByName?: string;
  ts: string; // ISO8601
};
type ChatConfigFile = {
  default?: ChatDefaultConfig;
  defaultChat?: ChatDefaultConfig; // legacy support
  promptHistory?: PromptRecord[];
};

/**
 * Load full chat config (default + history).
 */
function loadChatConfig(fp: string | undefined): ChatConfigFile | null {
  try {
    if (!fp) return null;
    const raw = readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw) as ChatConfigFile;
    const def = parsed?.default ?? parsed?.defaultChat;
    const hist = Array.isArray(parsed?.promptHistory) ? parsed!.promptHistory! : [];
    return { default: def, promptHistory: hist };
  } catch {
    return null;
  }
}

/**
 * Atomically write JSON to disk by writing to a temp file and renaming.
 */
function writeJsonAtomic(fp: string, obj: any): void {
  const tmp = `${fp}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, fp);
}

/**
 * Update the top-level default systemPrompt on disk and append a history record.
 * Keeps only the last 10 history entries. Returns updated default + history.
 */
function updateDefaultPromptOnDisk(
  fp: string,
  newPrompt: string,
  setter: { id: string; name?: string }
): { defaultChat: ChatDefaultConfig; promptHistory: PromptRecord[] } {
  const current = loadChatConfig(fp) || { default: {}, promptHistory: [] };
  const updatedDefault: ChatDefaultConfig = { ...(current.default || {}), systemPrompt: newPrompt };

  const rec: PromptRecord = {
    text: newPrompt,
    setById: setter.id,
    setByName: setter.name,
    ts: new Date().toISOString(),
  };
  const history = [rec, ...(current.promptHistory || [])].slice(0, 10);

  const out: any = {};
  if (
    updatedDefault &&
    (updatedDefault.systemPrompt != null ||
      updatedDefault.temperature != null ||
      updatedDefault.maxTokens != null)
  ) {
    out.default = updatedDefault;
  }
  out.promptHistory = history;

  writeJsonAtomic(fp, out);
  return { defaultChat: updatedDefault, promptHistory: history };
}

export function registerChatFeature(app: App, cfg: Config) {
  // Resolve optional chat config path (relative to cwd if not absolute)
  const chatCfgPath = cfg.chatConfigPath
    ? (isAbsolute(cfg.chatConfigPath)
        ? cfg.chatConfigPath
        : join(process.cwd(), cfg.chatConfigPath))
    : undefined;

  // Load optional default chat settings from JSON
  const initialCfg = chatCfgPath && existsSync(chatCfgPath) ? loadChatConfig(chatCfgPath) : null;
  let defaultChat = initialCfg?.default || initialCfg?.defaultChat || null;

  const ai = new OpenAIClient(cfg.openaiApiKey, cfg.openaiModel);
 
  // Rate limits: per-user 1/min, per-channel 20/min
  const userLimiter = new RateLimiter({ capacity: 1, refillTokens: 1, refillIntervalMs: 60_000 });
  const channelLimiter = new RateLimiter({ capacity: 20, refillTokens: 20, refillIntervalMs: 60_000 });
 
  // Helper to safely append to channel history with dedupe + pruning
  const pushHistory = (channelId: string, entry: ChatEntry) => {
    let hist = channelHistory.get(channelId);
    if (!hist) {
      hist = [];
      channelHistory.set(channelId, hist);
    }
    const clipped: ChatEntry = { ...entry, text: clipInput(entry.text, cfg.chatInputMaxChars) };
    // Deduplicate by (ts, role) only, so app_mention and message listeners don't double-store the same message
    const exists = hist.some((e) => e.ts === clipped.ts && e.role === clipped.role);
    if (exists) return;
    hist.push(clipped);
    pruneHistoryInPlace(hist, cfg.chatHistoryMaxTurns, cfg.chatHistoryMaxChars);
  };
 
  // Passive capture: record all channel messages (users and bots), both top-level and thread replies.
  app.message(async ({ message, logger }) => {
    try {
      const m = message as any;
      if (!m) return;
      if (!inAllowedChannelChat(cfg, m.channel)) return;
 
      // Ignore edits/deletes to avoid noisy duplicates; capture initial posts including bot_message and thread_broadcast
      const st = String(m.subtype || '');
      if (st === 'message_changed' || st === 'message_deleted') return;
 
      const tsStr = String(m.ts || '');
      const textRaw = String(m.text || '');
      if (!tsStr || !textRaw) return;
 
      pushHistory(m.channel, { role: 'user', text: textRaw, ts: tsStr });
    } catch (err) {
      logger?.error?.(err);
    }
  });
 
  app.event('app_mention', async ({ event, client, logger }) => {
    try {
      const ev = event as any;
      if (!inAllowedChannelChat(cfg, ev.channel)) return;

      // Delegate "leaderboard" to the boom feature
      if (cleanedLower(ev.text) === 'leaderboard') return;

      // Admin-only: clear in-memory chat context
      // Syntax:
      //   "@bot clear chat" or "@bot clear context"        → clear current channel
      //   "@bot clear chat all" or "@bot clear context all" → clear all channels
      {
        const rawText = String(ev.text || '');
        const afterBotTrimEarly = stripLeadingBotMention(rawText).trim();

        const clearAllMatch = afterBotTrimEarly.match(/^clear\s+(chat|context)\s+all\s*$/i);
        const clearOneMatch = clearAllMatch ? null : afterBotTrimEarly.match(/^clear\s+(chat|context)\s*$/i);

        if (clearAllMatch || clearOneMatch) {
          const isAdmin = await isWorkspaceAdmin(client as any, ev.user);
          if (!isAdmin) {
            try {
              await client.chat.postEphemeral({
                channel: ev.channel,
                user: ev.user,
                text: 'Only workspace admins or users in ADMIN_USER_IDS may clear chat context.',
              });
            } catch {}
            return;
          }

          if (clearAllMatch) {
            let totalEntries = 0;
            for (const arr of channelHistory.values()) totalEntries += arr.length;
            const channels = channelHistory.size;
            channelHistory.clear();
            if (process.env.LOG_LEVEL === 'debug') {
              logger?.debug?.({ userId: ev.user, channels, totalEntries }, 'chat: cleared all channel contexts');
            }
            try {
              await client.chat.postEphemeral({
                channel: ev.channel,
                user: ev.user,
                text: `Cleared chat context for ${channels} channel${channels === 1 ? '' : 's'} (${totalEntries} message${totalEntries === 1 ? '' : 's'}).`,
              });
            } catch {}
            return;
          } else {
            const hist = channelHistory.get(ev.channel) || [];
            const entries = hist.length;
            channelHistory.delete(ev.channel);
            if (process.env.LOG_LEVEL === 'debug') {
              logger?.debug?.({ userId: ev.user, channel: ev.channel, entries }, 'chat: cleared channel context');
            }
            try {
              await client.chat.postEphemeral({
                channel: ev.channel,
                user: ev.user,
                text: `Cleared chat context for this channel (${entries} message${entries === 1 ? '' : 's'}).`,
              });
            } catch {}
            return;
          }
        }
      }

      // Admin-only: show in-memory chat context for debugging
      // Syntax: "@bot context" (single word)
      {
        const rawText = String(ev.text || '');
        const afterBotTrimEarly = stripLeadingBotMention(rawText).trim();
        const showContext = /^context$/i.test(afterBotTrimEarly);
        if (showContext) {
          const isAdmin = await isWorkspaceAdmin(client as any, ev.user);
          if (!isAdmin) {
            try {
              await client.chat.postEphemeral({
                channel: ev.channel,
                user: ev.user,
                text: 'Only workspace admins or users in ADMIN_USER_IDS may view chat context.',
              });
            } catch {}
            return;
          }

          const lines: string[] = [];
          const chId = String(ev.channel || '');
          const hist = channelHistory.get(chId) || [];

          // Current channel context
          lines.push('*Chat Context — Current Channel*');
          if (!hist.length) {
            lines.push('_No history for this channel._');
          } else {
            // Cap transcript length for safety
            const transcript = buildTranscript(hist, Math.min(cfg.chatHistoryMaxChars, 3500));
            lines.push(transcript);
          }

          // All channels summary
          lines.push('');
          lines.push('*Chat Context — All Channels*');
          const all = Array.from(channelHistory.entries());
          lines.push(`Total channels with history: ${all.length}`);
          if (all.length) {
            for (const [cid, arr] of all) {
              const n = arr.length;
              lines.push(`• ${cid} — ${n} entr${n === 1 ? 'y' : 'ies'}`);
            }
          }

          try {
            await client.chat.postMessage({
              channel: ev.channel,
              text: lines.join('\n'),
            });
          } catch {}
          return;
        }
      }
      // Basic rate limiting with admin bypass
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
          return;
        }
      } else {
        logger?.debug?.({ userId: ev.user, channel: ev.channel }, 'admin/owner bypassed rate limit');
      }

      const raw = String(ev.text || '');
      const afterBot = stripLeadingBotMention(raw);
      const afterBotTrim = afterBot.trim();
      const replyThreadTs = preferredThreadTs(cfg, ev);

      // Show current prompt (any user)
      // Syntax: "@bot show prompt"
      const showPromptMatch = afterBotTrim.match(/^show\s+prompt\s*$/i);
      if (showPromptMatch) {
        const effective = ((defaultChat?.systemPrompt ?? cfg.chatSystemPrompt) || '').trim();
        let meta = null as null | { by?: string; when?: string };
        if (chatCfgPath && existsSync(chatCfgPath)) {
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
        return;
      }

      // Admin-only: update the system prompt from Slack
      // Syntax: "@bot set prompt <new system prompt>"
      const updateDefaultMatch = afterBotTrim.match(/^set\s+prompt\s+([\s\S]+)$/i);
      if (updateDefaultMatch) {
        const isAdmin = await isWorkspaceAdmin(client as any, ev.user);
        if (!isAdmin) {
          try {
            await client.chat.postEphemeral({
              channel: ev.channel,
              user: ev.user,
              text: 'Only workspace admins or users in ADMIN_USER_IDS may update the prompt.',
            });
          } catch {}
          return;
        }

        if (!chatCfgPath) {
          try {
            await client.chat.postEphemeral({
              channel: ev.channel,
              user: ev.user,
              text: 'Chat config path not set. Set CHAT_CONFIG to a writable JSON file (e.g., data/chat-config.json).',
            });
          } catch {}
          return;
        }

        const newPrompt = updateDefaultMatch[1].trim();

        // Try resolve a human-friendly name (best-effort)
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
          defaultChat = res.defaultChat; // hot-reload in-memory default
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
        return;
      }

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

      // Prepare per-channel history array
      let hist = channelHistory.get(ev.channel);
      if (!hist) {
        hist = [];
        channelHistory.set(ev.channel, hist);
      }
 
      // Append current user message (deduped)
      const userMsg: ChatEntry = {
        role: 'user',
        text: clipInput(afterBotTrim, cfg.chatInputMaxChars),
        ts: String(ev.ts || ''),
      };
      pushHistory(ev.channel, userMsg);
      // Refresh local reference (pushHistory may have pruned or deduped)
      hist = channelHistory.get(ev.channel) || hist;
 
      // Build transcript string
      const transcript = buildTranscript(hist, cfg.chatHistoryMaxChars);

      if (process.env.LOG_LEVEL === 'debug') {
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
      }

      const out = await ai.chat(`${transcript}\n\nAssistant:`, {
        temperature: defaultChat?.temperature ?? cfg.chatTemperature,
        maxTokens: defaultChat?.maxTokens ?? cfg.chatReplyMaxTokens,
        systemPrompt: defaultChat?.systemPrompt ?? cfg.chatSystemPrompt,
      });

      // Send reply per default reply mode
      const reply = truncate(out, 1500); // keep Slack-friendly; model already capped
      const post: any = { channel: ev.channel, text: reply };
      if (replyThreadTs) post.thread_ts = replyThreadTs;
      await client.chat.postMessage(post);

      // Do not manually append assistant reply; passive message listener will capture the posted message event.
    } catch (err) {
      logger?.error?.(err);
    }
  });
}