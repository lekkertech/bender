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
  isWorkdayDate,
  neededGamesForDate,
  noonWindowEndMs,
  weekKeyFor,
  weekStartEnd,
  PODIUM_WEIGHTS,
  GAME_EMOJI,
  type Game,
} from './rules.js';

const PODIUM_MEDALS = ['first_place_medal', 'second_place_medal', 'third_place_medal'] as const;

/** How often to look for a day whose noon window closed while the channel stayed quiet. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * How far back the closed-day sweep will reach. Bounded so deploying this fix cannot flood the
 * channel with podiums for days that stalled months ago.
 */
const ANNOUNCE_BACKFILL_DAYS = 2;

/**
 * Delay between a full house and the podium announcement. Slack delivers events out of ts order
 * (2026-08-31: a 3rd-by-ts entry arrived after the 4th had filled the podium), so announcing the
 * instant the podium fills can lock in the wrong bronze. The grace window lets stragglers land
 * and be re-ranked by ts before results go out.
 */
const DEFAULT_ANNOUNCE_GRACE_MS = 15_000;

function inAllowedChannel(cfg: Config, channel?: string): boolean {
  if (!cfg.allowedChannels) return true;
  return channel ? cfg.allowedChannels.has(channel) : false;
}

export function registerBoomFeature(app: App, cfg: Config) {
  const db = new Store();

  const announceGraceMs = Number(process.env.BOOM_ANNOUNCE_GRACE_MS ?? DEFAULT_ANNOUNCE_GRACE_MS);

  // Dates whose announcement is mid-flight, so a second message arriving during an await cannot
  // post the podium twice.
  const announcing = new Set<string>();

  // Pending grace timers per date, so a full house schedules exactly one announcement.
  const announceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Dates already told "Boom isn't played today", so a busy weekend gets one reply, not one per post.
  const notPlayedNotified = new Set<string>();

  /** Announce after the grace window, so out-of-order stragglers can still claim their place. */
  function scheduleAnnounce(client: any, date: string, channel: string, logger?: any) {
    if (announceGraceMs <= 0) return announceDay(client, date, channel);
    if (announceTimers.has(date)) return;
    const t = setTimeout(() => {
      announceTimers.delete(date);
      announceDay(client, date, channel).catch((err) => logger?.error?.(err));
    }, announceGraceMs);
    (t as any).unref?.();
    announceTimers.set(date, t);
  }

  /** Post a day's podium once. The first completed run marks the day announced. */
  async function announceDay(client: any, date: string, channel: string) {
    if (db.hasDailyAnnounced(date) || announcing.has(date)) return;
    announcing.add(date);
    try {
      await postDailyPodium(client, date, channel);
    } finally {
      announcing.delete(date);
    }
  }

  async function postDailyPodium(client: any, date: string, channel: string) {
    const neededGames = neededGamesForDate(date);
    // Render display names instead of <@id> mentions so listed users are not notified.
    const getName = makeDisplayNameResolver(client);
    const lines: string[] = [`Boom Game — Daily Podium (${date})`];

    for (const g of neededGames) {
      // A game can finish with fewer than three entrants; it still gets its podium line.
      const podiumMsgs = db.getPodiumMessages(date, g);
      if (!podiumMsgs.length) {
        lines.push(`• ${GAME_EMOJI[g]} — no entries`);
        continue;
      }
      const podiumLine = await Promise.all(
        podiumMsgs.map(async (pm, i) => `${i + 1}) ${await getName(pm.user_id)} +${PODIUM_WEIGHTS[i]}pt`),
      );
      lines.push(`• ${GAME_EMOJI[g]} ${podiumLine.join('  ')}`);
      // Apply medal reactions to the actual 1st/2nd/3rd messages by ts (deferred to settle
      // out-of-order delivery).
      for (let i = 0; i < podiumMsgs.length; i++) {
        const medal = PODIUM_MEDALS[i];
        const pm = podiumMsgs[i];
        if (!medal || !pm.channel_id || !pm.message_ts) continue;
        try {
          await client.reactions.add({ channel: pm.channel_id, timestamp: pm.message_ts, name: medal });
        } catch {}
      }
    }

    // Leaderboard (Mon–Fri of this week up to current date)
    const { start, end } = weekStartEnd(date);
    const leaderboard = db.weeklyTotals(start, end);
    if (leaderboard.length) {
      lines.push('');
      lines.push('Leaderboard (week-to-date):');
      let rank = 1;
      for (const row of leaderboard.slice(0, 10)) {
        lines.push(`${rank}. ${await getName(row.user_id)} — ${row.points} pt${row.points === 1 ? '' : 's'}`);
        rank++;
      }
    }

    await client.chat.postMessage({ channel, text: lines.join('\n') });
    db.markDailyAnnounced(date);

    // Friday crown: posted after the daily podium, using the same settled weeklyTotals.
    if (isFriday(date)) await postWeeklyCrown(client, date, channel, start, end);
  }

  /**
   * Crown state is written only after the crown message posts, so a failed post leaves the week
   * uncrowned and retryable rather than recording a king nobody was told about.
   */
  async function postWeeklyCrown(client: any, date: string, channel: string, start: string, end: string) {
    const wk = weekKeyFor(date);
    if (db.hasCrowned(wk)) return;
    const board = db.weeklyTotals(start, end);
    if (!board.length) return; // No results this week: leave it uncrowned rather than marking it.

    const topPoints = board[0].points;
    const winners = board.filter((r) => r.points === topPoints).map((r) => r.user_id);
    const crownLines = [
      `👑 Boom Game — Weekly Crown (${start} to ${end})`,
      `Winner${winners.length > 1 ? 's' : ''}: ${winners.map((u) => `<@${u}>`).join(', ')} — ${topPoints} pt${topPoints === 1 ? '' : 's'}`,
    ];
    await client.chat.postMessage({ channel, text: crownLines.join('\n') });
    db.setCrown(wk, winners, topPoints);
    db.markCrowned(wk);
  }

  /**
   * Announce any recent workday whose noon window has closed but was never announced, which
   * happens whenever a game finishes with fewer than three entrants. Without this the day's
   * podium and that week's crown stall forever.
   */
  async function announceClosedDays(client: any, logger?: any, nowMs = Date.now()) {
    const oldest = nowMs - ANNOUNCE_BACKFILL_DAYS * 24 * 60 * 60 * 1000;
    for (const date of db.recordedDates()) {
      if (db.hasDailyAnnounced(date)) continue;
      if (!isWorkdayDate(date)) continue;
      const closesAt = noonWindowEndMs(date);
      if (nowMs < closesAt || closesAt < oldest) continue;
      if (!db.hasAnyPlacement(date)) continue;
      const channel = db.channelForDate(date);
      if (!channel) {
        logger?.warn?.({ date }, '[boom] cannot announce daily podium: no channel recorded');
        continue;
      }
      try {
        await announceDay(client, date, channel);
      } catch (err) {
        logger?.error?.(err);
      }
    }
  }

  // Catch closed days even when the channel goes quiet. app.client is absent in unit-test
  // harnesses, where announceClosedDays is driven by incoming messages instead.
  const sweepClient = (app as any).client;
  if (sweepClient) {
    const sweep = setInterval(() => {
      announceClosedDays(sweepClient, (app as any).logger).catch(() => {});
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

      // Settle any day whose window closed short of a full podium.
      await announceClosedDays(client, logger);

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

      if (!inWindow) return;

      // Determine game by exact single-emoji message
      const game = detectGameFromMessage((m.text || ''), weekday);
      if (!game) return;

      // Once the day is announced, results are final: clown without recording.
      if (anyEmoji && db.hasDailyAnnounced(date)) {
        try {
          await client.reactions.add({ channel: m.channel, timestamp: tsStr, name: 'clown_face' });
        } catch {}
        return;
      }

      // Record BEFORE judging. Slack delivers events out of ts order, so a full-looking podium
      // may still owe a place to this message (2026-08-31: the true 3rd arrived after the 4th
      // and was clowned off the podium). The settled podium re-ranks by ts only over recorded
      // messages, so the recording must come first.
      // Position reactions (medals) are deferred to announce time so out-of-order WebSocket
      // delivery cannot mis-tag the winners.
      db.addPlacement(date, game, m.user, tsStr, m.channel);

      // Clown only a message that holds no place on the settled podium: a 4th-or-later unique
      // user. A podium user's re-post is not clowned; it simply doesn't score again.
      if (!db.getPlacements(date, game).includes(m.user)) {
        try {
          await client.reactions.add({ channel: m.channel, timestamp: tsStr, name: 'clown_face' });
        } catch {}
        return;
      }

      // Count this valid emoji occurrence
      db.incrementCount(date, game);

      // Full house: schedule the announcement after the grace window rather than waiting for the
      // window to close. Gate on SETTLED podium count (unique earliest-ts finishers), not the raw
      // running tally, which can reach 3 via re-posts before 3 unique finishers have settled.
      if (neededGames.every((g) => db.placementsCount(date, g) >= 3)) {
        await scheduleAnnounce(client, date, m.channel, logger);
      }
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

      // Settle any closed-but-unannounced day first so the leaderboard reflects today's results.
      await announceClosedDays(client, logger);

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
