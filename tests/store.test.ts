import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DateTime } from 'luxon';
import { Store } from '../src/features/boom/store.ts';

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
      db.addPlacement(d, 'boom', 'U1', '1757498400.276939', 'C1'); // later
      db.addPlacement(d, 'boom', 'U2', '1757498400.275209', 'C1'); // earlier
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
        db.addPlacement(d, 'boom', 'JESSE', next(), 'C1');
        db.addPlacement(d, 'boom', 'Z', next(), 'C1');
      }
      // Friday: Z sweeps 1st across all three games (+9) while JESSE does not place.
      // Z = 8 + 9 = 17 overtakes JESSE = 12.
      db.addPlacement('2025-03-07', 'boom', 'Z', next(), 'C1');
      db.addPlacement('2025-03-07', 'hadeda', 'Z', next(), 'C1');
      db.addPlacement('2025-03-07', 'wednesday', 'Z', next(), 'C1');

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
      db.addPlacement('2025-03-03', 'boom', 'A', next(), 'C1');
      db.addPlacement('2025-03-03', 'hadeda', 'B', next(), 'C1');

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
      db.addPlacement('2025-03-03', 'boom', 'WINNER', next(), 'C1');

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
      db.addPlacement('2025-03-03', 'boom', 'WINNER', next(), 'C1');

      // Query from 2025-02-24 (W09). Previous weeks W08..W01 (Dec 2024) hold no data.
      expect(db.latestCompletedWeekWinner('2025-02-24')).toBeNull();
    }));
});

describe('Store random point assignment', () => {
  const tsAt = (base: number, offset: number) => (base + offset).toFixed(6);

  it('assigns each entrant a unique 1..n score, highest first, and never re-rolls', () =>
    withStore((db) => {
      const d = '2025-03-03';
      const users = ['U1', 'U2', 'U3', 'U4', 'U5'];
      users.forEach((u, i) => db.addPlacement(d, 'boom', u, tsAt(1740999600, i), 'C1'));

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

  it('scores one entrant a single point and no entrants at all', () =>
    withStore((db) => {
      const d = '2025-03-03';
      db.addPlacement(d, 'boom', 'U1', tsAt(1740999600, 0), 'C1');
      expect(db.resolveGame(d, 'boom').map((a) => a.points)).toEqual([1]);

      // A game nobody entered stays unresolved rather than settling empty
      expect(db.resolveGame(d, 'hadeda')).toEqual([]);
      expect(db.isResolved(d, 'hadeda')).toBe(false);
    }));

  it('entryFor returns the entry a user already has for that day and game', () =>
    withStore((db) => {
      const d = '2025-03-03';
      expect(db.entryFor(d, 'boom', 'UA')).toBeNull();

      const ts = tsAt(1740999600, 0);
      db.addPlacement(d, 'boom', 'UA', ts, 'C1');
      expect(db.entryFor(d, 'boom', 'UA')).toMatchObject({ user_id: 'UA', message_ts: ts, channel_id: 'C1' });
      // Scoped per game, per user, per day
      expect(db.entryFor(d, 'hadeda', 'UA')).toBeNull();
      expect(db.entryFor(d, 'boom', 'UB')).toBeNull();
      expect(db.entryFor('2025-03-04', 'boom', 'UA')).toBeNull();
    }));

  it('counts each user once, using their earliest entry message', () =>
    withStore((db) => {
      const d = '2025-03-03';
      db.addPlacement(d, 'boom', 'UA', tsAt(1740999600, 0.3), 'C1');
      db.addPlacement(d, 'boom', 'UA', tsAt(1740999600, 0.1), 'C1'); // earlier re-post
      db.addPlacement(d, 'boom', 'UB', tsAt(1740999600, 0.2), 'C1');

      const awards = db.resolveGame(d, 'boom');
      expect(awards.length).toBe(2);
      expect(awards.map((a) => a.points).sort()).toEqual([1, 2]);
      expect(awards.find((a) => a.user_id === 'UA')!.message_ts).toBe(tsAt(1740999600, 0.1));
    }));

  it('anchors the tally window on the earliest entry', () =>
    withStore((db) => {
      const d = '2025-03-03';
      const opened = 1740999600;
      db.addPlacement(d, 'boom', 'U1', tsAt(opened, 30), 'C1');
      expect(db.windowClosesAtMs(d, 'boom')).toBe((opened + 30) * 1000 + 5 * 60 * 1000);

      // An out-of-order earlier entry moves the window back to the true first entry
      db.addPlacement(d, 'boom', 'U2', tsAt(opened, 0), 'C1');
      expect(db.windowOpenedAtMs(d, 'boom')).toBe(opened * 1000);
      expect(db.windowClosesAtMs(d, 'boom')).toBe(opened * 1000 + 5 * 60 * 1000);

      expect(db.windowOpenedAtMs(d, 'hadeda')).toBeNull();
      expect(db.windowClosesAtMs(d, 'hadeda')).toBeNull();
    }));

  it('duePending lists closed-but-unsettled games only', () =>
    withStore((db) => {
      const now = DateTime.now().setZone(ZONE);
      const date = now.toISODate()!;
      const nowSec = now.toSeconds();

      // Opened 10 minutes ago → its 5-minute window has closed
      db.addPlacement(date, 'boom', 'U1', tsAt(nowSec, -600), 'C1');
      db.addPlacement(date, 'boom', 'U2', tsAt(nowSec, -599), 'C1');
      // Opened seconds ago → still collecting
      db.addPlacement(date, 'hadeda', 'U1', tsAt(nowSec, -5), 'C2');

      expect(db.duePending()).toEqual([{ date, game: 'boom', channel_id: 'C1' }]);

      db.resolveGame(date, 'boom');
      expect(db.duePending()).toEqual([]);
    }));

  it('keeps legacy 3-2-1 scoring for dates before the random-scoring cutover', () =>
    withStore((db) => {
      // The cutover is stamped on first construction, so these 2025 dates are pre-cutover.
      const legacy = '2025-03-03';
      db.addPlacement(legacy, 'boom', 'U1', '1740999600.000000', 'C1');
      db.addPlacement(legacy, 'boom', 'U2', '1740999601.000000', 'C1');
      db.addPlacement(legacy, 'boom', 'U3', '1740999602.000000', 'C1');
      const legacyTotals = new Map(db.weeklyTotals(legacy, legacy).map((r) => [r.user_id, r.points]));
      expect(legacyTotals.get('U1')).toBe(3);
      expect(legacyTotals.get('U2')).toBe(2);
      expect(legacyTotals.get('U3')).toBe(1);

      // Nothing pre-cutover is ever re-settled with random points
      expect(db.duePending().length).toBe(0);
    }));

  it('scores nothing for a random-era game until its window settles', () =>
    withStore((db) => {
      const now = DateTime.now().setZone(ZONE);
      const date = now.toISODate()!;
      db.addPlacement(date, 'boom', 'U9', now.toSeconds().toFixed(6), 'C1');

      // Recorded, but provisional points must never leak into the leaderboard
      expect(db.weeklyTotals(date, date)).toEqual([]);

      db.resolveGame(date, 'boom');
      expect(db.weeklyTotals(date, date)).toEqual([{ user_id: 'U9', points: 1 }]);
    }));
});