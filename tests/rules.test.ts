import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  assignRandomPoints,
  detectGameFromMessage,
  detectAnyGameEmoji,
  ENTRY_WINDOW_MS,
  inNoonWindow,
  localDayInfo,
  neededGamesForDate,
  weekKeyFor,
  isFriday,
  weekStartEnd,
} from '../src/features/boom/rules.ts';

const ZONE = 'Africa/Johannesburg';
const toSec = (iso: string) => Math.floor(DateTime.fromISO(iso, { zone: ZONE }).toSeconds());

describe('rules.ts basics', () => {
  it('detectGameFromMessage enforces single emoji and weekday rules', () => {
    // Wed = 3
    expect(detectGameFromMessage(':boom:', 3)).toBe('boom');
    expect(detectGameFromMessage('💥', 3)).toBe('boom');
    expect(detectGameFromMessage(':hadeda-boom:', 3)).toBe('hadeda');
    expect(detectGameFromMessage(':wednesday-boom:', 3)).toBe('wednesday');

    // Non-Wed
    expect(detectGameFromMessage(':wednesday-boom:', 1)).toBeNull();

    // Non-exact strings fail
    expect(detectGameFromMessage(' :boom: ', 3)).toBe('boom'); // trims are allowed for equality in our implementation
    expect(detectGameFromMessage(':boom: extra', 3)).toBeNull();
    expect(detectGameFromMessage('extra :boom:', 3)).toBeNull();
  });

  it('detectAnyGameEmoji ignores weekday restriction', () => {
    expect(detectAnyGameEmoji(':boom:')).toBe('boom');
    expect(detectAnyGameEmoji('💥')).toBe('boom');
    expect(detectAnyGameEmoji(':hadeda-boom:')).toBe('hadeda');
    expect(detectAnyGameEmoji(':wednesday-boom:')).toBe('wednesday');
    expect(detectAnyGameEmoji('')).toBeNull();
    expect(detectAnyGameEmoji('something else')).toBeNull();
  });

  it('inNoonWindow only true during 12:00 hour local', () => {
    const before = toSec('2025-03-03T11:59:59');
    const atNoon = toSec('2025-03-03T12:00:00');
    const nearEnd = toSec('2025-03-03T12:59:59');
    const after = toSec('2025-03-03T13:00:00');

    expect(inNoonWindow(before)).toBe(false);
    expect(inNoonWindow(atNoon)).toBe(true);
    expect(inNoonWindow(nearEnd)).toBe(true);
    expect(inNoonWindow(after)).toBe(false);
  });

  it('localDayInfo gives ISO weekday and workday flags', () => {
    // 2025-03-02 is Sunday
    const sun = localDayInfo(toSec('2025-03-02T12:00:00'));
    expect(sun.weekday).toBe(7);
    expect(sun.isWorkday).toBe(false);

    // 2025-03-03 is Monday
    const mon = localDayInfo(toSec('2025-03-03T12:00:00'));
    expect(mon.weekday).toBe(1);
    expect(mon.isWorkday).toBe(true);
    expect(mon.date).toBe('2025-03-03');

    // 2025-03-21 is a South African public holiday (Human Rights Day)
    const holiday = localDayInfo(toSec('2025-03-21T12:00:00'));
    expect(holiday.weekday).toBe(5);
    expect(holiday.isHoliday).toBe(true);
    expect(holiday.isWorkday).toBe(false);
  });

  it('week key/start/end and friday detection', () => {
    // Choose a Wednesday: 2025-03-05
    const date = '2025-03-05';
    expect(weekKeyFor(date)).toMatch(/^2025-W0?\d{1,2}$/);

    const range = weekStartEnd(date);
    // ISO week Mon..Fri around 2025-03-05 -> 2025-03-03..2025-03-07
    expect(range.start).toBe('2025-03-03');
    expect(range.end).toBe('2025-03-07');

    // Friday check on 2025-03-07
    expect(isFriday('2025-03-07')).toBe(true);
    expect(isFriday('2025-03-06')).toBe(false);
  });

  it('neededGamesForDate adds the wednesday game only on Wednesdays', () => {
    expect(neededGamesForDate('2025-03-03')).toEqual(['boom', 'hadeda']); // Mon
    expect(neededGamesForDate('2025-03-05')).toEqual(['boom', 'hadeda', 'wednesday']); // Wed
    expect(neededGamesForDate('2025-03-07')).toEqual(['boom', 'hadeda']); // Fri
  });

  it('the tally window defaults to 5 minutes', () => {
    expect(ENTRY_WINDOW_MS).toBe(5 * 60 * 1000);
  });
});

describe('assignRandomPoints', () => {
  it('gives each of n entrants a unique amount between 1 and n, highest first', () => {
    for (const n of [1, 2, 3, 9, 25]) {
      const entrants = Array.from({ length: n }, (_, i) => `U${i}`);
      const result = assignRandomPoints(entrants);

      // Every entrant appears exactly once
      expect(result.length).toBe(n);
      expect(new Set(result.map((r) => r.entrant)).size).toBe(n);
      // Points are exactly the permutation 1..n — unique, no gaps
      expect(result.map((r) => r.points).sort((a, b) => a - b)).toEqual(
        Array.from({ length: n }, (_, i) => i + 1),
      );
      // Sorted highest points first
      expect(result.map((r) => r.points)).toEqual([...result.map((r) => r.points)].sort((a, b) => b - a));
      expect(result[0].points).toBe(n);
    }
  });

  it('does not always hand the top score to the same entrant', () => {
    // 200 draws over 5 entrants: a fixed-order implementation would give one entrant every win.
    const winners = new Set<string>();
    for (let i = 0; i < 200; i++) {
      winners.add(assignRandomPoints(['A', 'B', 'C', 'D', 'E'])[0].entrant);
    }
    expect(winners.size).toBeGreaterThan(1);
  });

  it('is deterministic for a given rng and tolerates an rng returning 1', () => {
    const zeros = assignRandomPoints(['A', 'B', 'C'], () => 0);
    expect(zeros).toEqual([
      { entrant: 'B', points: 3 },
      { entrant: 'A', points: 2 },
      { entrant: 'C', points: 1 },
    ]);

    // rng() === 1 must stay in range rather than swapping past the end of the array
    const ones = assignRandomPoints(['A', 'B', 'C'], () => 1);
    expect(ones.map((r) => r.points).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(new Set(ones.map((r) => r.entrant)).size).toBe(3);
  });

  it('returns nothing for no entrants', () => {
    expect(assignRandomPoints([])).toEqual([]);
  });
});
