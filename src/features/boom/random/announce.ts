import { makeDisplayNameResolver } from '../../../util/slack.js';
import type { Store } from '../store.js';
import { GAME_EMOJI, isFriday, neededGamesForDate, weekKeyFor, weekStartEnd, type Game } from '../rules.js';
import type { Io } from './io.js';

export type Announcer = { db: Store; announcing: Set<string> };

type NameResolver = (userId: string) => Promise<string>;
type DayTarget = { date: string; channel: string; neededGames: Game[] };
type Owed = { results: boolean; crown: boolean };

export function createAnnouncer(db: Store): Announcer {
  return { db, announcing: new Set<string>() };
}

function isSettledAndFresh(db: Store, date: string, neededGames: Game[]): boolean {
  return neededGames.every((g) => db.isResolved(date, g)) && db.isWithinRetryWindow(date);
}

function owedFor(db: Store, date: string): Owed {
  return {
    results: !db.hasDailyAnnounced(date),
    crown: isFriday(date) && !db.hasCrowned(weekKeyFor(date)),
  };
}

export async function announceDay(a: Announcer, io: Io, date: string) {
  const neededGames = neededGamesForDate(date);
  if (!isSettledAndFresh(a.db, date, neededGames)) return;
  const owed = owedFor(a.db, date);
  if ((!owed.results && !owed.crown) || a.announcing.has(date)) return;

  const channel = a.db.channelForDate(date);
  if (!channel) {
    io.logger?.warn?.({ date }, '[boom] cannot announce daily results: no channel recorded');
    return;
  }

  a.announcing.add(date);
  try {
    await postOwed(a.db, io.client, { date, channel, neededGames }, owed);
  } finally {
    a.announcing.delete(date);
  }
}

async function postOwed(db: Store, client: any, target: DayTarget, owed: Owed) {
  if (owed.results) {
    await postDailyResults(db, client, target);
    db.markDailyAnnounced(target.date);
  }
  if (owed.crown) await postWeeklyCrown(db, client, target.date, target.channel);
}

async function postDailyResults(db: Store, client: any, target: DayTarget) {
  const getName = makeDisplayNameResolver(client);
  const lines = [`Boom Game — Daily Podium (${target.date})`];
  for (const game of target.neededGames) {
    lines.push(await podiumLine(db, getName, target.date, game));
  }
  lines.push(...(await leaderboardLines(db, getName, target.date)));
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

async function leaderboardLines(db: Store, getName: NameResolver, date: string): Promise<string[]> {
  const { start, end } = weekStartEnd(date);
  const leaderboard = db.weeklyTotals(start, end);
  if (!leaderboard.length) return [];
  const lines = ['', 'Leaderboard (week-to-date):'];
  let rank = 1;
  for (const row of leaderboard.slice(0, 10)) {
    lines.push(`${rank}. ${await getName(row.user_id)} — ${row.points} pt${row.points === 1 ? '' : 's'}`);
    rank++;
  }
  return lines;
}

async function postWeeklyCrown(db: Store, client: any, date: string, channel: string) {
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
    await client.chat.postMessage({ channel, text: crownLines.join('\n') });
    db.setCrown(wk, winners, topPoints);
  }
  db.markCrowned(wk);
}
