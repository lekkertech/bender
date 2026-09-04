import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DateTime } from 'luxon';
import { Store } from '../src/features/boom/store.ts';
import { windowClosesAtMs, windowOpensAtMs, windowSettlesAtMs } from '../src/features/boom/rules.ts';

const ZONE = 'Africa/Johannesburg';

function withStore<T>(fn: (store: Store, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'boom-store-'));
  const file = join(dir, 'data', 'store.json');
  const store = new Store(file);
  try {
    return fn(store, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Boot a Store at a fixed instant, then run at another, so the random-scoring cutover (stamped as
 * the boot date, or the day after when that date's results are already out) is predictable.
 * `seed` is written to the store file before construction, to boot onto an existing ledger.
 */
function withStoreAt<T>(bootIso: string, nowIso: string, fn: (store: Store) => T, seed?: any): T {
  const dir = mkdtempSync(join(tmpdir(), 'boom-store-'));
  const file = join(dir, 'data', 'store.json');
  vi.useFakeTimers();
  try {
    if (seed) {
      mkdirSync(join(dir, 'data'), { recursive: true });
      writeFileSync(file, JSON.stringify(seed), 'utf8');
    }
    vi.setSystemTime(DateTime.fromISO(bootIso, { zone: ZONE }).toMillis());
    const store = new Store(file);
    vi.setSystemTime(DateTime.fromISO(nowIso, { zone: ZONE }).toMillis());
    return fn(store);
  } finally {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Store', () => {
  it('increments counts per date+game and reads back', () =>
    withStore((db) => {
      const d = '2025-03-03';
      expect(db.incrementCount(d, 'boom')).toBe(1);
      expect(db.incrementCount(d, 'boom')).toBe(2);
      expect(db.incrementCount(d, 'hadeda')).toBe(1);
      const counts = db.getCounts(d);
      expect(counts.boom).toBe(2);
      expect(counts.hadeda).toBe(1);
      expect(counts.wednesday).toBe(0);
    }));

  it('tracks placements, prevents duplicates and caps at 3', () =>
    withStore((db) => {
      const d = '2025-03-03';
      expect(db.addPlacement(d, 'boom', 'U1')).toBe(1);
      expect(db.addPlacement(d, 'boom', 'U2')).toBe(2);
      expect(db.addPlacement(d, 'boom', 'U3')).toBe(3);
      // Further placements are ignored
      expect(db.addPlacement(d, 'boom', 'U4')).toBe(0);
      // Duplicate user also ignored
      expect(db.addPlacement(d, 'boom', 'U1')).toBe(0);

      expect(db.placementsCount(d, 'boom')).toBe(3);
      expect(db.getPlacements(d, 'boom')).toEqual(['U1', 'U2', 'U3']);
    }));

  it('daily announced and crowned flags', () =>
    withStore((db) => {
      const d = '2025-03-04';
      const wk = '2025-W10';
      expect(db.hasDailyAnnounced(d)).toBe(false);
      db.markDailyAnnounced(d);
      expect(db.hasDailyAnnounced(d)).toBe(true);

      expect(db.hasCrowned(wk)).toBe(false);
      db.markCrowned(wk);
      expect(db.hasCrowned(wk)).toBe(true);
    }));

  it('weeklyTotals computes 3-2-1 across days in week', () =>
    withStore((db) => {
      // Two dates in the same ISO week (Mon-Fri)
      const d1 = '2025-03-03'; // Mon
      const d2 = '2025-03-04'; // Tue
      // Monday placements
      db.addPlacement(d1, 'boom', 'U1'); // +3
      db.addPlacement(d1, 'boom', 'U2'); // +2
      db.addPlacement(d1, 'boom', 'U3'); // +1
      db.addPlacement(d1, 'hadeda', 'U2'); // +3
      db.addPlacement(d1, 'hadeda', 'U3'); // +2
      db.addPlacement(d1, 'hadeda', 'U4'); // +1
      // Wednesday placements
      db.addPlacement(d2, 'wednesday', 'U1'); // +3
      db.addPlacement(d2, 'wednesday', 'U4'); // +2
      db.addPlacement(d2, 'wednesday', 'U5'); // +1

      const totals = db.weeklyTotals('2025-03-03', '2025-03-07');
      const map = new Map(totals.map((r) => [r.user_id, r.points]));
      expect(map.get('U1')).toBe(6); // 3 (Mon boom 1st) + 3 (Tue wed 1st)
      expect(map.get('U2')).toBe(5); // 2 (Mon boom 2nd) + 3 (Mon hadeda 1st)
      expect(map.get('U3')).toBe(3); // 1 (Mon boom 3rd) + 2 (Mon hadeda 2nd)
      expect(map.get('U4')).toBe(3); // 1 (Mon hadeda 3rd) + 2 (Tue wed 2nd)
      expect(map.get('U5')).toBe(1); // 1 (Tue wed 3rd)
    }));

  it('crown persistence stores latest crown and getLatestCrown returns the newest', () =>
    withStore((db) => {
      db.setCrown('2025-W10', ['U1'], 12);
      const first = db.getLatestCrown();
      expect(first).not.toBeNull();
      expect(first!.weekKey).toBe('2025-W10');
      // A later crown (called later) should become "latest"
      db.setCrown('2025-W11', ['U2', 'U3'], 9);
      const latest = db.getLatestCrown();
      expect(latest).not.toBeNull();
      expect(latest!.weekKey).toBe('2025-W11');
      expect(latest!.winners).toEqual(['U2', 'U3']);
      expect(latest!.points).toBe(9);
    }));
  it('computes podium by earliest message ts, independent of arrival order', () =>
    withStore((db) => {
      const d = '2025-03-03';
      // Simulate out-of-order arrival: later ts first, earlier ts second
      db.addPlacement(d, 'boom', 'U1', { ts: '1757498400.276939', channel_id: 'C1' }); // later
      db.addPlacement(d, 'boom', 'U2', { ts: '1757498400.275209', channel_id: 'C1' }); // earlier
      // Podium should be ordered by ts (earliest first)
      expect(db.getPlacements(d, 'boom')).toEqual(['U2', 'U1']);

      // Weekly totals should award 3 to U2 (1st) and 2 to U1 (2nd)
      const totals = db.weeklyTotals('2025-03-03', '2025-03-07');
      const map = new Map(totals.map((r) => [r.user_id, r.points]));
      expect(map.get('U2')).toBe(3);
      expect(map.get('U1')).toBe(2);
    }));

  it('latestCompletedWeekWinner recomputes settled winner (W24 scenario): Friday overtake wins', () =>
    withStore((db) => {
      // Week N = ISO W10 (Mon 2025-03-03 .. Fri 2025-03-07).
      // Mon-Thu: JESSE leads via 1st places; Z only places lower.
      // Friday: Z takes enough 1st places to finish strictly above JESSE for the week.
      let ts = 1757498400.0;
      const next = () => (ts += 0.001).toFixed(6);

      // Mon-Thu: JESSE 1st, Z 2nd in boom each day → JESSE +3*4=12, Z +2*4=8.
      for (const d of ['2025-03-03', '2025-03-04', '2025-03-05', '2025-03-06']) {
        db.addPlacement(d, 'boom', 'JESSE', { ts: next(), channel_id: 'C1' });
        db.addPlacement(d, 'boom', 'Z', { ts: next(), channel_id: 'C1' });
      }
      // Friday: Z sweeps 1st across all three games (+9) while JESSE does not place.
      // Z = 8 + 9 = 17 overtakes JESSE = 12.
      db.addPlacement('2025-03-07', 'boom', 'Z', { ts: next(), channel_id: 'C1' });
      db.addPlacement('2025-03-07', 'hadeda', 'Z', { ts: next(), channel_id: 'C1' });
      db.addPlacement('2025-03-07', 'wednesday', 'Z', { ts: next(), channel_id: 'C1' });

      const totals = db.weeklyTotals('2025-03-03', '2025-03-07');
      const map = new Map(totals.map((r) => [r.user_id, r.points]));
      // Confirm Z strictly above JESSE for the settled week.
      expect(map.get('Z')!).toBeGreaterThan(map.get('JESSE')!);

      // Query from a date in week N+1 (W11). Should return Z, not JESSE.
      const res = db.latestCompletedWeekWinner('2025-03-12');
      expect(res).not.toBeNull();
      expect(res!.weekKey).toBe('2025-W10');
      expect(res!.start).toBe('2025-03-03');
      expect(res!.end).toBe('2025-03-07');
      expect(res!.winners).toEqual(['Z']);
      expect(res!.points).toBe(map.get('Z')!);
    }));

  it('latestCompletedWeekWinner returns all tied winners', () =>
    withStore((db) => {
      // Week W10: two users tie at the top of the completed week.
      let ts = 1757498400.0;
      const next = () => (ts += 0.001).toFixed(6);
      // A 1st in boom (+3), B 1st in hadeda (+3) → tie at 3.
      db.addPlacement('2025-03-03', 'boom', 'A', { ts: next(), channel_id: 'C1' });
      db.addPlacement('2025-03-03', 'hadeda', 'B', { ts: next(), channel_id: 'C1' });

      const res = db.latestCompletedWeekWinner('2025-03-12');
      expect(res).not.toBeNull();
      expect(res!.weekKey).toBe('2025-W10');
      expect(res!.points).toBe(3);
      expect([...res!.winners].sort()).toEqual(['A', 'B']);
    }));

  it('latestCompletedWeekWinner walks back to the first non-empty week, null when empty', () =>
    withStore((db) => {
      // Put data only in W10 (2025-03-03..07). Query from W12 (2025-03-17),
      // so the immediately-previous week W11 is empty and lookback must reach W10.
      let ts = 1757498400.0;
      const next = () => (ts += 0.001).toFixed(6);
      db.addPlacement('2025-03-03', 'boom', 'WINNER', { ts: next(), channel_id: 'C1' });

      const res = db.latestCompletedWeekWinner('2025-03-17');
      expect(res).not.toBeNull();
      expect(res!.weekKey).toBe('2025-W10');
      expect(res!.winners).toEqual(['WINNER']);
      expect(res!.points).toBe(3);
    }));

  it('latestCompletedWeekWinner returns null when the 8-week lookback has no data', () =>
    withStore((db) => {
      // Only W10 (March) has data. Query from a date whose previous 8 ISO weeks
      // all fall before March, so the lookback window never reaches W10.
      let ts = 1757498400.0;
      const next = () => (ts += 0.001).toFixed(6);
      db.addPlacement('2025-03-03', 'boom', 'WINNER', { ts: next(), channel_id: 'C1' });

      // Query from 2025-02-24 (W09). Previous weeks W08..W01 (Dec 2024) hold no data.
      expect(db.latestCompletedWeekWinner('2025-02-24')).toBeNull();
    }));
});

describe('Store random point assignment', () => {
  // 2025-03-03T12:00:00 in Africa/Johannesburg — the instant the entry window opens. The store is
  // booted the day before, putting 2025-03-03 in the random era. NOW is past settling.
  const BASE = 1740996000;
  const DAY = '2025-03-03';
  const BOOT = '2025-03-02T09:00:00';
  const NOW = '2025-03-03T12:10:00';
  const tsAt = (base: number, offset: number) => (base + offset).toFixed(6);
  // The dates this suite plays are recorded through addPlacement, the legacy write path, so the
  // random-era stamp is seeded rather than written. A real random-era day is stamped by addEntry.
  const RANDOM_ERA = { '2025-03-03': 'random', '2025-03-04': 'random', '2025-03-07': 'random' };
  const inRandomEra = <T,>(fn: (store: Store) => T, seed: any = {}) =>
    withStoreAt(BOOT, NOW, fn, { ...seed, scoring: { ...RANDOM_ERA, ...(seed.scoring || {}) } });

  it('assigns each entrant a unique 1..n score, highest first, and never re-rolls', () =>
    inRandomEra((db) => {
      const d = DAY;
      const users = ['U1', 'U2', 'U3', 'U4', 'U5'];
      users.forEach((u, i) => db.addPlacement(d, 'boom', u, { ts: tsAt(BASE, i), channel_id: 'C1' }));

      expect(db.isResolved(d, 'boom')).toBe(false);
      expect(db.entrants(d, 'boom').map((e) => e.user_id)).toEqual(users);

      const awards = db.resolveGame(d, 'boom');
      expect(db.isResolved(d, 'boom')).toBe(true);
      // n = 5 entrants → the amounts are exactly 5,4,3,2,1, one each
      expect(awards.map((a) => a.points)).toEqual([5, 4, 3, 2, 1]);
      expect(new Set(awards.map((a) => a.user_id))).toEqual(new Set(users));
      // Each award keeps the entry message it belongs to, for medal reactions
      expect(awards.every((a) => a.channel_id === 'C1' && a.message_ts)).toBe(true);

      // Resolution is final: a second call returns the stored assignment untouched
      expect(db.resolveGame(d, 'boom')).toEqual(awards);
      expect(db.getAwards(d, 'boom')).toEqual(awards);

      // Weekly totals score the settled awards
      const totals = new Map(db.weeklyTotals('2025-03-03', '2025-03-07').map((r) => [r.user_id, r.points]));
      for (const a of awards) expect(totals.get(a.user_id)).toBe(a.points);
    }));

  it('scores one entrant a single point, and settles an unplayed game empty', () =>
    inRandomEra((db) => {
      const d = DAY;
      db.addPlacement(d, 'boom', 'U1', { ts: tsAt(BASE, 0), channel_id: 'C1' });
      expect(db.resolveGame(d, 'boom').map((a) => a.points)).toEqual([1]);

      // While the window is still open, a game nobody entered stays unresolved…
      expect(db.resolveGame(d, 'hadeda', Math.random, windowClosesAtMs(d) - 1)).toEqual([]);
      expect(db.isResolved(d, 'hadeda')).toBe(false);

      // …and settles empty once the window is past settling, so the day can still announce.
      expect(db.resolveGame(d, 'hadeda')).toEqual([]);
      expect(db.isResolved(d, 'hadeda')).toBe(true);
    }));

  it('entryFor returns the entry a user already has for that day and game', () =>
    inRandomEra((db) => {
      const d = DAY;
      expect(db.entryFor(d, 'boom', 'UA')).toBeNull();

      const ts = tsAt(BASE, 0);
      db.addPlacement(d, 'boom', 'UA', { ts: ts, channel_id: 'C1' });
      expect(db.entryFor(d, 'boom', 'UA')).toMatchObject({ user_id: 'UA', message_ts: ts, channel_id: 'C1' });
      // Scoped per game, per user, per day
      expect(db.entryFor(d, 'hadeda', 'UA')).toBeNull();
      expect(db.entryFor(d, 'boom', 'UB')).toBeNull();
      expect(db.entryFor('2025-03-04', 'boom', 'UA')).toBeNull();
    }));

  it('addEntry records one entry per user and reports duplicates and redeliveries', () =>
    inRandomEra((db) => {
      const d = DAY;
      const first = tsAt(BASE, 1);
      const repeat = tsAt(BASE, 2);

      expect(db.addEntry(d, 'boom', 'UA', { ts: first, channel_id: 'C1' })).toBe('recorded');
      // A second post from the same user changes nothing at all
      expect(db.addEntry(d, 'boom', 'UA', { ts: repeat, channel_id: 'C1' })).toBe('duplicate');
      // The same message again is a Slack retry, not a repeat post
      expect(db.addEntry(d, 'boom', 'UA', { ts: first, channel_id: 'C1' })).toBe('redelivery');
      expect(db.addEntry(d, 'boom', 'UB', { ts: tsAt(BASE, 3), channel_id: 'C1' })).toBe('recorded');
      // Same user, different game: a fresh entry
      expect(db.addEntry(d, 'hadeda', 'UA', { ts: tsAt(BASE, 4), channel_id: 'C1' })).toBe('recorded');

      // counts equals the entrant count, and only accepted entries are stored
      expect(db.getCounts(d).boom).toBe(2);
      expect(db.getCounts(d).hadeda).toBe(1);
      expect(db.entrants(d, 'boom').map((e) => e.message_ts)).toEqual([first, tsAt(BASE, 3)]);
      expect(db.resolveGame(d, 'boom').map((a) => a.points).sort()).toEqual([1, 2]);
    }));

  it('counts each user once, using their earliest entry message', () =>
    inRandomEra((db) => {
      const d = DAY;
      db.addPlacement(d, 'boom', 'UA', { ts: tsAt(BASE, 0.3), channel_id: 'C1' });
      db.addPlacement(d, 'boom', 'UA', { ts: tsAt(BASE, 0.1), channel_id: 'C1' }); // earlier re-post
      db.addPlacement(d, 'boom', 'UB', { ts: tsAt(BASE, 0.2), channel_id: 'C1' });

      const awards = db.resolveGame(d, 'boom');
      expect(awards.length).toBe(2);
      expect(awards.map((a) => a.points).sort()).toEqual([1, 2]);
      expect(awards.find((a) => a.user_id === 'UA')!.message_ts).toBe(tsAt(BASE, 0.1));
    }));

  it('holds the window fixed at 12:00-12:05 whatever the entries look like', () =>
    inRandomEra((db) => {
      const d = DAY;
      // The window does not move to meet the first entry, and does not stretch for a late one.
      expect(windowOpensAtMs(d)).toBe(BASE * 1000);
      expect(windowClosesAtMs(d)).toBe(BASE * 1000 + 5 * 60 * 1000);
      expect(windowSettlesAtMs(d)).toBe(windowClosesAtMs(d) + 5 * 1000);

      db.addPlacement(d, 'boom', 'U1', { ts: tsAt(BASE, 30), channel_id: 'C1' });
      expect(windowClosesAtMs(d)).toBe(BASE * 1000 + 5 * 60 * 1000);

      // A game nobody entered has exactly the same deadline as one that filled up.
      expect(windowSettlesAtMs(d)).toBe(windowClosesAtMs(d) + 5 * 1000);
    }));

  it('duePending lists every unresolved game once the window has settled', () =>
    inRandomEra((db) => {
      db.addPlacement(DAY, 'boom', 'U1', { ts: tsAt(BASE, 0), channel_id: 'C1' });
      db.addPlacement(DAY, 'boom', 'U2', { ts: tsAt(BASE, 1), channel_id: 'C1' });

      // Nothing is due while the window is open, nor during the grace period
      expect(db.duePending(windowClosesAtMs(DAY) - 1)).toEqual([]);
      expect(db.duePending(windowSettlesAtMs(DAY) - 1)).toEqual([]);

      // Past settling, the played game and the needed game nobody entered are both due
      expect(db.duePending()).toEqual([
        { date: DAY, game: 'boom', channel_id: 'C1' },
        { date: DAY, game: 'hadeda', channel_id: 'C1' },
      ]);

      db.resolveGame(DAY, 'boom');
      expect(db.duePending()).toEqual([{ date: DAY, game: 'hadeda', channel_id: 'C1' }]);
    }));

  it('duePending ignores a day nobody played, and one already announced', () =>
    inRandomEra((db) => {
      // A date with a store entry but no entrants must not settle empty games forever.
      db.entrants(DAY, 'boom');
      expect(db.duePending()).toEqual([]);

      db.addPlacement(DAY, 'boom', 'U1', { ts: tsAt(BASE, 0), channel_id: 'C1' });
      expect(db.duePending().length).toBe(2);

      // The previous build announced (and medalled) this day: it is finished
      db.markDailyAnnounced(DAY);
      expect(db.duePending()).toEqual([]);
    }));

  it('pendingMedals lists settled games whose medals never landed', () =>
    inRandomEra((db) => {
      db.addPlacement(DAY, 'boom', 'U1', { ts: tsAt(BASE, 0), channel_id: 'C1' });
      db.addPlacement(DAY, 'hadeda', 'U2', { ts: tsAt(BASE, 1), channel_id: 'C1' });

      // Unsettled games owe nothing yet
      expect(db.pendingMedals()).toEqual([]);

      // Awards are flushed before the reactions are sent, so a settled game owes medals until
      // they are explicitly marked — otherwise a crash in between loses them.
      db.resolveGame(DAY, 'boom');
      db.resolveGame(DAY, 'hadeda');
      expect(db.hasMedalled(DAY, 'boom')).toBe(false);
      expect(db.pendingMedals()).toEqual([
        { date: DAY, game: 'boom' },
        { date: DAY, game: 'hadeda' },
      ]);

      db.markMedalled(DAY, 'boom');
      expect(db.hasMedalled(DAY, 'boom')).toBe(true);
      expect(db.pendingMedals()).toEqual([{ date: DAY, game: 'hadeda' }]);

      db.markMedalled(DAY, 'hadeda');
      expect(db.pendingMedals()).toEqual([]);

      // Stale failures are not medalled days later
      db.addPlacement(DAY, 'wednesday', 'U3', { ts: tsAt(BASE, 2), channel_id: 'C1' });
      db.resolveGame(DAY, 'wednesday');
      expect(db.pendingMedals()).toEqual([{ date: DAY, game: 'wednesday' }]);
      const daysLater = DateTime.fromISO('2025-03-08T09:00:00', { zone: ZONE }).toMillis();
      expect(db.pendingMedals(daysLater)).toEqual([]);
    }));

  it('pendingAnnouncements lists settled days that still owe a results post or a crown', () =>
    withStoreAt('2025-03-06T09:00:00', '2025-03-07T12:10:00', (db) => {
      const friday = '2025-03-07';
      const fridayBase = BASE + 4 * 24 * 60 * 60; // same 12:00:00 wall clock, four days later
      db.addPlacement(friday, 'boom', 'U1', { ts: tsAt(fridayBase, 0), channel_id: 'C1' });
      db.addPlacement(friday, 'hadeda', 'U2', { ts: tsAt(fridayBase, 1), channel_id: 'C1' });

      // Not every game has settled yet
      db.resolveGame(friday, 'boom');
      expect(db.pendingAnnouncements()).toEqual([]);

      // Fully settled and unannounced: the results post is owed
      db.resolveGame(friday, 'hadeda');
      expect(db.pendingAnnouncements()).toEqual([friday]);

      // Results posted, but the Friday crown is still owed
      db.markDailyAnnounced(friday);
      expect(db.pendingAnnouncements()).toEqual([friday]);

      // Stale failures are not resurrected days later
      const daysLater = DateTime.fromISO('2025-03-12T09:00:00', { zone: ZONE }).toMillis();
      expect(db.pendingAnnouncements(daysLater)).toEqual([]);

      // Both done
      db.markCrowned('2025-W10');
      expect(db.pendingAnnouncements()).toEqual([]);
    }, { scoring: { '2025-03-07': 'random' } }));

  it('scores a day recorded through the random entry path', () =>
    withStoreAt('2025-03-03T09:00:00', '2025-03-03T12:30:00', (db) => {
      db.addEntry('2025-03-03', 'boom', 'U1', { ts: tsAt(BASE, 0), channel_id: 'C1' });
      db.addEntry('2025-03-03', 'boom', 'U2', { ts: tsAt(BASE, 1), channel_id: 'C1' });
      expect(db.isRandomEra('2025-03-03')).toBe(true);

      expect(db.resolveGame('2025-03-03', 'boom').map((a) => a.points).sort()).toEqual([1, 2]);
      expect(db.isResolved('2025-03-03', 'boom')).toBe(true);
    }));

  it('picks up entries already recorded when it boots mid-window', () =>
    // Deploying at 12:03 onto a day people are already playing: those entries are in the ledger
    // and must land in the tally rather than being stranded in the legacy era.
    withStoreAt('2025-03-03T12:03:00', '2025-03-03T12:10:00', (db) => {
      expect(db.isRandomEra('2025-03-03')).toBe(true);
      expect(db.entrants('2025-03-03', 'boom').map((e) => e.user_id)).toEqual(['U1', 'U2']);
      expect(db.resolveGame('2025-03-03', 'boom').map((a) => a.user_id).sort()).toEqual(['U1', 'U2']);
    }, {
      placements: { '2025-03-03': { boom: ['U1', 'U2'], hadeda: [], wednesday: [] } },
      counts: {}, daily_announced: {}, weekly_crowned: {}, weekly_kings: {},
      scoring: { '2025-03-03': 'random' },
      messages: {
        '2025-03-03': {
          boom: [
            { user_id: 'U1', channel_id: 'C1', message_ts: tsAt(BASE, 0), created_at: '2025-03-03T12:00:00' },
            { user_id: 'U2', channel_id: 'C1', message_ts: tsAt(BASE, 1), created_at: '2025-03-03T12:00:01' },
          ],
          hadeda: [], wednesday: [],
        },
      },
    }));

  it('keeps legacy 3-2-1 scoring for a date recorded through the podium path', () =>
    withStore((db) => {
      const legacy = '2025-03-03';
      db.addPlacement(legacy, 'boom', 'U1', { ts: tsAt(BASE, 0), channel_id: 'C1' });
      db.addPlacement(legacy, 'boom', 'U2', { ts: tsAt(BASE, 1), channel_id: 'C1' });
      db.addPlacement(legacy, 'boom', 'U3', { ts: tsAt(BASE, 2), channel_id: 'C1' });
      const legacyTotals = new Map(db.weeklyTotals(legacy, legacy).map((r) => [r.user_id, r.points]));
      expect(legacyTotals.get('U1')).toBe(3);
      expect(legacyTotals.get('U2')).toBe(2);
      expect(legacyTotals.get('U3')).toBe(1);

      // Nothing pre-cutover is ever re-settled with random points
      expect(db.duePending().length).toBe(0);
      expect(db.resolveGame(legacy, 'boom')).toEqual([]);
    }));

  it('scores nothing for a random-era game until its window settles', () =>
    inRandomEra((db) => {
      db.addPlacement(DAY, 'boom', 'U9', { ts: tsAt(BASE, 0), channel_id: 'C1' });

      // Recorded, but provisional points must never leak into the leaderboard
      expect(db.weeklyTotals(DAY, DAY)).toEqual([]);

      db.resolveGame(DAY, 'boom');
      expect(db.weeklyTotals(DAY, DAY)).toEqual([{ user_id: 'U9', points: 1 }]);
    }));
});
describe('scoring mode stamp', () => {
  const BASE = 1740996000;
  const tsAt = (base: number, offset: number) => `${base + offset}.000001`;

  it('stamps a random entry random and a legacy placement legacy', () =>
    withStore((db) => {
      db.addEntry('2026-09-07', 'boom', 'U1', { ts: tsAt(BASE, 0), channel_id: 'C1' });
      db.addPlacement('2026-09-08', 'boom', 'U1', { ts: tsAt(BASE, 1), channel_id: 'C1' });
      expect(db.scoringFor('2026-09-07')).toBe('random');
      expect(db.scoringFor('2026-09-08')).toBe('legacy');
    }));

  it('never re-stamps a date that is already stamped', () =>
    withStore((db) => {
      db.addEntry('2026-09-07', 'boom', 'U1', { ts: tsAt(BASE, 0), channel_id: 'C1' });
      db.addPlacement('2026-09-07', 'boom', 'U2', { ts: tsAt(BASE, 1), channel_id: 'C1' });
      expect(db.scoringFor('2026-09-07')).toBe('random');
    }));

  it('treats an unwritten date as legacy', () =>
    withStore((db) => {
      expect(db.scoringFor('2026-09-07')).toBe('legacy');
    }));

  it('reads random_scoring_from for dates written by the previous build', () =>
    withStoreAt('2026-09-04T09:00:00', '2026-09-04T09:00:00', (db) => {
      expect(db.scoringFor('2026-09-02')).toBe('random');
      expect(db.scoringFor('2026-08-31')).toBe('legacy');
    }, {
      placements: {}, counts: {}, daily_announced: {}, weekly_crowned: {},
      weekly_kings: {}, messages: {}, random_scoring_from: '2026-09-01',
    }));

  it('does not stamp a date that was only read', () =>
    withStore((db) => {
      db.entrants('2026-09-07', 'boom');
      db.getCounts('2026-09-07');
      expect(db.scoringFor('2026-09-07')).toBe('legacy');
    }));
});
