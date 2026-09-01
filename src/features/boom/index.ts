import type { App } from '@slack/bolt';
import type { Config } from '../../env.js';
import { makeDisplayNameResolver, slackTsToSeconds } from '../../util/slack.js';
import { Store } from './store.js';
import {
  detectGameFromMessage,
  detectAnyGameEmoji,
  inEntryWindow,
  localDayInfo,
  isFriday,
  neededGamesForDate,
  windowSettlesAtMs,
  GAMES,
  weekKeyFor,
  weekStartEnd,
  GAME_EMOJI,
  type Game,
} from './rules.js';

const PODIUM_MEDALS = ['first_place_medal', 'second_place_medal', 'third_place_medal'] as const;

/** Reaction confirming an entry was accepted into the tally. */
const ACK_REACTION = 'white_check_mark';

/** How often to sweep for entry windows whose timers were lost to a restart. */
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

  // Pending settle timers, one per date. The window is fixed at 12:00-12:05 local, so every game
  // for a date settles at the same instant and the deadline never moves.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  // Dates whose announcement is mid-flight, so a timer firing during an await cannot double-post.
  const announcing = new Set<string>();

  // Dates already told "Boom isn't played today", so a busy weekend gets one reply, not one per post.
  const notPlayedNotified = new Set<string>();

  /** Schedule the settling of a date's entry window. One timer per date; the deadline is fixed. */
  function scheduleSettle(client: any, date: string, logger?: any) {
    if (timers.has(date) || !db.isRandomEra(date) || db.hasDailyAnnounced(date)) return;
    const timer = setTimeout(() => {
      timers.delete(date);
      settleDay(client, date, logger).catch((err) => logger?.error?.(err));
    }, Math.max(0, windowSettlesAtMs(date) - Date.now()));
    timer.unref?.();
    timers.set(date, timer);
  }

  /**
   * Assign points for every game of a date whose window has closed, then announce the day.
   * Needed games nobody entered settle empty here too, so the day never stalls on an unplayed one.
   */
  async function settleDay(client: any, date: string, logger?: any) {
    const timer = timers.get(date);
    if (timer) {
      clearTimeout(timer);
      timers.delete(date);
    }
    for (const game of new Set([...neededGamesForDate(date), ...GAMES.filter((g) => db.entrants(date, g).length)])) {
      await closeGame(client, date, game, logger);
    }
    await announceDay(client, date, logger);
  }

  /** Assign points for one game whose window has closed, and medal its top earners. */
  async function closeGame(client: any, date: string, game: Game, logger?: any) {
    db.resolveGame(date, game);
    await applyMedals(client, date, game, logger);
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

    const settledDates = new Set<string>();
    for (const p of db.duePending()) {
      try {
        await closeGame(client, p.date, p.game, logger);
        settledDates.add(p.date);
      } catch (err) {
        logger?.error?.(err);
      }
    }
    for (const date of settledDates) {
      try {
        await announceDay(client, date, logger);
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
    // A day older than the retry window stays settled but silent. Posting a three-week-old podium
    // into the channel — as a restart or a late catch-up could — is worse than never posting it.
    if (!db.isWithinRetryWindow(date)) return;

    const weekKey = weekKeyFor(date);
    const owesResults = !db.hasDailyAnnounced(date);
    const owesCrown = isFriday(date) && !db.hasCrowned(weekKey);
    if ((!owesResults && !owesCrown) || announcing.has(date)) return;

    // Announce in the channel the day's earliest entry came from.
    const channel = db.channelForDate(date);
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
      const inWindow = inEntryWindow(tsSeconds);
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
        // One notice per date, so a busy weekend does not get a reply per poster.
        if (anyEmoji && inWindow && !notPlayedNotified.has(date)) {
          notPlayedNotified.add(date);
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

      // An emoji sent outside the window was already clowned above, on its ts alone. What is left
      // is an in-window message that arrived after its game (or the whole day) had settled: the
      // grace period has passed and the points are assigned, so it cannot be taken.
      if (anyEmoji && (db.isResolved(date, anyEmoji) || neededGames.every((g) => db.isResolved(date, g)))) {
        await clown();
        return;
      }

      // Determine game by exact single-emoji message
      const game = detectGameFromMessage((m.text || ''), weekday);
      if (!game) return;

      // Record the entry and bump the raw tally in one atomic store call, so concurrently
      // delivered messages from the same user cannot both be counted.
      const outcome = db.addEntry(date, game, m.user, tsStr, m.channel);
      // A redelivery of the already-recorded message is a Slack retry, not a repeat post.
      if (outcome === 'redelivery') return;
      // One entry per user per game: repeats are ignored entirely, not even counted.
      if (outcome === 'duplicate') {
        await clown();
        return;
      }

      // The window is already open (12:00 local); this just makes sure something is scheduled to
      // close it. Every unique entrant inside it draws a unique random point value in 1..n when
      // it settles. Medals and the daily announcement follow from there.
      scheduleSettle(client, date, logger);

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
