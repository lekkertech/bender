import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/features/boom/store.ts';

describe('flipping BOOM_SCORING', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'flip-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('keeps a settled random day intact and scores a legacy day beside it', () => {
    const file = join(dir, 'store.json');

    const random = new Store(file);
    random.addEntry('2026-09-07', 'boom', 'U1', { ts: '1757239261.000001', channel_id: 'C1' });
    random.addEntry('2026-09-07', 'boom', 'U2', { ts: '1757239262.000001', channel_id: 'C1' });
    random.resolveGame('2026-09-07', 'boom', () => 0.5, Date.parse('2026-09-07T12:10:00+02:00'));
    const settled = JSON.stringify(random.getAwards('2026-09-07', 'boom'));

    const legacy = new Store(file);
    legacy.addPlacement('2026-09-09', 'boom', 'U1', { ts: '1757412061.000001', channel_id: 'C1' });
    legacy.addPlacement('2026-09-09', 'boom', 'U2', { ts: '1757412062.000001', channel_id: 'C1' });

    expect(JSON.stringify(legacy.getAwards('2026-09-07', 'boom'))).toBe(settled);
    expect(legacy.scoringFor('2026-09-07')).toBe('random');
    expect(legacy.scoringFor('2026-09-09')).toBe('legacy');

    const totals = new Map(legacy.weeklyTotals('2026-09-07', '2026-09-11').map((r) => [r.user_id, r.points]));
    // Monday's random award plus Wednesday's 3-2-1, each under its own rules.
    expect(totals.get('U1')).toBe(legacy.getAwards('2026-09-07', 'boom').find((a) => a.user_id === 'U1')!.points + 3);
    expect(totals.get('U2')).toBe(legacy.getAwards('2026-09-07', 'boom').find((a) => a.user_id === 'U2')!.points + 2);

    expect(JSON.parse(readFileSync(file, 'utf8')).awards['2026-09-07'].boom).toHaveLength(2);
  });

  it('never re-scores a random day when only the legacy path runs afterwards', () => {
    const file = join(dir, 'store.json');
    const random = new Store(file);
    random.addEntry('2026-09-07', 'boom', 'U1', { ts: '1757239261.000001', channel_id: 'C1' });

    const legacy = new Store(file);
    legacy.addPlacement('2026-09-07', 'boom', 'U2', { ts: '1757239262.000001', channel_id: 'C1' });
    expect(legacy.scoringFor('2026-09-07')).toBe('random');
  });
});
