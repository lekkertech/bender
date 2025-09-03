import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DateTime } from 'luxon';
import type { Game } from './rules.js';

type Winner = { user_id: string; channel_id: string; message_ts: string; created_at: string };

type StoreData = {
  // For 5-3-1 scoring we track podium placements per date+game
  placements: Record<string, Record<Game, string[]>>; // date -> game -> [user_id1, user_id2, user_id3]
  counts: Record<string, Record<Game, number>>; // date -> game -> count (valid posts in window)
  daily_announced: Record<string, string>; // date -> ISO timestamp
  weekly_crowned: Record<string, string>; // week_key -> ISO timestamp
  weekly_adjustments?: Record<string, Record<string, number>>; // week_key -> user_id -> baseline points
};

const initialData = (): StoreData => ({
  placements: {},
  counts: {},
  daily_announced: {},
  weekly_crowned: {},
});

export class Store {
  private file: string;
  private data: StoreData;

  constructor(file = join(process.cwd(), 'data', 'store.json')) {
    this.file = file;
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoreData & Record<string, unknown>>;
        this.data = normalizeData(raw);
      } catch {
        this.data = initialData();
      }
    } else {
      this.data = initialData();
      this.flush();
    }
  }

  private flush() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  private ensureDate(date: string) {
    if (!this.data.placements[date]) this.data.placements[date] = {} as any;
    if (!this.data.counts[date]) this.data.counts[date] = { boom: 0, hadeda: 0, wednesday: 0 } as any;
  }

  incrementCount(date: string, game: Game): number {
    this.ensureDate(date);
    const c = this.data.counts[date][game] || 0;
    this.data.counts[date][game] = c + 1;
    this.flush();
    return this.data.counts[date][game];
  }

  getCounts(date: string): Record<Game, number> {
    this.ensureDate(date);
    return { ...this.data.counts[date] } as any;
  }

  placementsCount(date: string, game: Game): number {
    this.ensureDate(date);
    const arr = (this.data.placements[date] as any)[game] as string[] | undefined;
    return arr ? arr.length : 0;
  }

  addPlacement(date: string, game: Game, user: string): number {
    this.ensureDate(date);
    const p = (this.data.placements[date] as any)[game] as string[] | undefined;
    const arr = p ? [...p] : [];
    if (arr.includes(user)) return 0; // already placed
    if (arr.length >= 3) return 0; // podium filled
    arr.push(user);
    (this.data.placements[date] as any)[game] = arr;
    this.flush();
    return arr.length; // position (1..3)
  }

  getPlacements(date: string, game: Game): string[] {
    this.ensureDate(date);
    const arr = (this.data.placements[date] as any)[game] as string[] | undefined;
    return arr ? [...arr] : [];
  }

  markDailyAnnounced(date: string) {
    this.data.daily_announced[date] = DateTime.now().toISO();
    this.flush();
  }

  hasDailyAnnounced(date: string): boolean {
    return !!this.data.daily_announced[date];
  }

  hasCrowned(weekKey: string): boolean {
    return !!this.data.weekly_crowned[weekKey];
  }

  markCrowned(weekKey: string) {
    this.data.weekly_crowned[weekKey] = DateTime.now().toISO();
    this.flush();
  }

  weeklyTotals(startDate: string, endDate: string): Array<{ user_id: string; points: number }>{
    const res = new Map<string, number>();
    // Seed baselines if present for the week
    const weekKey = weekKeyForRange(startDate, endDate);
    const baselines = this.data.weekly_adjustments?.[weekKey] || {};
    for (const [user, pts] of Object.entries(baselines)) {
      res.set(user, pts);
    }
    // Iterate all wins in the date range
    let d = DateTime.fromISO(startDate);
    const end = DateTime.fromISO(endDate);
    for (; d <= end; d = d.plus({ days: 1 })) {
      const date = d.toISODate()!;
      const placements = this.data.placements[date];
      if (!placements) continue;
      for (const g of ['boom', 'hadeda', 'wednesday'] as Game[]) {
        const arr = (placements as any)[g] as string[] | undefined;
        if (!arr) continue;
        const weights = [5, 3, 1];
        arr.forEach((uid, idx) => {
          const pts = weights[idx] || 0;
          if (pts > 0) res.set(uid, (res.get(uid) || 0) + pts);
        });
      }
    }
    return Array.from(res.entries())
      .map(([user_id, points]) => ({ user_id, points }))
      .sort((a, b) => (b.points - a.points) || a.user_id.localeCompare(b.user_id));
  }
}

function weekKeyForRange(startDate: string, endDate: string): string {
  // Both dates are within the same ISO week (Mon–Fri). Use startDate's ISO week.
  const start = DateTime.fromISO(startDate);
  const wk = start.weekNumber.toString().padStart(2, '0');
  return `${start.year}-W${wk}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeData(raw: Partial<StoreData & Record<string, unknown>>): StoreData {
  const base = initialData();
  const data: StoreData = {
    placements: isObject(raw.placements) ? (raw.placements as Record<string, Record<Game, string[]>>) : base.placements,
    counts: isObject(raw.counts) ? (raw.counts as Record<string, Record<Game, number>>) : base.counts,
    daily_announced: isObject(raw.daily_announced) ? (raw.daily_announced as Record<string, string>) : base.daily_announced,
    weekly_crowned: isObject(raw.weekly_crowned) ? (raw.weekly_crowned as Record<string, string>) : base.weekly_crowned,
    weekly_adjustments: isObject(raw.weekly_adjustments)
      ? (raw.weekly_adjustments as Record<string, Record<string, number>>)
      : undefined,
  };
  // Backward-compat: if legacy 'wins' exists, try to populate placements structure shallowly
  const wins = (raw as any)?.wins;
  if (isObject(wins)) {
    for (const [date, perGame] of Object.entries(wins)) {
      if (!isObject(perGame)) continue;
      const p: Record<string, string[]> = (data.placements[date] ||= {} as any);
      for (const [game, users] of Object.entries(perGame)) {
        if (Array.isArray(users)) p[game] = users as string[];
      }
    }
  }
  return data;
}
