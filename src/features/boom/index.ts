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

/** Slack rejects adding a reaction that is already present; for us that is success. */
function isAlreadyReacted(err: any): boolean {
  return err?.data?.error === 'already_reacted' || err?.message === 'already_reacted';
}

function inAllowedChannel(cfg: Config, channel?: string): boolean {
  if (!cfg.allowedChannels) return true;
  return channel ? cfg.allowedChannels.has(channel) : false;
}

export function registerBoomFeature(app: App, cfg: Config) {
  const db = new Store();

  // Pending tally windows: "<date>:<game>" -> the timer that will settle it, plus the settle time
  // it was scheduled for (an out-of-order earlier entry can move the deadline back).
  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; settlesAt: number }>();

  // Dates whose announcement is mid-flight, so a timer firing during an await cannot double-post.
  const announcing = new Set<string>();

  /** Schedule (or reschedule) the settling of a game's tally window. */
  function scheduleClose(client: any, date: string, game: Game, logger?: any) {
    const settlesAt = db.windowSettlesAtMs(date, game);
    if (settlesAt == null || db.isResolved(date, game) || !db.isRandomEra(date)) return;
    const key = `${date}:${game}`;
    const existing = timers.get(key);
    if (existing) {
      if (existing.settlesAt <= settlesAt) return; // Already scheduled at or before this deadline
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      timers.delete(key);
      closeGame(client, date, game, logger).catch((err) => logger?.error?.(err));
    }, Math.max(0, settlesAt - Date.now()));
    timer.unref?.();
    timers.set(key, { timer, settlesAt });
  }

  /** Assign points for a game whose window has closed, then announce the day if it is complete. */
  async function closeGame(client: any, date: string, game: Game, logger?: any) {
    const existing = timers.get(`${date}:${game}`);
    if (existing) {
      clearTimeout(existing.timer);
      timers.delete(`${date}:${game}`);
    }

    db.resolveGame(date, game);
    await applyMedals(client, date, game, logger);
    await announceDay(client, date, logger);
  }

  /**
   * Medal the three biggest point earners of a settled game, on their own entry messages.
   *
   * Marked done in the store only once every reaction has landed, because the awards are flushed
   * before these calls are made: a crash or a Slack failure in between would otherwise lose the
   * medals for good. Retried by the next catch-up until they stick.
   */
  async function applyMedals(client: any, date: string, game: Game, logger?: any) {
    if (db.hasMedalled(date, game)) return;
    const awards = db.getAwards(date, game);
    if (!awards.length) return;

    let failed = false;
    for (let i = 0; i < Math.min(PODIUM_MEDALS.length, awards.length); i++) {
      const medal = PODIUM_MEDALS[i];
      const a = awards[i];
      if (!medal || !a.channel_id || !a.message_ts) continue;
      try {
        await client.reactions.add({ channel: a.channel_id, timestamp: a.message_ts, name: medal });
      } catch (err) {
        // A medal already on the message is the outcome we wanted; anything else is a real failure.
        if (isAlreadyReacted(err)) continue;
        failed = true;
        logger?.warn?.({ date, game, medal, err }, '[boom] failed to apply medal reaction');
      }
    }
    if (!failed) db.markMedalled(date, game);
  }

  /**
   * Settle any window whose deadline has passed without its timer firing (bot restart, long
   * event-loop stall) and retry any announcement a failed Slack call lost. Channels come from the
   * stored entries, so no live message is needed.
   */
  async function catchUp(client: any, logger?: any) {
    // Snapshot before settling: games settled in this pass get their medals from closeGame, so
    // this list is only the ones orphaned by an earlier crash or Slack failure.
    const orphanedMedals = db.pendingMedals();

    for (const p of db.duePending()) {
      try {
        await closeGame(client, p.date, p.game, logger);
      } catch (err) {
        logger?.error?.(err);
      }
    }
    for (const p of orphanedMedals) {
      try {
        await applyMedals(client, p.date, p.game, logger);
      } catch (err) {
        logger?.error?.(err);
      }
    }
    // A day can be fully settled yet unannounced: awards are flushed before the post, so a
    // transient chat.postMessage failure would otherwise drop the results and crown for good.
    for (const date of db.pendingAnnouncements()) {
      try {
        await announceDay(client, date, logger);
      } catch (err) {
        logger?.error?.(err);
      }
    }
  }

  /**
   * Post the daily results + week-to-date leaderboard once every needed game has settled, then the
   * Friday crown. Each post is marked done only after Slack accepts it, so a failure leaves the
   * work outstanding for the next catch-up rather than silently skipping the day.
   */
  async function announceDay(client: any, date: string, logger?: any) {
    const neededGames = neededGamesForDate(date);
    if (!neededGames.every((g) => db.isResolved(date, g))) return;

    const weekKey = weekKeyFor(date);
    const owesResults = !db.hasDailyAnnounced(date);
    const owesCrown = isFriday(date) && !db.hasCrowned(weekKey);
    if ((!owesResults && !owesCrown) || announcing.has(date)) return;

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
      if (owesResults) {
        await postDailyResults(client, date, channel, neededGames);
        db.markDailyAnnounced(date);
      }
      // Crown after the daily results, using the same complete weeklyTotals.
      if (owesCrown) await postWeeklyCrown(client, date, channel);
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
  }

  async function postWeeklyCrown(client: any, date: string, channel: string) {
    const wk = weekKeyFor(date);
    const { start, end } = weekStartEnd(date);
    const board = db.weeklyTotals(start, end);
    if (board.length) {
      const topPoints = board[0].points;
      const winners = board.filter((r) => r.points === topPoints).map((r) => r.user_id);
      const crownLines = [
        `👑 Boom Game — Weekly Crown (${start} to ${end})`,
        `Winner${winners.length > 1 ? 's' : ''}: ${winners.map((u) => `<@${u}>`).join(', ')} — ${topPoints} pt${topPoints === 1 ? '' : 's'}`,
      ];
      // Persist only after Slack accepts the post, so a failure leaves no record of a crown
      // nobody saw — the next catch-up retries it.
      await client.chat.postMessage({ channel, text: crownLines.join('\n') });
      db.setCrown(wk, winners, topPoints);
    }
    db.markCrowned(wk);
  }

  // Recover windows abandoned by a restart, and retry lost announcements, even if the channel goes
  // quiet. app.client is absent in unit-test harnesses, where catchUp is driven by incoming
  // messages instead. app.logger is passed through: this is the path most likely to hit a missing
  // channel or a Slack failure, so it must not fail silently.
  const sweepClient = (app as any).client;
  const sweepLogger = (app as any).logger;
  if (sweepClient) {
    const sweep = setInterval(() => {
      catchUp(sweepClient, sweepLogger).catch((err) => sweepLogger?.error?.(err));
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

      // Settle any window whose deadline passed while no timer was live (e.g. after a restart) and
      // retry any announcement that was lost to a failed Slack call.
      await catchUp(client, logger);

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

      const clown = async () => {
        try {
          await client.reactions.add({ channel: m.channel, timestamp: tsStr, name: 'clown_face' });
        } catch {}
      };

      // Clown any game emoji posted after its own tally window has closed or once every game for
      // the day has settled. Lateness is judged on the message's own ts (full sub-second
      // precision), and settling is deferred by ENTRY_GRACE_MS, so a message sent inside the
      // window but delivered a moment late is still accepted rather than clowned.
      const closesAt = anyEmoji ? db.windowClosesAtMs(date, anyEmoji) : null;
      // floor(), not round(): rounding up would push a ts in the final half-millisecond of the
      // noon window past the clamped close and clown a message that was sent in time.
      const tsMs = Math.floor(Number(tsStr) * 1000);
      const tooLate = closesAt != null && Number.isFinite(tsMs) && tsMs > closesAt;
      const gameClosed = anyEmoji ? db.isResolved(date, anyEmoji) || tooLate : false;
      const dayClosed = neededGames.every((g) => db.isResolved(date, g));
      if (anyEmoji && (!inWindow || gameClosed || dayClosed)) {
        await clown();
        return;
      }
      if (!inWindow) return;

      // Determine game by exact single-emoji message
      const game = detectGameFromMessage((m.text || ''), weekday);
      if (!game) return;

      // Record the entry and bump the raw tally in one atomic store call, so concurrently
      // delivered messages from the same user cannot both be counted. The Slack message ts is
      // stored, anchoring the tally window to the earliest entry rather than arrival order.
      const outcome = db.addEntry(date, game, m.user, tsStr, m.channel);
      // A redelivery of the already-recorded message is a Slack retry, not a repeat post.
      if (outcome === 'redelivery') return;
      // One entry per user per game: repeats are ignored entirely, not even counted.
      if (outcome === 'duplicate') {
        await clown();
        return;
      }

      // The first entry opens a tally window; every unique entrant inside it draws a unique random
      // point value in 1..n when it settles. Medals and the daily announcement follow from there.
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
