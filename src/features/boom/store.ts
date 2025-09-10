import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DateTime } from 'luxon';
import type { Game } from './rules.js';

type Winner = { user_id: string; channel_id: string; message_ts: string; created_at: string };

type StoreData = {
  // Legacy podium placements (arrival-ordered unique users). Kept for backward compatibility.
  placements: Record<string, Record<Game, string[]>>;
  // Counts of valid posts in the noon window, per date+game
  counts: Record<string, Record<Game, number>>;
  // Daily announcement/crown markers
  daily_announced: Record<string, string>;
  weekly_crowned: Record<string, string>;
  // Crown details per ISO week (persisted winners + points)
  weekly_kings?: Record<string, { winners: string[]; points: number; crowned_at: string }>;
  // Optional per-week baseline adjustments
  weekly_adjustments?: Record<string, Record<string, number>>;

  // New: raw messages captured to derive podiums by earliest timestamp (ts), not arrival order.
  // date -> game -> array of Winner events (may include multiple per user; earliest counts)
  messages?: Record<string, Record<Game, Winner[]>>;
};

const initialData = (): StoreData => ({
  placements: {},
  counts: {},
  daily_announced: {},
  weekly_crowned: {},
  weekly_kings: {},
  messages: {},
});

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function weekKeyForRange(startDate: string, endDate: string): string {
  // Both dates are within the same ISO week (Mon–Fri). Use startDate's ISO week.
  const start = DateTime.fromISO(startDate);
  const wk = start.weekNumber.toString().padStart(2, '0');
  return `${start.year}-W${wk}`;
}

function normalizeData(raw: Partial<StoreData & Record<string, unknown>>): StoreData {
  const base = initialData();
  const data: StoreData = {
    placements: isObject(raw.placements) ? (raw.placements as Record<string, Record<Game, string[]>>) : base.placements,
    counts: isObject(raw.counts) ? (raw.counts as Record<string, Record<Game, number>>) : base.counts,
    daily_announced: isObject(raw.daily_announced) ? (raw.daily_announced as Record<string, string>) : base.daily_announced,
    weekly_crowned: isObject(raw.weekly_crowned) ? (raw.weekly_crowned as Record<string, string>) : base.weekly_crowned,
    weekly_kings: isObject((raw as any).weekly_kings)
      ? ((raw as any).weekly_kings as Record<string, { winners: string[]; points: number; crowned_at: string }>)
      : {},
    weekly_adjustments: isObject(raw.weekly_adjustments)
      ? (raw.weekly_adjustments as Record<string, Record<string, number>>)
      : undefined,
    messages: isObject((raw as any).messages)
      ? ((raw as any).messages as Record<string, Record<Game, Winner[]>>)
      : {},
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

function parseSlackTs(ts: string): number {
  // Slack ts like "1757498400.276939"
  // Use Number/parseFloat for fractional seconds; fallback to 0 on bad values.
  const n = Number(ts);
  if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  const f = parseFloat(ts);
  return Number.isNaN(f) ? 0 : f;
}

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

  private ensureDay(date: string) {
    if (!this.data.placements[date]) this.data.placements[date] = {} as any;
    if (!this.data.counts[date]) this.data.counts[date] = { boom: 0, hadeda: 0, wednesday: 0 } as any;
    if (!this.data.messages) this.data.messages = {};
    if (!this.data.messages[date]) this.data.messages[date] = { boom: [], hadeda: [], wednesday: [] } as any;
    const perGame = this.data.messages[date] as Record<Game, Winner[]>;
    if (!perGame.boom) perGame.boom = [];
    if (!perGame.hadeda) perGame.hadeda = [];
    if (!perGame.wednesday) perGame.wednesday = [];
  }

  private getMessages(date: string, game: Game): Winner[] {
    const mg = this.data.messages?.[date]?.[game];
    return Array.isArray(mg) ? mg : [];
  }

  private computePodiumFromMessages(date: string, game: Game): string[] {
    const msgs = this.getMessages(date, game);
    if (!msgs.length) return [];
    // Map user -> earliest ts
    const earliest = new Map<string, { tsNum: number; tsStr: string }>();
    for (const m of msgs) {
      const t = parseSlackTs(m.message_ts);
      const cur = earliest.get(m.user_id);
      if (!cur || t < cur.tsNum || (t === cur.tsNum && m.message_ts < cur.tsStr)) {
        earliest.set(m.user_id, { tsNum: t, tsStr: m.message_ts });
      }
    }
    const ordered = Array.from(earliest.entries())
      .sort((a, b) => {
        if (a[1].tsNum !== b[1].tsNum) return a[1].tsNum - b[1].tsNum;
        // Tie-break deterministically by tsStr then user_id
        if (a[1].tsStr !== b[1].tsStr) return a[1].tsStr < b[1].tsStr ? -1 : 1;
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      })
      .map(([uid]) => uid);
    return ordered.slice(0, 3);
  }

  private computePodium(date: string, game: Game): string[] {
    // Prefer messages (timestamp-true). Fall back to legacy placements if no messages present.
    const msgs = this.getMessages(date, game);
    if (msgs.length) return this.computePodiumFromMessages(date, game);

    // Legacy fallback: use persisted arrival-order unique users
    const arr = (this.data.placements[date] as any)?.[game] as string[] | undefined;
    return arr ? arr.slice(0, 3) : [];
  }

  incrementCount(date: string, game: Game): number {
    this.ensureDay(date);
    const c = this.data.counts[date][game] || 0;
    this.data.counts[date][game] = c + 1;
    this.flush();
    return this.data.counts[date][game];
  }

  getCounts(date: string): Record<Game, number> {
    this.ensureDay(date);
    return { ...this.data.counts[date] } as any;
  }

  placementsCount(date: string, game: Game): number {
    this.ensureDay(date);
    return this.computePodium(date, game).length;
  }

  /**
   * Record a valid game message and return the user's podium position (1..3) if this
   * specific message is their earliest and lands in the top 3 by timestamp.
   * Returns 0 if not on podium or this message is not the user's earliest.
   *
   * Note: ts and channel_id should be Slack-provided strings. If omitted (legacy),
   * the method will update legacy placements and return position by arrival order.
   */
  addPlacement(date: string, game: Game, user: string, ts?: string, channel_id?: string): number {
    this.ensureDay(date);

    // If ts missing, fall back to legacy behavior (arrival-ordered)
    if (!ts) {
      const p = (this.data.placements[date] as any)[game] as string[] | undefined;
      const arr = p ? [...p] : [];
      if (arr.includes(user)) return 0; // already placed
      if (arr.length >= 3) return 0; // podium filled
      arr.push(user);
      (this.data.placements[date] as any)[game] = arr;
      this.flush();
      return arr.length; // position (1..3)
    }

    // Timestamp-based storage and computation
    const msg: Winner = {
      user_id: user,
      channel_id: channel_id || '',
      message_ts: ts,
      created_at: DateTime.now().toISO()!,
    };

    // Deduplicate exact same (user, ts) to avoid duplicates on retries
    const arr = this.getMessages(date, game);
    const exists = arr.some((w) => w.user_id === user && w.message_ts === ts);
    if (!exists) {
      (this.data.messages as any)[date][game] = [...arr, msg];
      this.flush();
    }

    // Determine if this message is the user's earliest
    const all = this.getMessages(date, game);
    let earliestTsForUser = null as null | string;
    for (const w of all) {
      if (w.user_id !== user) continue;
      if (earliestTsForUser == null) earliestTsForUser = w.message_ts;
      else {
        const cur = parseSlackTs(earliestTsForUser);
        const cand = parseSlackTs(w.message_ts);
        if (cand < cur || (cand === cur && w.message_ts < earliestTsForUser)) {
          earliestTsForUser = w.message_ts;
        }
      }
    }

    const podium = this.computePodium(date, game);
    const idx = podium.indexOf(user);

    // Only award a position if:
    // - the user is currently on podium (idx != -1)
    // - and this message is the user's earliest for the day/game (to avoid awarding on later duplicates)
    if (idx !== -1 && earliestTsForUser === ts) {
      return idx + 1;
    }
    return 0;
  }

  getPlacements(date: string, game: Game): string[] {
    this.ensureDay(date);
    return this.computePodium(date, game);
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

  // Persist crowned king(s) for the given ISO week.
  // winners may include multiple user_ids in case of a tie; points are the shared winning points.
  // crowned_at is enforced to be strictly monotonic to avoid equality ties within the same millisecond.
  setCrown(weekKey: string, winners: string[], points: number) {
    if (!this.data.weekly_kings) this.data.weekly_kings = {};

    // Determine max existing crown time (ms)
    let maxMs = 0;
    for (const val of Object.values(this.data.weekly_kings)) {
      if (!val || !val.crowned_at) continue;
      const m = DateTime.fromISO(val.crowned_at).toMillis();
      if (Number.isFinite(m) && m > maxMs) maxMs = m;
    }
    let tsMs = Date.now();
    if (tsMs <= maxMs) tsMs = maxMs + 1;

    this.data.weekly_kings[weekKey] = {
      winners: [...winners],
      points,
      crowned_at: DateTime.fromMillis(tsMs).toISO()!,
    };
    this.flush();
  }

  // Returns the most recently crowned week based on crowned_at timestamp.
  getLatestCrown(): { weekKey: string; winners: string[]; points: number; crowned_at: string } | null {
    const wk = this.data.weekly_kings;
    if (!wk || !Object.keys(wk).length) return null;
    let latest: { weekKey: string; winners: string[]; points: number; crowned_at: string } | null = null;
    for (const [key, val] of Object.entries(wk)) {
      if (!val || !val.crowned_at) continue;
      if (!latest) {
        latest = { weekKey: key, ...val };
        continue;
      }
      const a = DateTime.fromISO(val.crowned_at);
      const b = DateTime.fromISO(latest.crowned_at);
      if (a > b) {
        latest = { weekKey: key, ...val };
      }
    }
    return latest;
  }

  weeklyTotals(startDate: string, endDate: string): Array<{ user_id: string; points: number }> {
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
      for (const g of ['boom', 'hadeda', 'wednesday'] as Game[]) {
        const podium = this.computePodium(date, g);
        if (!podium.length) continue;
        const weights = [5, 3, 1];
        podium.forEach((uid, idx) => {
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
