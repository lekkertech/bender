import type { App } from '@slack/bolt';
import type { Config } from '../../env.js';
import { makeDisplayNameResolver, slackTsToSeconds } from '../../util/slack.js';
import { Store } from './store.js';
import {
  detectGameFromMessage,
  detectAnyGameEmoji,
  inNoonWindow,
  localDayInfo,
  isFriday,
  neededGamesForDate,
  weekKeyFor,
  weekStartEnd,
  GAME_EMOJI,
  type Game,
} from './rules.js';

const PODIUM_MEDALS = ['first_place_medal', 'second_place_medal', 'third_place_medal'] as const;

/** Reaction confirming an entry was accepted into the tally. */
const ACK_REACTION = 'white_check_mark';

/** How often to sweep for tally windows whose timers were lost to a restart. */
const SWEEP_INTERVAL_MS = 30 * 1000;

function inAllowedChannel(cfg: Config, channel?: string): boolean {
  if (!cfg.allowedChannels) return true;
  return channel ? cfg.allowedChannels.has(channel) : false;
}

export function registerBoomFeature(app: App, cfg: Config) {
  const db = new Store();

  // Pending tally windows: "<date>:<game>" -> the timer that will close it, plus the close time
  // it was scheduled for (an out-of-order earlier entry can move the deadline back).
  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; closesAt: number }>();

  // Dates whose announcement is mid-flight, so a timer firing during an await cannot double-post.
  const announcing = new Set<string>();

  /** Schedule (or reschedule) the close of a game's 5-minute tally window. */
  function scheduleClose(client: any, date: string, game: Game, logger?: any) {
    const closesAt = db.windowClosesAtMs(date, game);
    if (closesAt == null || db.isResolved(date, game)) return;
    const key = `${date}:${game}`;
    const existing = timers.get(key);
    if (existing) {
      if (existing.closesAt <= closesAt) return; // Already scheduled at or before this deadline
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      timers.delete(key);
      closeGame(client, date, game, logger).catch((err) => logger?.error?.(err));
    }, Math.max(0, closesAt - Date.now()));
    timer.unref?.();
    timers.set(key, { timer, closesAt });
  }

  /** Assign points for a game whose window has closed, then announce the day if it is complete. */
  async function closeGame(client: any, date: string, game: Game, logger?: any) {
    const existing = timers.get(`${date}:${game}`);
    if (existing) {
      clearTimeout(existing.timer);
      timers.delete(`${date}:${game}`);
    }

    const alreadySettled = db.isResolved(date, game);
    const awards = db.resolveGame(date, game);

    // Medals go to the three biggest point earners, applied to their entry messages. Skipped when
    // the game was already settled, so repeat calls never re-react.
    if (!alreadySettled) {
      for (let i = 0; i < Math.min(PODIUM_MEDALS.length, awards.length); i++) {
        const medal = PODIUM_MEDALS[i];
        const a = awards[i];
        if (!medal || !a.channel_id || !a.message_ts) continue;
        try {
          await client.reactions.add({ channel: a.channel_id, timestamp: a.message_ts, name: medal });
        } catch {}
      }
    }

    await announceDay(client, date, logger);
  }

  /**
   * Close any window whose deadline has passed without its timer firing (bot restart, long
   * event-loop stall). Channels come from the stored entries, so no live message is needed.
   */
  async function closeDueWindows(client: any, logger?: any) {
    for (const p of db.duePending()) {
      try {
        await closeGame(client, p.date, p.game, logger);
      } catch (err) {
        logger?.error?.(err);
      }
    }
  }

  /** Post the daily results + week-to-date leaderboard once every needed game has settled. */
  async function announceDay(client: any, date: string, logger?: any) {
    const neededGames = neededGamesForDate(date);
    if (!neededGames.every((g) => db.isResolved(date, g))) return;
    if (db.hasDailyAnnounced(date) || announcing.has(date)) return;

    // Announce in the channel the day's earliest entry came from.
    const channel = neededGames
      .map((g) => db.entrants(date, g).find((e) => e.channel_id)?.channel_id)
      .find(Boolean);
    if (!channel) {
      logger?.warn?.({ date }, '[boom] cannot announce daily results: no channel recorded');
      return;
    }

    announcing.add(date);
    try {
      await postDailyResults(client, date, channel, neededGames);
    } finally {
      announcing.delete(date);
    }
  }

  async function postDailyResults(client: any, date: string, channel: string, neededGames: Game[]) {
    // Render display names instead of <@id> mentions so listed users are not notified.
    const getName = makeDisplayNameResolver(client);
    const lines: string[] = [];
    lines.push(`Boom Game — Daily Podium (${date})`);
    for (const g of neededGames) {
      const awards = db.getAwards(date, g);
      if (!awards.length) {
        lines.push(`• ${GAME_EMOJI[g]} — no entries`);
        continue;
      }
      const rendered = await Promise.all(
        awards.map(async (a, i) => `${i + 1}) ${await getName(a.user_id)} +${a.points}pt`),
      );
      lines.push(`• ${GAME_EMOJI[g]} ${rendered.join('  ')}`);
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
        lines.push(`${rank}. ${await getName(row.user_id)} — ${row.points} pt${row.points === 1 ? '' : 's'}`);
        rank++;
      }
    }

    await client.chat.postMessage({ channel, text: lines.join('\n') });
    db.markDailyAnnounced(date);

    // Friday crown: only once every Friday game has settled, so the crown uses the same complete
    // weeklyTotals as the results above. Posted after the daily results message.
    if (isFriday(date)) {
      const wk = weekKeyFor(date);
      if (!db.hasCrowned(wk)) {
        const board = db.weeklyTotals(start, end);
        if (board.length) {
          const topPoints = board[0].points;
          const winners = board.filter((r) => r.points === topPoints).map((r) => r.user_id);
          db.setCrown(wk, winners, topPoints);
          const crownLines = [
            `👑 Boom Game — Weekly Crown (${start} to ${end})`,
            `Winner${winners.length > 1 ? 's' : ''}: ${winners.map((u) => `<@${u}>`).join(', ')} — ${topPoints} pt${topPoints === 1 ? '' : 's'}`,
          ];
          await client.chat.postMessage({ channel, text: crownLines.join('\n') });
        }
        db.markCrowned(wk);
      }
    }
  }

  // Recover windows abandoned by a restart even if the channel goes quiet. app.client is absent
  // in unit-test harnesses, where closeDueWindows is driven by incoming messages instead.
  const sweepClient = (app as any).client;
  if (sweepClient) {
    const sweep = setInterval(() => {
      closeDueWindows(sweepClient).catch(() => {});
    }, SWEEP_INTERVAL_MS);
    sweep.unref?.();
  }

  // Listen to all messages and filter ourselves
  app.message(async ({ message, client, logger }) => {
    try {
      const m = message as any;
      if (!m || m.subtype || !m.user) return; // Ignore bot/system/edited messages
      if (m.thread_ts && m.thread_ts !== m.ts) return; // Ignore thread replies; only top-level posts count
      if (!inAllowedChannel(cfg, m.channel)) return;

      // Timestamp handling
      const tsStr = String(m.ts || '0');
      const tsSeconds = slackTsToSeconds(tsStr);
      const { date, weekday, isWorkday, isHoliday } = localDayInfo(tsSeconds);
      const inWindow = inNoonWindow(tsSeconds);
      const neededGames = neededGamesForDate(date);

      // Settle any window whose deadline passed while no timer was live (e.g. after a restart).
      await closeDueWindows(client, logger);

      // If a game emoji is posted outside the window, add a clown reaction.
      // (Do this before any store reads/writes so we never mutate state on non-workdays.)
      const anyEmoji = detectAnyGameEmoji(m.text || '');
      if (anyEmoji && !inWindow) {
        try {
          await client.reactions.add({ channel: m.channel, timestamp: tsStr, name: 'clown_face' });
        } catch {}
        return;
      }

      // Boom Game is only played on workdays; on weekends/holidays, explicitly tell users.
      if (!isWorkday) {
        if (anyEmoji && inWindow) {
          const reason = isHoliday ? "it's a holiday" : 'it\'s the weekend';
          await client.chat.postMessage({ channel: m.channel, text: `Boom isn't played today — ${reason}.` });
        }
        return;
      }

      // Clown any game emoji posted outside the window, after its own tally window has closed,
      // once every game for the day has settled, or when the user already has an entry.
      const closesAt = anyEmoji ? db.windowClosesAtMs(date, anyEmoji) : null;
      // Compare on the message's own ts (full sub-second precision) so a slow delivery of a
      // message that was sent inside the window still counts.
      const tsMs = Math.round(Number(tsStr) * 1000);
      const tooLate = closesAt != null && Number.isFinite(tsMs) && tsMs > closesAt;
      const gameClosed = anyEmoji ? db.isResolved(date, anyEmoji) || tooLate : false;
      const dayClosed = neededGames.every((g) => db.isResolved(date, g));
      // One entry per user per game: repeats are ignored entirely, not even counted. A redelivery
      // of the already-recorded message is a Slack retry, not a repeat post — drop it silently.
      const priorEntry = anyEmoji ? db.entryFor(date, anyEmoji, m.user) : null;
      if (priorEntry && priorEntry.message_ts === tsStr) return;
      const duplicate = priorEntry != null;
      if (anyEmoji && (!inWindow || gameClosed || dayClosed || duplicate)) {
        try {
          await client.reactions.add({ channel: m.channel, timestamp: tsStr, name: 'clown_face' });
        } catch {}
        return;
      }
      if (!inWindow) return;

      // Determine game by exact single-emoji message
      const game = detectGameFromMessage((m.text || ''), weekday);
      if (!game) return;

      // Count this valid emoji occurrence. Repeats were clowned above, so counts track entrants.
      db.incrementCount(date, game);

      // Record the entry. Pass the Slack message timestamp so the tally window is anchored to the
      // earliest entry rather than WebSocket arrival order.
      db.addPlacement(date, game, m.user, tsStr, m.channel);

      // The first entry opens a tally window; every unique entrant inside it draws a unique random
      // point value in 1..n when it closes. Medals and the daily announcement follow from there.
      scheduleClose(client, date, game, logger);

      // Acknowledge the accepted entry so the player knows they are in the tally.
      try {
        await client.reactions.add({ channel: m.channel, timestamp: tsStr, name: ACK_REACTION });
      } catch {}
    } catch (err) {
      logger?.error?.(err);
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
      const tsSeconds = slackTsToSeconds(tsStr);
      const { date } = localDayInfo(tsSeconds);
      const { start, end } = weekStartEnd(date);

      // Settle any closed-but-unresolved window first so the leaderboard reflects today's results.
      await closeDueWindows(client, logger);

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
