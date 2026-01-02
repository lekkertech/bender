import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  detectGameFromMessage,
  detectAnyGameEmoji,
  inNoonWindow,
  localDayInfo,
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
});
