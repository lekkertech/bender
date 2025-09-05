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

  it('weeklyTotals computes 5-3-1 across days in week', () =>
    withStore((db) => {
      // Two dates in the same ISO week (Mon-Fri)
      const d1 = '2025-03-03'; // Mon
      const d2 = '2025-03-04'; // Tue
      // Monday placements
      db.addPlacement(d1, 'boom', 'U1'); // +5
      db.addPlacement(d1, 'boom', 'U2'); // +3
      db.addPlacement(d1, 'boom', 'U3'); // +1
      db.addPlacement(d1, 'hadeda', 'U2'); // +5
      db.addPlacement(d1, 'hadeda', 'U3'); // +3
      db.addPlacement(d1, 'hadeda', 'U4'); // +1
      // Tuesday placements
      db.addPlacement(d2, 'wednesday', 'U1'); // +5
      db.addPlacement(d2, 'wednesday', 'U4'); // +3
      db.addPlacement(d2, 'wednesday', 'U5'); // +1

      const totals = db.weeklyTotals('2025-03-03', '2025-03-07');
      const map = new Map(totals.map((r) => [r.user_id, r.points]));
      expect(map.get('U1')).toBe(10); // 5 (Mon boom 1st) + 5 (Tue wed 1st)
      expect(map.get('U2')).toBe(8);  // 3 (Mon boom 2nd) + 5 (Mon hadeda 1st)
      expect(map.get('U3')).toBe(4);  // 1 (Mon boom 3rd) + 3 (Mon hadeda 2nd)
      expect(map.get('U4')).toBe(4);  // 1 (Mon hadeda 3rd) + 3 (Tue wed 2nd)
      expect(map.get('U5')).toBe(1);  // 1 (Tue wed 3rd)
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
});