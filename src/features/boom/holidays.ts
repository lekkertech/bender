import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stripJsonc } from './jsonc.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const holidayCache = new Map<string, Set<string>>();

function holidayDates(parsed: unknown, filePath: string): string[] {
  if (!Array.isArray(parsed)) {
    console.warn(`[boom] holidays file is not an array: ${filePath}`);
    return [];
  }
  return parsed
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((d) => ISO_DATE.test(d));
}

function seededHolidays(year: number): string[] {
  const filePath = join(process.cwd(), 'data', 'holidays', `za-${year}.json`);
  if (!existsSync(filePath)) return [];
  try {
    return holidayDates(JSON.parse(stripJsonc(readFileSync(filePath, 'utf8'))), filePath);
  } catch (err) {
    console.warn('[boom] failed to load holidays:', { year, err });
    return [];
  }
}

function envHolidays(yearKey: string): string[] {
  return (process.env.HOLIDAYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((d) => d.startsWith(`${yearKey}-`));
}

function loadYearHolidays(year: number): Set<string> {
  const key = `${process.cwd()}::${year}`;
  const cached = holidayCache.get(key);
  if (cached) return cached;
  const set = new Set([...seededHolidays(year), ...envHolidays(String(year))]);
  holidayCache.set(key, set);
  return set;
}

export function isHolidayDate(date: string): boolean {
  return loadYearHolidays(Number(date.slice(0, 4))).has(date);
}
