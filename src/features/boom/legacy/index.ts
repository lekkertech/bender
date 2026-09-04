import type { App } from '@slack/bolt';
import type { Config } from '../../../env.js';
import { makeDisplayNameResolver, slackTsToSeconds } from '../../../util/slack.js';
import type { Store } from '../store.js';
import { registerLeaderboard } from '../leaderboard.js';
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
} from '../rules.js';

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

export function registerLegacyBoom(app: App, cfg: Config, db: Store) {

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
      db.addPlacement(date, game, m.user, { ts: tsStr, channel_id: m.channel });

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
  registerLeaderboard(app, cfg, db, announceClosedDays);
}
