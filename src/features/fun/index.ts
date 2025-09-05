import type { App } from '@slack/bolt';
import type { Config } from '../../env.js';
import { OpenAIClient } from '../../ai/openai.js';
import { RateLimiter } from '../../util/rateLimit.js';
import { shouldBypassRateLimit } from '../../util/admin.js';
import { readFileSync, existsSync } from 'node:fs';
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

type FunCommandConfig = {
  name: string;                 // e.g. "haiku"
  pattern: string;              // regex string applied to mention text after "@bot"
  promptTemplate: string;       // template with {{arg1}}, {{arg2}}, {{target}}, {{raw}}, {{variant}}
  temperature?: number;
  maxTokens?: number;
  help: string;                 // e.g. "haiku <topic>"
  // Optional variant control: if the given capture group is present/non-empty, set ctx.variant to then/else
  variantGroup?: number;
  variantThen?: string;
  variantElse?: string;
};

type CompiledCommand = FunCommandConfig & {
  regex: RegExp;
};

function inAllowedChannelFun(cfg: Config, channel?: string): boolean {
  // Fun feature: if FUN_ALLOWED_CHANNELS is unset, allow any channel the bot is in.
  const set = cfg.funAllowedChannels;
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

function renderTemplate(tpl: string, ctx: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => (ctx[key] ?? ''));
}

/* No built-in default fun commands — commands are provided via JSON config. */

function compileCommands(cfgs: FunCommandConfig[]): CompiledCommand[] {
  const compiled: CompiledCommand[] = [];
  for (const c of cfgs) {
    try {
      const regex = new RegExp(c.pattern, 'i');
      compiled.push({ ...c, regex });
    } catch {
      // Skip invalid regex entries
      continue;
    }
  }
  return compiled;
}

type ChatDefaultConfig = {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
};

type FunBundleConfig = {
  commands: FunCommandConfig[];
  defaultChat?: ChatDefaultConfig; // from fun-commands.json "default" section
};

function loadFunBundleConfig(fp: string | undefined): FunBundleConfig | null {
  try {
    if (!fp) return null;
    const raw = readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw) as {
      default?: ChatDefaultConfig;
      defaultChat?: ChatDefaultConfig; // allow either key, prefer "default"
      commands?: FunCommandConfig[];
    };
    const commands = Array.isArray(parsed?.commands) && parsed!.commands!.length
      ? (parsed!.commands as FunCommandConfig[])
      : [];
    const defaultChat = (parsed?.default ?? parsed?.defaultChat) || undefined;
    return { commands, defaultChat };
  } catch {
    return null;
  }
}

export function registerFunFeature(app: App, cfg: Config) {
  // Resolve config path (relative to cwd if not absolute)
  const funCfgPath = cfg.funConfigPath
    ? (isAbsolute(cfg.funConfigPath) ? cfg.funConfigPath : join(process.cwd(), cfg.funConfigPath))
    : undefined;

  // Load commands and optional default chat settings from JSON (no built-in defaults)
  const bundle = funCfgPath && existsSync(funCfgPath) ? loadFunBundleConfig(funCfgPath) : null;
  const commandConfigs: FunCommandConfig[] = bundle?.commands ?? [];
  const commands = compileCommands(commandConfigs);
  const defaultChat = bundle?.defaultChat;

  const ai = new OpenAIClient(cfg.openaiApiKey, cfg.openaiModel);

  // Rate limits: per-user 1/min, per-channel 20/min
  const userLimiter = new RateLimiter({ capacity: 1, refillTokens: 1, refillIntervalMs: 60_000 });
  const channelLimiter = new RateLimiter({ capacity: 20, refillTokens: 20, refillIntervalMs: 60_000 });

  app.event('app_mention', async ({ event, client, logger }) => {
    try {
      const ev = event as any;
      if (!inAllowedChannelFun(cfg, ev.channel)) return;

      // Delegate "leaderboard" to the boom feature
      if (cleanedLower(ev.text) === 'leaderboard') return;

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

      if (!ai.enabled()) {
        try {
          await client.chat.postEphemeral({
            channel: ev.channel,
            user: ev.user,
            text: 'AI is not configured. Set OPENAI_API_KEY to enable fun commands.',
          });
        } catch {}
        return;
      }

      const raw = String(ev.text || '');
      const afterBot = stripLeadingBotMention(raw);
      const afterBotTrim = afterBot.trim();
      const replyThreadTs = preferredThreadTs(cfg, ev);

      // Extract first user mention (may be referenced in templates as {{target}})
      const userMentionMatch = afterBotTrim.match(/<@[^>]+>/);
      const targetMention = userMentionMatch ? userMentionMatch[0] : '';

      const sendReply = async (text: string) => {
        const post: any = {
          channel: ev.channel,
          text: truncate(text),
        };
        if (replyThreadTs) post.thread_ts = replyThreadTs;
        await client.chat.postMessage(post);
      };

      // Try each configured command in order
      for (const cmd of commands) {
        const m = afterBotTrim.match(cmd.regex);
        if (!m) continue;

        // Build template context
        const ctx: Record<string, string> = { raw: afterBotTrim, target: targetMention };
        for (let i = 1; i < m.length; i++) {
          ctx[`arg${i}`] = (m[i] || '').trim();
        }
        if (cmd.variantGroup && typeof m[cmd.variantGroup] !== 'undefined') {
          const present = !!(m[cmd.variantGroup] && String(m[cmd.variantGroup]).trim());
          ctx.variant = present ? (cmd.variantThen || '') : (cmd.variantElse || '');
        }

        const prompt = renderTemplate(cmd.promptTemplate, ctx);
        const out = await ai.chat(prompt, {
          temperature: cmd.temperature ?? 0.8,
          maxTokens: cmd.maxTokens ?? 120,
        });
        await sendReply(out);
        return;
      }

      // If nothing matched, either show help (explicit) or use chat fallback
      const lowered = cleanedLower(ev.text);

      const postHelp = async () => {
        const helpLines: string[] = [];
        if (commands.length) {
          helpLines.push('*Fun commands:*');
          for (const c of commands) {
            if (c.help) helpLines.push(`• ${c.help}`);
          }
          helpLines.push('', 'Example: @bot <command> <args>');
        } else {
          helpLines.push('No predefined fun commands configured. Try asking me a question with “@bot …”.');
        }
        const post: any = {
          channel: ev.channel,
          text: helpLines.join('\n'),
        };
        if (replyThreadTs) post.thread_ts = replyThreadTs;
        await client.chat.postMessage(post);
      };

      // Explicit help triggers
      if (lowered === 'help' || lowered === '?help' || lowered === 'commands') {
        await postHelp();
        return;
      }

      // Chat fallback (in-memory, channel scoped) if enabled
      if (cfg.chatEnabled) {
        try {
          // Prepare per-channel history array
          let hist = channelHistory.get(ev.channel);
          if (!hist) {
            hist = [];
            channelHistory.set(ev.channel, hist);
          }

          // Append current user message (clip input length)
          const userMsg: ChatEntry = {
            role: 'user',
            text: clipInput(afterBotTrim, cfg.chatInputMaxChars),
            ts: String(ev.ts || ''),
          };
          hist.push(userMsg);

          // Prune by configured caps
          pruneHistoryInPlace(hist, cfg.chatHistoryMaxTurns, cfg.chatHistoryMaxChars);

          // Build transcript string
          const transcript = buildTranscript(hist, cfg.chatHistoryMaxChars);

          if (process.env.LOG_LEVEL === 'debug') {
            logger?.debug?.({
              channel: ev.channel,
              entries: hist.length,
              chatHistoryMaxTurns: cfg.chatHistoryMaxTurns,
              chatHistoryMaxChars: cfg.chatHistoryMaxChars,
              chatReplyMaxTokens: cfg.chatReplyMaxTokens,
              chatTemperature: cfg.chatTemperature,
            }, 'chat-fallback: invoking OpenAI');
          }

          const out = await ai.chat(`${transcript}\n\nAssistant:`, {
            temperature: (defaultChat?.temperature ?? cfg.chatTemperature),
            maxTokens: (defaultChat?.maxTokens ?? cfg.chatReplyMaxTokens),
            systemPrompt: (defaultChat?.systemPrompt ?? cfg.chatSystemPrompt),
          });

          // Send reply per default reply mode
          const reply = truncate(out, 1500); // keep Slack-friendly; model already capped
          const post: any = { channel: ev.channel, text: reply };
          if (replyThreadTs) post.thread_ts = replyThreadTs;
          await client.chat.postMessage(post);

          // Append assistant message and prune again
          hist.push({ role: 'assistant', text: reply, ts: String(Date.now()) });
          pruneHistoryInPlace(hist, cfg.chatHistoryMaxTurns, cfg.chatHistoryMaxChars);
          return;
        } catch (e) {
          logger?.error?.(e);
          // Fall through to help as a graceful degradation
        }
      }

      // Fallback when chat disabled or failed: show help
      await postHelp();
    } catch (err) {
      logger?.error?.(err);
    }
  });
}