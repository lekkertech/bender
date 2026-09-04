import type { App } from '@slack/bolt';
import type { Config } from '../../env.js';
import { makeDisplayNameResolver, slackTsToSeconds } from '../../util/slack.js';
import type { Store } from './store.js';
import { localDayInfo, weekStartEnd } from './rules.js';

const TITLE = 'Boom Game — Leaderboard (week-to-date)';
const EMPTY_TEXT = 'No results yet this week.';
const NO_CROWN_TEXT = 'Current king(s): none crowned yet';

const RANK_LABELS: Record<number, string> = {
  1: ':first_place_medal:',
  2: ':second_place_medal:',
  3: ':third_place_medal:',
  4: ':four:',
  5: ':five:',
  6: ':six:',
  7: ':seven:',
  8: ':eight:',
  9: ':nine:',
  10: ':keycap_ten:',
};

type NameResolver = (userId: string) => Promise<string>;
type WeeklyRow = { user_id: string; points: number };
type CompletedWeek = { winners: string[] } | null;
type Rendered = { block: any; fallback: string[] };
type CatchUp = (client: any, logger?: any) => Promise<void>;
type MentionContext = { event: any; client: any; logger?: any };

function inAllowedChannel(cfg: Config, channel?: string): boolean {
  if (!cfg.allowedChannels) return true;
  return channel ? cfg.allowedChannels.has(channel) : false;
}

function rankLabel(rank: number): string {
  return RANK_LABELS[rank] || `${rank}.`;
}

function pointsUnit(points: number): string {
  return `pt${points === 1 ? '' : 's'}`;
}

function mrkdwnSection(text: string): any {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function mrkdwnContext(text: string): any {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function headerBlocks(start: string, end: string): any[] {
  return [
    { type: 'header', text: { type: 'plain_text', text: TITLE, emoji: true } },
    mrkdwnContext(`*${start}* → *${end}*`),
    { type: 'divider' },
  ];
}

async function leaderboardSection(rows: WeeklyRow[], getName: NameResolver): Promise<Rendered> {
  if (!rows.length) {
    return { block: mrkdwnSection(EMPTY_TEXT), fallback: [EMPTY_TEXT] };
  }
  const fallback: string[] = [];
  const lines = await Promise.all(
    rows.slice(0, 10).map(async (row, idx) => {
      const rank = idx + 1;
      const name = await getName(row.user_id);
      const unit = pointsUnit(row.points);
      fallback.push(`${rank}. ${name} — ${row.points} ${unit}`);
      return `${rankLabel(rank)} ${name} — *${row.points}* ${unit}`;
    }),
  );
  return { block: mrkdwnSection(lines.join('\n')), fallback };
}

async function crownContext(crown: CompletedWeek, getName: NameResolver): Promise<Rendered> {
  if (!crown || !crown.winners.length) {
    return { block: mrkdwnContext(`:crown: ${NO_CROWN_TEXT}`), fallback: [NO_CROWN_TEXT] };
  }
  const names = await Promise.all(crown.winners.map((u: string) => getName(u)));
  const text = `Current king${names.length > 1 ? 's' : ''}: ${names.join(', ')}`;
  return { block: mrkdwnContext(`:crown: ${text}`), fallback: [text] };
}

function leaderboardTrigger(text: unknown): boolean {
  return String(text || '').replace(/<@[^>]+>/g, '').trim().toLowerCase() === 'leaderboard';
}

async function handleMention(cfg: Config, db: Store, catchUp: CatchUp, ctx: MentionContext) {
  const ev = ctx.event;
  if (!inAllowedChannel(cfg, ev.channel)) return;
  if (!leaderboardTrigger(ev.text)) return;

  const { date } = localDayInfo(slackTsToSeconds(String(ev.ts || '0')));
  const { start, end } = weekStartEnd(date);
  await catchUp(ctx.client, ctx.logger);

  const getName = makeDisplayNameResolver(ctx.client);
  const body = await leaderboardSection(db.weeklyTotals(start, end), getName);
  const crown = await crownContext(db.latestCompletedWeekWinner(date), getName);

  const blocks = [...headerBlocks(start, end), body.block, { type: 'divider' }, crown.block];
  const fallback = [TITLE, `${start} to ${end}`, ...body.fallback, '', ...crown.fallback];
  const post: any = { channel: ev.channel, text: fallback.join('\n'), blocks };
  await ctx.client.chat.postMessage(post);
}

export function registerLeaderboard(app: App, cfg: Config, db: Store, catchUp: CatchUp) {
  app.event('app_mention', async ({ event, client, logger }) => {
    try {
      await handleMention(cfg, db, catchUp, { event, client, logger });
    } catch (err) {
      logger?.error(err);
    }
  });
}
