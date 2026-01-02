import { DateTime } from 'luxon';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type Game = 'boom' | 'hadeda' | 'wednesday';

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

export function inNoonWindow(tsSeconds: number): boolean {
  const dt = DateTime.fromSeconds(tsSeconds, { zone: TZ });
  const h = dt.hour;
  if (h !== 12) return false;
  // minute/second range automatically satisfied if hour is 12
  return true;
}

export function detectGameFromMessage(text: string, weekday: number): Game | null {
  // Trim and normalize
  const t = (text || '').trim();
  if (!t) return null;

  // Enforce single-emoji messages: exact match for these tokens
  const isOnly = (s: string) => t === s;

  // :boom: may render as unicode 💥 in text; accept either
  const isBoom = isOnly(':boom:') || isOnly('💥');
  const isHadeda = isOnly(':hadeda-boom:'); // custom emoji
  const isWed = isOnly(':wednesday-boom:'); // custom emoji

  if (isBoom) return 'boom';
  if (isHadeda) return 'hadeda';
  if (isWed && weekday === 3) return 'wednesday';
  return null;
}

// Detect a valid game emoji regardless of weekday rules (used for clowning outside the window)
export function detectAnyGameEmoji(text: string): Game | null {
  const t = (text || '').trim();
  if (!t) return null;
  if (t === ':boom:' || t === '💥') return 'boom';
  if (t === ':hadeda-boom:') return 'hadeda';
  if (t === ':wednesday-boom:') return 'wednesday';
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
