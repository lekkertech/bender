import { DateTime } from 'luxon';
import type { Award } from '../store-data.js';
import { GAME_EMOJI, TZ, tsMicros, type Game } from '../rules.js';
import type { NameResolver } from '../leaderboard.js';

export const AUDIT_INTRO = [
  '*How the draw works:* everyone who posted in the window gets one ticket.',
  'The three players in the middle of the posting order :sports_medal: get a second ticket.',
  'With an even number of players, the centre two always get one and a coin flip picks',
  'the player just before or just after them. With three or fewer players, everyone gets one.',
  'All tickets are numbered from 1 up and shuffled. Your best ticket sets your rank,',
  'and rank sets points: the player count for 1st, down to 1pt for last.',
].join(' ');

type Placed = { award: Award; post: number };

function clock(message_ts: string): string {
  return DateTime.fromMillis(tsMicros(message_ts) / 1000, { zone: TZ }).toFormat('HH:mm:ss.SSS');
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function postOrder(awards: Award[]): Map<Award, number> {
  const byTs = [...awards].sort((a, b) => tsMicros(a.message_ts) - tsMicros(b.message_ts));
  return new Map(byTs.map((a, i) => [a, i + 1]));
}

function medalPosts(placed: Placed[]): string {
  const posts = placed.filter((p) => p.award.medal).map((p) => p.post).sort((a, b) => a - b);
  if (!posts.length) return 'no medals';
  const span = posts.length === 1 ? `post ${posts[0]}` : `posts ${posts[0]}-${posts[posts.length - 1]}`;
  return `medals to ${span} of ${placed.length}`;
}

function gameHeader(game: Game, placed: Placed[]): string {
  const tickets = placed.reduce((sum, p) => sum + (p.award.draws?.length ?? 1), 0);
  const bonus = tickets - placed.length;
  const players = plural(placed.length, 'player');
  return `${GAME_EMOJI[game]} ${players}, ${plural(tickets, 'ticket')} (${placed.length} + ${bonus} bonus), ${medalPosts(placed)}`;
}

function ticketText(draws: number[]): string {
  if (draws.length === 1) return `ticket ${draws[0]}`;
  return `tickets ${draws.join(', ')} (kept ${draws[0]})`;
}

async function playerLine(getName: NameResolver, { award: a, post }: Placed, rank: number): Promise<string> {
  const medal = a.medal ? ` · ${a.medal} :sports_medal:` : '';
  const posted = `posted #${post} at ${clock(a.message_ts)}`;
  return `${rank}) ${await getName(a.user_id)} · ${posted}${medal} · ${ticketText(a.draws!)} → ${a.points}pt`;
}

export async function gameAuditLines(getName: NameResolver, game: Game, awards: Award[]): Promise<string[]> {
  if (!awards.length) return [`${GAME_EMOJI[game]} no entries`];
  if (awards.some((a) => !a.draws)) return [`${GAME_EMOJI[game]} scored before draws were recorded`];
  const order = postOrder(awards);
  const placed = awards.map((award) => ({ award, post: order.get(award)! }));
  const lines = await Promise.all(placed.map((p, i) => playerLine(getName, p, i + 1)));
  return [gameHeader(game, placed), ...lines];
}
