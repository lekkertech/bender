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
const holidayCache = new Map<string, Set<string>>(); // year -> set of YYYY-MM-DD

function loadYearHolidays(year: number): Set<string> {
  const key = String(year);
  if (holidayCache.has(key)) return holidayCache.get(key)!;
  const set = new Set<string>();
  try {
    const fp = join(process.cwd(), 'data', 'holidays', `za-${year}.json`);
    if (existsSync(fp)) {
      const data = JSON.parse(readFileSync(fp, 'utf8')) as string[];
      data.forEach((d) => set.add(d));
    }
  } catch {}
  // Append any custom env holidays
  const extra = (process.env.HOLIDAYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const d of extra) {
    if (d.startsWith(key + '-')) set.add(d);
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
