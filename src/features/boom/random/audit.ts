import { DateTime } from 'luxon';
import type { Award } from '../store-data.js';
import { GAME_EMOJI, TZ, tsMicros, type Game } from '../rules.js';
import type { NameResolver } from '../leaderboard.js';

export const AUDIT_INTRO = [
  '*How the draw works:* everyone who posted in the window gets one ticket.',
  'The first, middle and last to post :sports_medal: get a second ticket.',
  'All tickets are numbered from 1 up and shuffled. Your best ticket sets your rank,',
  'and rank sets points: the player count for 1st, down to 1pt for last.',
  'Middle means the player posted closest to halfway between the first and last posts.',
].join(' ');

function clock(message_ts: string): string {
  return DateTime.fromMillis(tsMicros(message_ts) / 1000, { zone: TZ }).toFormat('HH:mm:ss.SSS');
}

function halfwayClock(awards: Award[]): string {
  const times = awards.map((a) => tsMicros(a.message_ts));
  const half = (Math.min(...times) + Math.max(...times)) / 2;
  return DateTime.fromMillis(half / 1000, { zone: TZ }).toFormat('HH:mm:ss.SSS');
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function gameHeader(game: Game, awards: Award[]): string {
  const tickets = awards.reduce((sum, a) => sum + (a.draws?.length ?? 1), 0);
  const bonus = tickets - awards.length;
  const players = plural(awards.length, 'player');
  return `${GAME_EMOJI[game]} ${players}, ${plural(tickets, 'ticket')} (${awards.length} + ${bonus} bonus), halfway ${halfwayClock(awards)}`;
}

function ticketText(draws: number[]): string {
  if (draws.length === 1) return `ticket ${draws[0]}`;
  return `tickets ${draws.join(', ')} (kept ${draws[0]})`;
}

async function playerLine(getName: NameResolver, a: Award, rank: number): Promise<string> {
  const medal = a.medal ? ` · ${a.medal} :sports_medal:` : '';
  return `${rank}) ${await getName(a.user_id)} · posted ${clock(a.message_ts)}${medal} · ${ticketText(a.draws!)} → ${a.points}pt`;
}

export async function gameAuditLines(getName: NameResolver, game: Game, awards: Award[]): Promise<string[]> {
  if (!awards.length) return [`${GAME_EMOJI[game]} no entries`];
  if (awards.some((a) => !a.draws)) return [`${GAME_EMOJI[game]} scored before draws were recorded`];
  const lines = await Promise.all(awards.map((a, i) => playerLine(getName, a, i + 1)));
  return [gameHeader(game, awards), ...lines];
}
