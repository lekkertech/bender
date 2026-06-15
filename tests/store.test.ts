import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/features/boom/store.ts';

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