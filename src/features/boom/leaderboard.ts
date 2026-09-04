import type { App } from '@slack/bolt';
import type { Config } from '../../env.js';
import { makeDisplayNameResolver, slackTsToSeconds } from '../../util/slack.js';
import type { Store } from './store.js';
import { localDayInfo, weekStartEnd } from './rules.js';

function inAllowedChannel(cfg: Config, channel?: string): boolean {
  if (!cfg.allowedChannels) return true;
  return channel ? cfg.allowedChannels.has(channel) : false;
}

export function registerLeaderboard(
  app: App,
  cfg: Config,
  db: Store,
  catchUp: (client: any, logger?: any) => Promise<void>,
) {
app.event('app_mention', async ({ event, client, logger }) => {
  try {
    const ev = event as any;
    if (!inAllowedChannel(cfg, ev.channel)) return;

    // Strip all mention tokens like <@U123ABC> and trim; trigger only on exact "leaderboard" (case-insensitive)
    const cleaned = String(ev.text || '').replace(/<@[^>]+>/g, '').trim();
    if (cleaned.toLowerCase() !== 'leaderboard') {
      // Only handle leaderboard here; other mention interactions are handled by the chat feature
      return;
    }

    // Derive local date from event timestamp, then compute ISO-week Mon–Fri range
    const tsStr = String(ev.ts || '0');
    const tsSeconds = slackTsToSeconds(tsStr);
    const { date } = localDayInfo(tsSeconds);
    const { start, end } = weekStartEnd(date);

    // Settle any closed-but-unresolved window first so the leaderboard reflects today's results.
    await catchUp(client, logger);

    // Compute week-to-date leaderboard and render nicely via Block Kit (reply in-channel, not thread)
    const leaderboard = db.weeklyTotals(start, end);

    // Resolve Slack display names to avoid notifying users (no <@...> mentions)
    const getName = makeDisplayNameResolver(client);

    // Fallback plain text for clients that don't render blocks
    const fallback: string[] = [];
    const title = 'Boom Game — Leaderboard (week-to-date)';
    const rangeText = `${start} to ${end}`;
    fallback.push(title);
    fallback.push(rangeText);

    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Boom Game — Leaderboard (week-to-date)', emoji: true },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*${start}* → *${end}*` }],
      },
      { type: 'divider' },
    ];

    // Helper for position label: medals for top 3, numeric emoji thereafter
    const posLabel = (i: number) => {
      if (i === 1) return ':first_place_medal:';
      if (i === 2) return ':second_place_medal:';
      if (i === 3) return ':third_place_medal:';
      const map: Record<number, string> = {
        4: ':four:',
        5: ':five:',
        6: ':six:',
        7: ':seven:',
        8: ':eight:',
        9: ':nine:',
        10: ':keycap_ten:',
      };
      return map[i] || `${i}.`;
    };

    if (!leaderboard.length) {
      const noData = 'No results yet this week.';
      fallback.push(noData);
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: noData },
      });
    } else {
      const top = leaderboard.slice(0, 10);
      const lines: string[] = await Promise.all(
        top.map(async (row, idx) => {
          const rank = idx + 1;
          const name = await getName(row.user_id);
          fallback.push(`${rank}. ${name} — ${row.points} pt${row.points === 1 ? '' : 's'}`);
          return `${posLabel(rank)} ${name} — *${row.points}* pt${row.points === 1 ? '' : 's'}`;
        }),
      );
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n') },
      });
    }

    // King(s) recomputed live from the most-recent completed ISO week (settled totals), not a stale snapshot.
    const crown = db.latestCompletedWeekWinner(date);
    blocks.push({ type: 'divider' });
    if (crown && crown.winners.length) {
      const kingNames = await Promise.all(crown.winners.map((u: string) => getName(u)));
      const kingsText = `:crown: Current king${kingNames.length > 1 ? 's' : ''}: ${kingNames.join(', ')}`;
      fallback.push('');
      fallback.push(kingsText.replace(':crown: ', ''));
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: kingsText }],
      });
    } else {
      const none = ':crown: Current king(s): none crowned yet';
      fallback.push('');
      fallback.push('Current king(s): none crowned yet');
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: none }],
      });
    }

    // Always post in-channel (no thread) for the leaderboard command
    const post: any = { channel: ev.channel, text: fallback.join('\n'), blocks };
    await client.chat.postMessage(post);
  } catch (err) {
    logger?.error(err);
  }
});
}
