import { makeDisplayNameResolver } from '../../../util/slack.js';
import type { Store } from '../store.js';
import { GAME_EMOJI, isFriday, neededGamesForDate, weekKeyFor, weekStartEnd, type Game } from '../rules.js';
import { pointsUnit, type NameResolver, type WeeklyRow } from '../leaderboard.js';
import type { Io, Settler } from './settle.js';

type Week = { start: string; end: string; board: WeeklyRow[] };
type DayTarget = { date: string; channel: string; neededGames: Game[]; week: Week };
type Owed = { results: boolean; crown: boolean };

function owedFor(db: Store, date: string): Owed {
  return {
    results: !db.hasDailyAnnounced(date),
    crown: isFriday(date) && !db.hasCrowned(weekKeyFor(date)),
  };
}

function weekFor(db: Store, date: string): Week {
  const { start, end } = weekStartEnd(date);
  return { start, end, board: db.weeklyTotals(start, end) };
}

export async function announceDay(s: Settler, io: Io, date: string) {
  const neededGames = neededGamesForDate(date);
  if (!neededGames.every((g) => s.db.isResolved(date, g)) || !s.db.isWithinRetryWindow(date)) return;
  const owed = owedFor(s.db, date);
  if ((!owed.results && !owed.crown) || s.announcing.has(date)) return;

  const channel = s.db.channelForDate(date);
  if (!channel) {
    io.logger?.warn?.({ date }, '[boom] cannot announce daily results: no channel recorded');
    return;
  }

  s.announcing.add(date);
  try {
    const week = weekFor(s.db, date);
    await postOwed(s.db, io.client, { date, channel, neededGames, week }, owed);
  } finally {
    s.announcing.delete(date);
  }
}

async function postOwed(db: Store, client: any, target: DayTarget, owed: Owed) {
  if (owed.results) {
    await postDailyResults(db, client, target);
    db.markDailyAnnounced(target.date);
  }
  if (owed.crown) await postWeeklyCrown(db, client, target);
}

async function postDailyResults(db: Store, client: any, target: DayTarget) {
  const getName = makeDisplayNameResolver(client);
  const lines = [`Boom Game — Daily Podium (${target.date})`];
  for (const game of target.neededGames) {
    lines.push(await podiumLine(db, getName, target.date, game));
  }
  lines.push(...(await leaderboardLines(getName, target.week)));
  await client.chat.postMessage({ channel: target.channel, text: lines.join('\n') });
}

async function podiumLine(db: Store, getName: NameResolver, date: string, game: Game): Promise<string> {
  const awards = db.getAwards(date, game);
  if (!awards.length) return `• ${GAME_EMOJI[game]} — no entries`;
  const rendered = await Promise.all(
    awards.map(async (a, i) => `${i + 1}) ${await getName(a.user_id)} +${a.points}pt`),
  );
  return `• ${GAME_EMOJI[game]} ${rendered.join('  ')}`;
}

async function leaderboardLines(getName: NameResolver, week: Week): Promise<string[]> {
  if (!week.board.length) return [];
  const lines = ['', 'Leaderboard (week-to-date):'];
  let rank = 1;
  for (const row of week.board.slice(0, 10)) {
    lines.push(`${rank}. ${await getName(row.user_id)} — ${row.points} ${pointsUnit(row.points)}`);
    rank++;
  }
  return lines;
}

async function postWeeklyCrown(db: Store, client: any, target: DayTarget) {
  const wk = weekKeyFor(target.date);
  const { start, end, board } = target.week;
  if (board.length) {
    const topPoints = board[0].points;
    const winners = board.filter((r) => r.points === topPoints).map((r) => r.user_id);
    const crownLines = [
      `👑 Boom Game — Weekly Crown (${start} to ${end})`,
      `Winner${winners.length > 1 ? 's' : ''}: ${winners.map((u) => `<@${u}>`).join(', ')} — ${topPoints} ${pointsUnit(topPoints)}`,
    ];
    await client.chat.postMessage({ channel: target.channel, text: crownLines.join('\n') });
    db.setCrown(wk, winners, topPoints);
  }
  db.markCrowned(wk);
}
