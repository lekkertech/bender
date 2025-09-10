import type { App } from '@slack/bolt';
import type { Config } from '../../env.js';
import { Store } from './store.js';
import {
  detectGameFromMessage,
  detectAnyGameEmoji,
  inNoonWindow,
  localDayInfo,
  isFriday,
  weekKeyFor,
  weekStartEnd,
  type Game,
} from './rules.js';

function inAllowedChannel(cfg: Config, channel?: string): boolean {
  if (!cfg.allowedChannels) return true;
  return channel ? cfg.allowedChannels.has(channel) : false;
}

const gameEmojiName: Record<Game, string> = {
  boom: 'boom',
  hadeda: 'hadeda-boom',
  wednesday: 'wednesday-boom',
};

function emojiFor(g: Game): string {
  switch (g) {
    case 'boom':
      return ':boom:';
    case 'hadeda':
      return ':hadeda-boom:';
    case 'wednesday':
      return ':wednesday-boom:';
  }
}

export function registerBoomFeature(app: App, cfg: Config) {
  const db = new Store();

  // Listen to all messages and filter ourselves
  app.message(async ({ message, client, logger }) => {
    try {
      const m = message as any;
      if (!m || m.subtype || !m.user) return; // Ignore bot/system/edited messages
      if (!inAllowedChannel(cfg, m.channel)) return;

      // Timestamp handling
      const tsStr = String(m.ts || '0');
      const tsSeconds = Math.floor(Number(tsStr.split('.')[0] || '0'));
      const { date, weekday, isWorkday } = localDayInfo(tsSeconds);
      const inWindow = inNoonWindow(tsSeconds);
      const neededGames: Game[] = weekday === 3 ? ['boom', 'hadeda', 'wednesday'] : ['boom', 'hadeda'];

      // If a game emoji is posted outside the window, or the competition is already closed (podiums decided), add a clown reaction
      const anyEmoji = detectAnyGameEmoji(m.text || '');
      const gameClosed = anyEmoji ? (db.placementsCount(date, anyEmoji) >= 3) : false;
      const dayClosed = neededGames.every((g) => db.placementsCount(date, g) >= 3);
      if (anyEmoji && (!inWindow || gameClosed || dayClosed)) {
        try {
          await client.reactions.add({ channel: m.channel, timestamp: tsStr, name: 'clown_face' });
        } catch {}
        return;
      }

      if (!isWorkday) return;
      if (!inWindow) return;

      // Determine game by exact single-emoji message
      const game = detectGameFromMessage((m.text || ''), weekday);
      if (!game) return;

      // Count this valid emoji occurrence
      const count = db.incrementCount(date, game);

      // Podium placements 1st/2nd/3rd (unique users). After 3, further posts are clowned above.
      // Pass Slack message timestamp so placements are decided by earliest ts, not arrival order.
      const position = db.addPlacement(date, game, m.user, tsStr, m.channel);
      if (position === 1) {
        // Optional: react with the game emoji for first place
        try {
          await client.reactions.add({ channel: m.channel, timestamp: tsStr, name: gameEmojiName[game] });
        } catch {}
      }

      // Daily announcement trigger: thresholds
      const counts = db.getCounts(date);
      const ready = neededGames.every((g) => (counts[g] || 0) >= 3);
      if (ready && !db.hasDailyAnnounced(date)) {
        const lines: string[] = [];
        lines.push(`Boom Game — Daily Podium (${date})`);
        const weights = [5, 3, 1];
        for (const g of neededGames) {
          const arr = db.getPlacements(date, g);
          if (!arr.length) {
            lines.push(`• ${emojiFor(g)} — no podium yet`);
            continue;
          }
          const podium = arr.slice(0, 3).map((u, i) => `${i + 1}) <@${u}> +${weights[i]}pt`);
          lines.push(`• ${emojiFor(g)} ${podium.join('  ')}`);
        }

        // Leaderboard (Mon–Fri of this week up to current date)
        const { start, end } = weekStartEnd(date);
        const leaderboard = db.weeklyTotals(start, end);
        if (leaderboard.length) {
          lines.push('');
          lines.push('Leaderboard (week-to-date):');
          const top = leaderboard.slice(0, 10);
          let rank = 1;
          for (const row of top) {
            lines.push(`${rank}. <@${row.user_id}> — ${row.points} pt${row.points === 1 ? '' : 's'}`);
            rank++;
          }
        }

        await client.chat.postMessage({ channel: m.channel, text: lines.join('\n') });
        db.markDailyAnnounced(date);
      }

      // Friday crown: immediately after Friday boom winner recorded
      if (game === 'boom' && isFriday(date)) {
        const wk = weekKeyFor(date);
        if (!db.hasCrowned(wk)) {
          const { start, end } = weekStartEnd(date);
          const leaderboard = db.weeklyTotals(start, end);
          if (leaderboard.length) {
            const topPoints = leaderboard[0].points;
            const winners = leaderboard.filter((r) => r.points === topPoints).map((r) => r.user_id);
            // Persist crowned winners for this week (king definition: top after Friday boom)
            db.setCrown(wk, winners, topPoints);
            const crownLines = [
              `👑 Boom Game — Weekly Crown (${start} to ${end})`,
              `Winner${winners.length > 1 ? 's' : ''}: ${winners.map((u) => `<@${u}>`).join(', ')} — ${topPoints} pt${topPoints === 1 ? '' : 's'}`,
            ];
            await client.chat.postMessage({ channel: m.channel, text: crownLines.join('\n') });
          }
          db.markCrowned(wk);
        }
      }
    } catch (err) {
      console.error('boom feature handler error:', err);
    }
  });

  // Mention command: "@bot leaderboard" → print week-to-date leaderboard + current king(s)
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
      const tsSeconds = Math.floor(Number(tsStr.split('.')[0] || '0'));
      const { date } = localDayInfo(tsSeconds);
      const { start, end } = weekStartEnd(date);

      // Compute week-to-date leaderboard and render nicely via Block Kit (reply in-channel, not thread)
      const leaderboard = db.weeklyTotals(start, end);

      // Resolve Slack display names to avoid notifying users (no <@...> mentions)
      const nameCache = new Map<string, string>();
      const getDisplayName = async (uid: string): Promise<string> => {
        if (nameCache.has(uid)) return nameCache.get(uid)!;
        try {
          const info = await client.users.info({ user: uid });
          const user = (info as any)?.user;
          const profile = user?.profile || {};
          const name: string =
            (profile.display_name && String(profile.display_name).trim()) ||
            (profile.real_name && String(profile.real_name).trim()) ||
            (user?.name ? String(user.name) : uid);
          nameCache.set(uid, name);
          return name;
        } catch {
          return uid;
        }
      };

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
            const name = await getDisplayName(row.user_id);
            fallback.push(`${rank}. ${name} — ${row.points} pt${row.points === 1 ? '' : 's'}`);
            return `${posLabel(rank)} ${name} — *${row.points}* pt${row.points === 1 ? '' : 's'}`;
          }),
        );
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: lines.join('\n') },
        });
      }

      // Append persisted king(s) from last crowned week (Friday after boom). Falls back to none.
      const crown = db.getLatestCrown();
      blocks.push({ type: 'divider' });
      if (crown && crown.winners.length) {
        const kingNames = await Promise.all(crown.winners.map((u: string) => getDisplayName(u)));
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