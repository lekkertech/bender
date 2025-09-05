import type { App } from '@slack/bolt';
import type { Config } from '../../env.js';
import { OpenAIClient } from '../../ai/openai.js';
import { RateLimiter } from '../../util/rateLimit.js';
import { shouldBypassRateLimit } from '../../util/admin.js';
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

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

function defaultFunCommands(): FunCommandConfig[] {
  return [
    {
      name: 'haiku',
      pattern: '^haiku\\s+(.+)$',
      promptTemplate: 'Write a 3-line haiku in 5-7-5 syllable form about: {{arg1}}. No intro, no backticks, just the haiku. Keep it concise.',
      temperature: 0.7,
      maxTokens: 90,
      help: 'haiku <topic>',
    },
    {
      name: 'roast',
      pattern: '^roast\\s+(<@[^>]+>)(?:\\s+(spicy))?\\s*$',
      promptTemplate: 'Write a {{variant}} one-liner roast for {{arg1}}. Be witty and brief (max 25 words). No preambles. Return a single line.',
      temperature: 0.9,
      maxTokens: 80,
      help: 'roast <@user> [spicy]',
      variantGroup: 2,
      variantThen: 'spicy',
      variantElse: 'playful, mild',
    },
    {
      name: 'compliment',
      pattern: '^compliment\\s+(<@[^>]+>)\\s*$',
      promptTemplate: 'Give a sincere, upbeat one-liner compliment for {{arg1}}. Keep it under 25 words. No preambles.',
      temperature: 0.8,
      maxTokens: 80,
      help: 'compliment <@user>',
    },
    {
      name: 'emojify',
      pattern: '^emojify\\s+(.+)$',
      promptTemplate: 'Translate the following into a short emoji sequence that conveys the meaning. Avoid words unless necessary. Text: {{arg1}}',
      temperature: 0.8,
      maxTokens: 80,
      help: 'emojify <text>',
    },
    {
      name: 'slang-za',
      pattern: '^slang\\s+za\\s+(.+)$',
      promptTemplate: 'Rewrite the following into South African slang while staying friendly and clear. Keep it concise and fun. Original: {{arg1}}',
      temperature: 0.9,
      maxTokens: 120,
      help: 'slang za <text>',
    },
    {
      name: 'dadjoke',
      pattern: '^dadjoke\\b',
      promptTemplate: 'Tell one clean dad joke. Return a single short joke with setup and punchline.',
      temperature: 0.9,
      maxTokens: 120,
      help: 'dadjoke',
    },
  ];
}

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

function loadFunConfigFromFile(fp: string | undefined): FunCommandConfig[] | null {
  try {
    if (!fp) return null;
    const raw = readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw) as { commands?: FunCommandConfig[] };
    if (parsed && Array.isArray(parsed.commands) && parsed.commands.length) {
      return parsed.commands;
    }
    return null;
  } catch {
    return null;
  }
}

export function registerFunFeature(app: App, cfg: Config) {
  // Resolve config path (relative to cwd if not absolute)
  const funCfgPath = cfg.funConfigPath
    ? (isAbsolute(cfg.funConfigPath) ? cfg.funConfigPath : join(process.cwd(), cfg.funConfigPath))
    : undefined;

  // Load commands from JSON if available; otherwise use defaults
  const fileCommands = funCfgPath && existsSync(funCfgPath) ? loadFunConfigFromFile(funCfgPath) : null;
  const commandConfigs: FunCommandConfig[] = fileCommands ?? defaultFunCommands();
  const commands = compileCommands(commandConfigs);

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

      // If nothing matched, show a help message generated from configured commands
      const helpLines = ['*Fun commands:*'];
      for (const c of commands) {
        if (c.help) helpLines.push(`• ${c.help}`);
      }
      helpLines.push('', 'Example: @bot haiku spring in cape town');
      const post: any = {
        channel: ev.channel,
        text: helpLines.join('\n'),
      };
      if (replyThreadTs) post.thread_ts = replyThreadTs;
      await client.chat.postMessage(post);
    } catch (err) {
      logger?.error?.(err);
    }
  });
}