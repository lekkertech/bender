import { DateTime } from 'luxon';
import { isHolidayDate } from './holidays.js';

export { isHolidayDate };

export type Game = 'boom' | 'hadeda' | 'wednesday';

export const GAMES: readonly Game[] = ['boom', 'hadeda', 'wednesday'] as const;

/**
 * Legacy podium points awarded to 1st, 2nd, 3rd place by arrival/timestamp order.
 * Retained only to score historical dates recorded before random point assignment
 * (see Store.scoreFor / random_scoring_from). New days use assignRandomPoints().
 */
export const PODIUM_WEIGHTS = [3, 2, 1] as const;

/**
 * How long the entry window stays open, measured from 12:00:00 local. The window is the same for
 * every game and does not move: it opens at noon whether or not anyone posts, and closes 10 minutes
 * later. When it closes, every unique entrant is given a unique random point value in 1..n.
 */
export const ENTRY_WINDOW_MS = (() => {
  const raw = Number(process.env.BOOM_ENTRY_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
})();

/**
 * Settling is deferred this long past the window close so a message sent just inside the window
 * but delivered a moment late still makes the tally.
 *
 * This buys nobody extra time to post: eligibility is decided by the message's own `ts` against
 * the fixed window, so the grace only covers Slack delivering an in-window message late.
 */
export const ENTRY_GRACE_MS = 5 * 1000;

/** Colon-wrapped emoji string for each game (used in message text). */
export const GAME_EMOJI: Record<Game, string> = {
  boom: ':boom:',
  hadeda: ':hadeda-boom:',
  wednesday: ':wednesday-boom:',
};

export type DayInfo = {
  date: string; // YYYY-MM-DD (local tz)
  weekday: number; // 1=Mon .. 7=Sun (ISO)
  isHoliday: boolean;
  isWorkday: boolean; // Mon-Fri and not holiday
};

export const TZ = process.env.TIMEZONE || 'Africa/Johannesburg';

export function localDayInfo(tsSeconds: number): DayInfo {
  const dt = DateTime.fromSeconds(tsSeconds, { zone: TZ });
  const date = dt.toISODate()!;
  return { date, weekday: dt.weekday, isHoliday: isHolidayDate(date), isWorkday: isWorkdayDate(date) };
}

/** Games that must settle before the day can be announced. */
export function neededGamesForDate(date: string): Game[] {
  const weekday = DateTime.fromISO(date, { zone: TZ }).weekday;
  return weekday === 3 ? ['boom', 'hadeda', 'wednesday'] : ['boom', 'hadeda'];
}

/**
 * Give each of the n distinct entrants a unique random point value in 1..n: one entrant gets n,
 * another n-1, down to 1 for the last. Returns entries sorted by points descending.
 *
 * An entrant listed more than once (a middle medallist's bonus entry) draws once per listing and
 * keeps its best draw; the distinct entrants are then ranked by that draw and scored n..1, so the
 * bonus lifts the odds of a high rank without raising the ceiling above the entrant count.
 */
export function assignRandomPoints<T>(
  entries: readonly T[],
  rng: () => number = Math.random,
): Array<{ entrant: T; points: number; draws: number[] }> {
  const n = entries.length;
  const draws = Array.from({ length: n }, (_, i) => i + 1);
  // Fisher-Yates over the draw values, so each entry draws a distinct amount.
  for (let i = n - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(rng() * (i + 1))));
    const tmp = draws[i]!;
    draws[i] = draws[j]!;
    draws[j] = tmp;
  }
  const held = new Map<T, number[]>();
  entries.forEach((entrant, i) => held.set(entrant, [...(held.get(entrant) ?? []), draws[i]!]));
  return Array.from(held.entries())
    .map(([entrant, tickets]) => ({ entrant, draws: tickets.sort((a, b) => b - a) }))
    .sort((a, b) => b.draws[0]! - a.draws[0]!)
    .map(({ entrant, draws: tickets }, rank, ranked) => ({ entrant, points: ranked.length - rank, draws: tickets }));
}

export type MedalKind = 'first' | 'last' | 'middle';

const MIDDLE_MEDALS = 3;

function middleStart(n: number, rng: () => number): number {
  const centreLow = Math.floor((n - MIDDLE_MEDALS) / 2);
  if (n % 2 === 1) return centreLow;
  return rng() < 0.5 ? centreLow : centreLow + 1;
}

export function middleMedals<T>(sorted: readonly T[], rng: () => number = Math.random): Map<T, MedalKind> {
  const start = sorted.length <= MIDDLE_MEDALS ? 0 : middleStart(sorted.length, rng);
  return new Map(sorted.slice(start, start + MIDDLE_MEDALS).map((e) => [e, 'middle' as MedalKind]));
}

export function tsMicros(message_ts: string): number {
  const [seconds, fraction = ''] = message_ts.split('.');
  return Number(seconds) * 1_000_000 + Number(fraction.padEnd(6, '0').slice(0, 6));
}

/** Boom is only played Mon-Fri, excluding public holidays. */
export function isWorkdayDate(date: string): boolean {
  const weekday = DateTime.fromISO(date, { zone: TZ }).weekday;
  return weekday >= 1 && weekday <= 5 && !isHolidayDate(date);
}

/**
 * ms epoch at which a date's noon window closes (13:00:00 local).
 * After this instant no further entries can arrive, so the day's results are final
 * whether or not every game filled its podium.
 */
export function noonWindowEndMs(date: string): number {
  return DateTime.fromISO(date, { zone: TZ })
    .set({ hour: 13, minute: 0, second: 0, millisecond: 0 })
    .toMillis();
}

export function inNoonWindow(tsSeconds: number): boolean {
  return DateTime.fromSeconds(tsSeconds, { zone: TZ }).hour === 12;
}

/** ms epoch at which the entry window opens for a date: 12:00:00.000 local, every workday. */
export function windowOpensAtMs(date: string): number {
  return DateTime.fromISO(date, { zone: TZ }).set({ hour: 12 }).startOf('hour').toMillis();
}

/**
 * ms epoch at which the entry window shuts, exclusive: 12:10:00.000 local by default. A message
 * whose `ts` is at or after this instant is late, however early it was delivered.
 */
export function windowClosesAtMs(date: string): number {
  return windowOpensAtMs(date) + ENTRY_WINDOW_MS;
}

/**
 * ms epoch at which a date's points are assigned — the window close plus the delivery grace.
 * Fixed per date, so every game settles together whether or not anyone played it.
 */
export function windowSettlesAtMs(date: string): number {
  return windowClosesAtMs(date) + ENTRY_GRACE_MS;
}

/**
 * True when a Slack message timestamp falls inside the fixed entry window for its own local date.
 * This is the only test of whether an entry counts: not when the event was delivered, not whether
 * anyone else had posted first.
 */
export function inEntryWindow(tsSeconds: number): boolean {
  const tsMs = tsSeconds * 1000;
  const date = DateTime.fromSeconds(tsSeconds, { zone: TZ }).toISODate()!;
  return tsMs >= windowOpensAtMs(date) && tsMs < windowClosesAtMs(date);
}

export function detectGameFromMessage(text: string, weekday: number): Game | null {
  const t = (text || '').trim();
  if (!t) return null;

  const isOnly = (s: string) => t === s;

  const isBoom = isOnly(GAME_EMOJI.boom) || isOnly('💥');
  const isHadeda = isOnly(GAME_EMOJI.hadeda);
  const isWed = isOnly(GAME_EMOJI.wednesday);

  if (isBoom) return 'boom';
  if (isHadeda) return 'hadeda';
  if (isWed && weekday === 3) return 'wednesday';
  return null;
}

// Detect a valid game emoji regardless of weekday rules (used for clowning outside the window)
export function detectAnyGameEmoji(text: string): Game | null {
  const t = (text || '').trim();
  if (!t) return null;
  if (t === GAME_EMOJI.boom || t === '💥') return 'boom';
  if (t === GAME_EMOJI.hadeda) return 'hadeda';
  if (t === GAME_EMOJI.wednesday) return 'wednesday';
  return null;
}

export function weekKeyFor(date: string): string {
  const dt = DateTime.fromISO(date, { zone: TZ });
  const wk = dt.weekNumber.toString().padStart(2, '0');
  return `${dt.year}-W${wk}`;
}

export function isFriday(date: string): boolean {
  const dt = DateTime.fromISO(date, { zone: TZ });
  return dt.weekday === 5;
}

export function weekStartEnd(date: string): { start: string; end: string } {
  const dt = DateTime.fromISO(date, { zone: TZ });
  const start = dt.startOf('week');
  const end = start.plus({ days: 4 });
  return { start: start.toISODate()!, end: end.toISODate()! };
}
