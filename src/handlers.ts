import type { App } from '@slack/bolt';
import type { Config } from './env.js';
import { Store } from './store.js';
import { detectGameFromMessage, detectAnyGameEmoji, inNoonWindow, localDayInfo, isFriday, weekKeyFor, weekStartEnd, type Game } from './rules.js';

function inAllowedChannel(cfg: Config, channel?: string): boolean {
  if (!cfg.allowedChannels) return true;
  return channel ? cfg.allowedChannels.has(channel) : false;
}

const gameEmojiName: Record<Game, string> = {
  boom: 'boom',
  hadeda: 'hadeda-boom',
  wednesday: 'wednesday-boom',
};

export function registerHandlers(app: App, cfg: Config) {
  const db = new Store();

  // Listen to all messages and filter ourselves
  app.message(async ({ message, client, logger, body }) => {
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
      const position = db.addPlacement(date, game, m.user);
      if (position === 1) {
        // Optional: react with the game emoji for first place
        try {
          await client.reactions.add({ channel: m.channel, timestamp: tsStr, name: gameEmojiName[game] });
        } catch {}
      }

      // Daily announcement trigger: thresholds
      // neededGames already computed above
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
      console.error('handler error:', err);
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
        // Keep mention events visible in logs for non-command mentions
        logger?.debug?.({ channel: ev.channel, text: ev.text }, 'app_mention ignored (not leaderboard)');
        return;
      }

      // Derive local date from event timestamp, then compute ISO-week Mon–Fri range
      const tsStr = String(ev.ts || '0');
      const tsSeconds = Math.floor(Number(tsStr.split('.')[0] || '0'));
      const { date } = localDayInfo(tsSeconds);
      const { start, end } = weekStartEnd(date);

      // Compute totals and determine current king(s) (ties allowed)
      const leaderboard = db.weeklyTotals(start, end);
      const lines: string[] = [];
      lines.push('Boom Game — Leaderboard (week-to-date)');
      lines.push(`${start} to ${end}`);

      if (!leaderboard.length) {
        lines.push('No results yet this week.');
      } else {
        const top = leaderboard.slice(0, 10);
        let rank = 1;
        for (const row of top) {
          lines.push(`${rank}. <@${row.user_id}> — ${row.points} pt${row.points === 1 ? '' : 's'}`);
          rank++;
        }
        // Kings appended from last crowned week below.
      }

      // Append persisted king(s) from last crowned week (Friday after boom). Falls back to none.
      const crown = db.getLatestCrown();
      lines.push('');
      if (crown && crown.winners.length) {
        lines.push(`Current king${crown.winners.length > 1 ? 's' : ''}: ${crown.winners.map((u: string) => `<@${u}>`).join(', ')} — ${crown.points} pt${crown.points === 1 ? '' : 's'}`);
      } else {
        lines.push('Current king(s): none crowned yet');
      }
      // Respect default reply mode; prefer thread reply when configured
      const post: any = { channel: ev.channel, text: lines.join('\n') };
      if (cfg.defaultReplyMode === 'thread') {
        post.thread_ts = ev.thread_ts || ev.ts;
      }

      await client.chat.postMessage(post);
    } catch (err) {
      logger?.error(err);
    }
  });
}

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
