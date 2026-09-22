import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  assignRandomPoints,
  detectGameFromMessage,
  detectAnyGameEmoji,
  ENTRY_GRACE_MS,
  ENTRY_WINDOW_MS,
  inEntryWindow,
  localDayInfo,
  neededGamesForDate,
  timingMedals,
  windowClosesAtMs,
  windowOpensAtMs,
  windowSettlesAtMs,
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

  it('inEntryWindow accepts only 12:00:00 to 12:09:59 local', () => {
    // The window is fixed: it opens at noon whether or not anyone posts, and shuts 10 minutes on.
    expect(inEntryWindow(toSec('2025-03-03T11:59:59'))).toBe(false);
    expect(inEntryWindow(toSec('2025-03-03T12:00:00'))).toBe(true);
    expect(inEntryWindow(toSec('2025-03-03T12:09:59'))).toBe(true);
    expect(inEntryWindow(toSec('2025-03-03T12:10:00'))).toBe(false);
    // Being merely inside the noon hour is no longer enough.
    expect(inEntryWindow(toSec('2025-03-03T12:30:00'))).toBe(false);
    expect(inEntryWindow(toSec('2025-03-03T12:59:59'))).toBe(false);
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

  it('the entry window is 10 minutes, settling 5 seconds later', () => {
    expect(ENTRY_WINDOW_MS).toBe(10 * 60 * 1000);
    expect(ENTRY_GRACE_MS).toBe(5 * 1000);
  });

  it('the window runs 12:00:00 to 12:10:00 local and settles at 12:10:05', () => {
    const iso = (ms: number) => DateTime.fromMillis(ms, { zone: ZONE }).toISO();
    expect(iso(windowOpensAtMs('2025-03-03'))).toBe('2025-03-03T12:00:00.000+02:00');
    expect(iso(windowClosesAtMs('2025-03-03'))).toBe('2025-03-03T12:10:00.000+02:00');
    expect(iso(windowSettlesAtMs('2025-03-03'))).toBe('2025-03-03T12:10:05.000+02:00');

    // The close is exclusive: the last instant that still counts is one ms before it.
    const close = windowClosesAtMs('2025-03-03');
    expect(inEntryWindow((close - 1) / 1000)).toBe(true);
    expect(inEntryWindow(close / 1000)).toBe(false);
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
      { entrant: 'B', points: 3, draws: [3] },
      { entrant: 'A', points: 2, draws: [2] },
      { entrant: 'C', points: 1, draws: [1] },
    ]);

    // rng() === 1 must stay in range rather than swapping past the end of the array
    const ones = assignRandomPoints(['A', 'B', 'C'], () => 1);
    expect(ones.map((r) => r.points).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(new Set(ones.map((r) => r.entrant)).size).toBe(3);
  });

  it('returns nothing for no entrants', () => {
    expect(assignRandomPoints([])).toEqual([]);
  });

  it('scores an entrant listed twice once, on its better draw, and still hands out exactly 1..n', () => {
    // rng() === 1 leaves the draws in place: A draws 1 then 3, B draws 2. A keeps the 3 and ranks first.
    expect(assignRandomPoints(['A', 'B', 'A'], () => 1)).toEqual([
      { entrant: 'A', points: 2, draws: [3, 1] },
      { entrant: 'B', points: 1, draws: [2] },
    ]);

    for (let i = 0; i < 50; i++) {
      const result = assignRandomPoints(['A', 'B', 'C', 'D', 'A', 'C', 'D']);
      expect(result.map((r) => r.entrant).sort()).toEqual(['A', 'B', 'C', 'D']);
      expect(result.map((r) => r.points)).toEqual([4, 3, 2, 1]);
    }
  });

  it('lifts the odds of a second listing without guaranteeing the top score', () => {
    // A wins unless B's single draw is the 3: A should take the top spot about two times in three.
    let wins = 0;
    for (let i = 0; i < 400; i++) {
      if (assignRandomPoints(['A', 'B', 'A'])[0].entrant === 'A') wins++;
    }
    expect(wins).toBeGreaterThan(200);
    expect(wins).toBeLessThan(400);
  });
});

describe('timingMedals', () => {
  const BASE = 1740996000;
  const entrant = (user_id: string, offset: number) => ({ user_id, message_ts: (BASE + offset).toFixed(6) });
  const medalsOf = (offsets: number[], rng?: () => number) => {
    const sorted = offsets.map((o, i) => entrant(`U${i + 1}`, o));
    return Object.fromEntries(Array.from(timingMedals(sorted, rng), ([e, kind]) => [e.user_id, kind]));
  };

  it('awards nothing with no entrants', () => {
    expect(medalsOf([])).toEqual({});
  });

  it('gives a solo entrant one medal, and two entrants first and last', () => {
    expect(medalsOf([10])).toEqual({ U1: 'first' });
    expect(medalsOf([10, 562])).toEqual({ U1: 'first', U2: 'last' });
  });

  it('gives three entrants all three medals', () => {
    expect(medalsOf([10, 500, 562])).toEqual({ U1: 'first', U2: 'middle', U3: 'last' });
  });

  it('gives the middle to the entrant nearest the halfway point between first and last', () => {
    // Halfway is 286s. The only candidate after it is the last entrant, who is discarded.
    expect(medalsOf([10, 60, 270, 562])).toEqual({ U1: 'first', U3: 'middle', U4: 'last' });
    // Nearest before (60, 226s away) loses to nearest after (300, 14s away).
    expect(medalsOf([10, 60, 300, 562])).toEqual({ U1: 'first', U3: 'middle', U4: 'last' });
    // Only the nearest on each side is a candidate: 3 beats 0..2 as well as the discarded last.
    expect(medalsOf([0, 1, 2, 3, 100])).toEqual({ U1: 'first', U4: 'middle', U5: 'last' });
  });

  it('settles an exact tie for the middle on the rng', () => {
    // Halfway is 200s; 100 and 300 are both 100s away.
    expect(medalsOf([0, 100, 300, 400], () => 0)).toEqual({ U1: 'first', U2: 'middle', U4: 'last' });
    expect(medalsOf([0, 100, 300, 400], () => 0.9)).toEqual({ U1: 'first', U3: 'middle', U4: 'last' });
  });

  it('sees an exact microsecond tie on real Slack timestamps', () => {
    const sorted = [
      { user_id: 'U1', message_ts: '1757409424.623851' },
      { user_id: 'U2', message_ts: '1757409627.294299' },
      { user_id: 'U3', message_ts: '1757409689.490159' },
      { user_id: 'U4', message_ts: '1757409892.160607' },
    ];
    const winner = (rng: () => number) =>
      Array.from(timingMedals(sorted, rng)).find(([, kind]) => kind === 'middle')![0].user_id;
    expect(winner(() => 0)).toBe('U2');
    expect(winner(() => 0.9)).toBe('U3');
  });
});
