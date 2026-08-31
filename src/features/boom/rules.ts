import { DateTime } from 'luxon';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type Game = 'boom' | 'hadeda' | 'wednesday';

export const GAMES: readonly Game[] = ['boom', 'hadeda', 'wednesday'] as const;

/**
 * Legacy podium points awarded to 1st, 2nd, 3rd place by arrival/timestamp order.
 * Retained only to score historical dates recorded before random point assignment
 * (see Store.scoreFor / random_scoring_from). New days use assignRandomPoints().
 */
export const PODIUM_WEIGHTS = [3, 2, 1] as const;

/**
 * How long a game's tally window stays open, measured from its first valid entry.
 * When it closes, every unique entrant is given a unique random point value in 1..n.
 */
export const ENTRY_WINDOW_MS = (() => {
  const raw = Number(process.env.BOOM_ENTRY_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
})();

/**
 * Settling is deferred this long past the window close so a message sent just inside the window
 * but delivered a moment late still makes the tally instead of being clowned as too late.
 */
export const ENTRY_GRACE_MS = 3 * 1000;

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
  const weekday = dt.weekday; // 1..7
  const isHoliday = isHolidayDate(date);
  const isWorkday = weekday >= 1 && weekday <= 5 && !isHoliday;
  return { date, weekday, isHoliday, isWorkday };
}

/** Games that must settle before the day can be announced. */
export function neededGamesForDate(date: string): Game[] {
  const weekday = DateTime.fromISO(date, { zone: TZ }).weekday;
  return weekday === 3 ? ['boom', 'hadeda', 'wednesday'] : ['boom', 'hadeda'];
}

/**
 * Give each of the n entrants a unique random point value in 1..n: one entrant gets n,
 * another n-1, down to 1 for the last. Returns entries sorted by points descending.
 */
export function assignRandomPoints<T>(
  entrants: readonly T[],
  rng: () => number = Math.random,
): Array<{ entrant: T; points: number }> {
  const n = entrants.length;
  const points = Array.from({ length: n }, (_, i) => i + 1);
  // Fisher-Yates over the point values, so each entrant draws a distinct amount.
  for (let i = n - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(rng() * (i + 1))));
    const tmp = points[i]!;
    points[i] = points[j]!;
    points[j] = tmp;
  }
  return entrants
    .map((entrant, i) => ({ entrant, points: points[i]! }))
    .sort((a, b) => b.points - a.points);
}

/** ms epoch of the last instant of the noon window (12:59:59.999 local) for a date. */
export function noonWindowEndMs(date: string): number {
  return DateTime.fromISO(date, { zone: TZ }).set({ hour: 12 }).endOf('hour').toMillis();
}

export function inNoonWindow(tsSeconds: number): boolean {
  const dt = DateTime.fromSeconds(tsSeconds, { zone: TZ });
  const h = dt.hour;
  if (h !== 12) return false;
  // minute/second range automatically satisfied if hour is 12
  return true;
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

// Load holiday dates for ZA from seeded JSON by year, fallback to env HOLIDAYS list
// Note: cache key includes process.cwd() because holiday seed files are loaded relative to CWD
// and tests may change it.
const holidayCache = new Map<string, Set<string>>(); // "<cwd>::<year>" -> set of YYYY-MM-DD

function stripJsonc(input: string): string {
  // Remove // line comments and /* */ block comments while preserving string literals.
  let out = '';
  let i = 0;
  let inString = false;
  let stringQuote: '"' | "'" | null = null;
  let escaped = false;

  while (i < input.length) {
    const ch = input[i] || '';
    const next = input[i + 1] || '';

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (stringQuote && ch === stringQuote) {
        inString = false;
        stringQuote = null;
      }
      i++;
      continue;
    }

    // Line comment
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length) {
        if (input[i] === '*' && input[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch as any;
      out += ch;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  // JSONC often allows trailing commas; remove a simple set of cases.
  out = out.replace(/,\s*(\]|\})/g, '$1');
  return out;
}

function loadYearHolidays(year: number): Set<string> {
  const yearKey = String(year);
  const key = `${process.cwd()}::${yearKey}`;
  if (holidayCache.has(key)) return holidayCache.get(key)!;
  const set = new Set<string>();
  try {
    const fp = join(process.cwd(), 'data', 'holidays', `za-${year}.json`);
    if (existsSync(fp)) {
      const raw = readFileSync(fp, 'utf8');
      const cleaned = stripJsonc(raw);
      const parsed = JSON.parse(cleaned) as unknown;
      if (Array.isArray(parsed)) {
        for (const v of parsed) {
          if (typeof v !== 'string') continue;
          const d = v.trim();
          if (/^\d{4}-\d{2}-\d{2}$/.test(d)) set.add(d);
        }
      } else {
        console.warn(`[boom] holidays file is not an array: ${fp}`);
      }
    }
  } catch (err) {
    // Avoid silently disabling holiday detection.
    console.warn('[boom] failed to load holidays:', { year, err });
  }
  // Append any custom env holidays
  const extra = (process.env.HOLIDAYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const d of extra) {
    if (d.startsWith(yearKey + '-')) set.add(d);
  }
  holidayCache.set(key, set);
  return set;
}

export function isHolidayDate(date: string): boolean {
  const year = Number(date.slice(0, 4));
  const set = loadYearHolidays(year);
  return set.has(date);
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
  const start = dt.startOf('week').plus({ days: 0 }); // ISO week starts Monday
  const end = start.plus({ days: 4 }); // Monday..Friday
  return { start: start.toISODate()!, end: end.toISODate()! };
}
