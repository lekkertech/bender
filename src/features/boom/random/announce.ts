import { makeDisplayNameResolver } from '../../../util/slack.js';
import type { Store } from '../store.js';
import { GAME_EMOJI, isFriday, neededGamesForDate, weekKeyFor, weekStartEnd, type Game } from '../rules.js';

export function makeAnnouncer(db: Store, announcing: Set<string>) {
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
  return { announceDay };
}
