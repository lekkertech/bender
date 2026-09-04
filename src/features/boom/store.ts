import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DateTime } from 'luxon';
import type { Scoring } from '../../env.js';
import {
  assignRandomPoints,
  GAMES,
  isFriday,
  neededGamesForDate,
  windowSettlesAtMs,
  PODIUM_WEIGHTS,
  TZ,
  weekKeyFor,
  weekStartEnd,
  type Game,
} from './rules.js';

type Winner = { user_id: string; channel_id: string; message_ts: string; created_at: string };

/** A settled point award for one entrant, assigned when the game's entry window closed. */
export type Award = {
  user_id: string;
  points: number;
  channel_id: string;
  message_ts: string;
  awarded_at: string;
};

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

  // Settled point awards per date+game, written once when the game's entry window closes.
  // Presence of an array for date+game means that game is resolved and immutable.
  awards?: Record<string, Partial<Record<Game, Award[]>>>;

  // When medal reactions were applied per date+game. Separate from `awards` because the awards are
  // flushed before the reactions are sent: without this, a crash in between loses the medals.
  medalled?: Record<string, Partial<Record<Game, string>>>;

  // Read-only remnant of the previous build's one-way cutover. Dates it covers that carry no
  // `scoring` stamp are resolved through it; nothing writes it any more.
  random_scoring_from?: string;

  // Which mechanism scored each date, stamped by the write path that recorded the first play.
  scoring?: Record<string, Scoring>;
};

const initialData = (): StoreData => ({
  placements: {},
  counts: {},
  daily_announced: {},
  weekly_crowned: {},
  weekly_kings: {},
  messages: {},
  awards: {},
  medalled: {},
  scoring: {},
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
    awards: isObject((raw as any).awards)
      ? ((raw as any).awards as Record<string, Partial<Record<Game, Award[]>>>)
      : {},
    medalled: isObject((raw as any).medalled)
      ? ((raw as any).medalled as Record<string, Partial<Record<Game, string>>>)
      : {},
    random_scoring_from:
      typeof (raw as any).random_scoring_from === 'string' ? ((raw as any).random_scoring_from as string) : undefined,
    scoring: isObject((raw as any).scoring) ? ((raw as any).scoring as Record<string, Scoring>) : {},
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

/** How far back a failed results post, crown post or medal reaction is still retried. */
const RETRY_DAYS = 2;

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
    this.stampScoring(date, 'legacy');
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

  /** One message per unique user (their earliest), sorted by ts ascending. */
  private earliestMessagesByUser(date: string, game: Game): Winner[] {
    const msgs = this.getMessages(date, game);
    if (!msgs.length) return [];
    const earliestByUser = new Map<string, Winner>();
    for (const m of msgs) {
      const cur = earliestByUser.get(m.user_id);
      if (!cur) {
        earliestByUser.set(m.user_id, m);
        continue;
      }
      const curT = parseSlackTs(cur.message_ts);
      const newT = parseSlackTs(m.message_ts);
      if (newT < curT || (newT === curT && m.message_ts < cur.message_ts)) {
        earliestByUser.set(m.user_id, m);
      }
    }
    return Array.from(earliestByUser.values()).sort((a, b) => {
      const at = parseSlackTs(a.message_ts);
      const bt = parseSlackTs(b.message_ts);
      if (at !== bt) return at - bt;
      if (a.message_ts !== b.message_ts) return a.message_ts < b.message_ts ? -1 : 1;
      return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
    });
  }


  /** Top-3 podium messages (earliest per user, sorted by ts) for reaction targeting. */
  getPodiumMessages(date: string, game: Game): Winner[] {
    this.ensureDay(date);
    const msgs = this.getMessages(date, game);
    if (!msgs.length) return [];
    const earliestByUser = new Map<string, Winner>();
    for (const m of msgs) {
      const cur = earliestByUser.get(m.user_id);
      if (!cur) {
        earliestByUser.set(m.user_id, m);
        continue;
      }
      const curT = parseSlackTs(cur.message_ts);
      const newT = parseSlackTs(m.message_ts);
      if (newT < curT || (newT === curT && m.message_ts < cur.message_ts)) {
        earliestByUser.set(m.user_id, m);
      }
    }
    return Array.from(earliestByUser.values())
      .sort((a, b) => {
        const at = parseSlackTs(a.message_ts);
        const bt = parseSlackTs(b.message_ts);
        if (at !== bt) return at - bt;
        if (a.message_ts !== b.message_ts) return a.message_ts < b.message_ts ? -1 : 1;
        return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
      })
      .slice(0, 3);
  }

  /** Every date with recorded activity, ascending. Used to find days still awaiting results. */
  recordedDates(): string[] {
    const set = new Set<string>([
      ...Object.keys(this.data.messages || {}),
      ...Object.keys(this.data.placements || {}),
    ]);
    return Array.from(set)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
  }

  /** True when at least one game on this date has a settled placement. */
  hasAnyPlacement(date: string): boolean {
    return GAMES.some((g) => this.computePodium(date, g).length > 0);
  }

  /** Every unique entrant for a date+game (earliest message per user), sorted by ts. */
  entrants(date: string, game: Game): Winner[] {
    this.ensureDay(date);
    return this.earliestMessagesByUser(date, game);
  }

  /**
   * This user's recorded entry for the date+game, or null if they have not entered yet.
   * One entry per user per game, so a second valid post is a repeat rather than a new entrant.
   */
  entryFor(date: string, game: Game, user: string): Winner | null {
    return this.earliestMessagesByUser(date, game).find((m) => m.user_id === user) || null;
  }

  /**
   * Record a user's entry for a date+game, bumping the raw tally in the same step.
   *
   * Deliberately one synchronous call that both checks and writes: the duplicate test and the
   * write cannot be split by an await, so no interleaving of concurrently delivered messages can
   * land two entries (or two `counts` increments) for the same user.
   *
   * - `recorded`: accepted as an entrant.
   * - `duplicate`: the user already entered this game today with a different message.
   * - `redelivery`: this exact message is already stored (a Slack retry, not a repeat post).
   */
  addEntry(
    date: string,
    game: Game,
    user: string,
    ts: string,
    channel_id: string,
  ): 'recorded' | 'duplicate' | 'redelivery' {
    this.stampScoring(date, 'random');
    this.ensureDay(date);
    const prior = this.entryFor(date, game, user);
    if (prior) return prior.message_ts === ts ? 'redelivery' : 'duplicate';

    this.data.counts[date][game] = (this.data.counts[date][game] || 0) + 1;
    (this.data.messages as any)[date][game] = [
      ...this.getMessages(date, game),
      { user_id: user, channel_id, message_ts: ts, created_at: DateTime.now().toISO()! } as Winner,
    ];
    this.flush();
    return 'recorded';
  }

  /**
   * True when a date is scored by random point assignment. Dates before the cutover stay on the
   * legacy 3-2-1 podium and must never be settled — including the deploy day itself, which can
   * already hold a scored, announced podium from the previous build.
   */
  scoringFor(date: string): Scoring {
    const stamped = this.data.scoring?.[date];
    if (stamped) return stamped;
    const from = this.data.random_scoring_from;
    return from && date >= from ? 'random' : 'legacy';
  }

  private stampScoring(date: string, mode: Scoring) {
    const byDate = (this.data.scoring ||= {});
    if (!byDate[date]) byDate[date] = mode;
  }

  isRandomEra(date: string): boolean {
    return this.scoringFor(date) === 'random';
  }

  /** True once points have been assigned for a date+game. Resolution is final. */
  isResolved(date: string, game: Game): boolean {
    return Array.isArray(this.data.awards?.[date]?.[game]);
  }

  /** Settled awards for a date+game, highest points first. Empty if unresolved. */
  getAwards(date: string, game: Game): Award[] {
    const arr = this.data.awards?.[date]?.[game];
    return Array.isArray(arr) ? [...arr].sort((a, b) => b.points - a.points) : [];
  }

  /**
   * Close a date+game's entry window and give each of the n unique entrants a unique random
   * point value in 1..n. Idempotent: once resolved, the stored awards are returned unchanged.
   *
   * A game nobody entered settles empty, but only after the noon window has passed: before that
   * the game is still open. Settling it is what stops a day where one needed game went unplayed
   * from stalling its results — and, on a Friday, that week's crown — forever.
   */
  resolveGame(date: string, game: Game, rng: () => number = Math.random, nowMs = Date.now()): Award[] {
    this.ensureDay(date);
    if (this.isResolved(date, game)) return this.getAwards(date, game);
    if (!this.isRandomEra(date)) return []; // Pre-cutover day: stays on legacy podium scoring.

    const entrants = this.earliestMessagesByUser(date, game);
    // A game nobody entered settles empty, but only once the window is past settling: before that
    // an entry could still arrive. Settling it is what stops a day where one needed game went
    // unplayed from stalling its results — and, on a Friday, that week's crown — forever.
    if (!entrants.length && nowMs < windowSettlesAtMs(date)) return [];

    const awarded_at = DateTime.now().toISO()!;
    const awards: Award[] = assignRandomPoints(entrants, rng).map(({ entrant, points }) => ({
      user_id: entrant.user_id,
      points,
      channel_id: entrant.channel_id,
      message_ts: entrant.message_ts,
      awarded_at,
    }));

    const byDate = (this.data.awards ||= {});
    const perGame = (byDate[date] ||= {});
    perGame[game] = awards;
    this.flush();
    return awards;
  }

  /**
   * Date+game pairs past their settling deadline that hold no awards yet — work the in-process
   * timers missed (e.g. the bot restarted mid-window).
   *
   * The window is fixed per date, so every game settles at the same instant whether or not anyone
   * played it. A needed game with no entries settles empty, which is what stops a day where one
   * game went unplayed from stalling its results — and, on a Friday, that week's crown — forever.
   * Only a date somebody actually played settles at all; announcing is bounded separately by
   * isWithinRetryWindow, so an old day still settles correctly but never reaches the channel.
   */
  duePending(nowMs = Date.now()): Array<{ date: string; game: Game; channel_id: string }> {
    const out: Array<{ date: string; game: Game; channel_id: string }> = [];
    for (const date of Object.keys(this.data.messages || {})) {
      // Pre-cutover dates were scored under the legacy podium rules; never re-settle them.
      if (!this.isRandomEra(date)) continue;
      // A day the old build already announced (and medalled) is finished; leave it alone.
      if (this.hasDailyAnnounced(date)) continue;
      if (nowMs < windowSettlesAtMs(date)) continue; // Still open, or inside the delivery grace.
      if (!this.hasAnyEntry(date)) continue; // Nobody played: nothing to settle or announce.
      const needed = neededGamesForDate(date);
      for (const game of GAMES) {
        if (this.isResolved(date, game)) continue;
        const first = this.earliestMessagesByUser(date, game)[0];
        // Settle what was played, plus the needed games nobody entered.
        if (!first && !needed.includes(game)) continue;
        out.push({ date, game, channel_id: first?.channel_id || this.channelForDate(date) || '' });
      }
    }
    return out;
  }

  /** True once medal reactions have been applied for a date+game. */
  hasMedalled(date: string, game: Game): boolean {
    return !!this.data.medalled?.[date]?.[game];
  }

  markMedalled(date: string, game: Game) {
    const byDate = (this.data.medalled ||= {});
    const perGame = (byDate[date] ||= {});
    perGame[game] = DateTime.now().toISO()!;
    this.flush();
  }

  /**
   * Settled date+game pairs whose medal reactions never landed — the retry path for medals lost to
   * a crash between settling and reacting, or to a failed Slack call. Bounded like
   * pendingAnnouncements: medalling a days-old message is not worth doing.
   */
  pendingMedals(nowMs = Date.now()): Array<{ date: string; game: Game }> {
    const out: Array<{ date: string; game: Game }> = [];
    const oldest = this.oldestRetryDate(nowMs);
    for (const date of Object.keys(this.data.awards || {})) {
      if (date < oldest || !this.isRandomEra(date)) continue;
      for (const game of GAMES) {
        if (!this.isResolved(date, game) || this.hasMedalled(date, game)) continue;
        // A game nobody entered settles empty; there is nothing to react to.
        if (!this.getAwards(date, game).length) continue;
        out.push({ date, game });
      }
    }
    return out;
  }

  /** Oldest date a failed post/reaction is still retried for. */
  private oldestRetryDate(nowMs: number): string {
    return DateTime.fromMillis(nowMs).setZone(TZ).minus({ days: RETRY_DAYS }).toISODate()!;
  }

  /**
   * True while a date is recent enough to post results for. Every announce path is gated on this,
   * not just the retry sweep: a day left unsettled by a long outage still settles (so its scores
   * are right) but must never surface a weeks-old podium in the channel.
   */
  isWithinRetryWindow(date: string, nowMs = Date.now()): boolean {
    return date >= this.oldestRetryDate(nowMs);
  }

  /**
   * Post-cutover dates whose games have all settled but which still owe a results post or a
   * Friday crown — the retry path for an announcement lost to a failed Slack call.
   *
   * Limited to the last few days: a failure old enough to fall outside that is not worth
   * resurrecting into the channel, and the bound keeps this cheap to call on every message.
   */
  pendingAnnouncements(nowMs = Date.now()): string[] {
    const out: string[] = [];
    const oldest = this.oldestRetryDate(nowMs);
    for (const date of Object.keys(this.data.awards || {})) {
      if (date < oldest || !this.isRandomEra(date)) continue;
      const owesResults = !this.hasDailyAnnounced(date);
      const owesCrown = isFriday(date) && !this.hasCrowned(weekKeyFor(date));
      if (!owesResults && !owesCrown) continue;
      if (!neededGamesForDate(date).every((g) => this.isResolved(date, g))) continue;
      out.push(date);
    }
    return out.sort();
  }

  /** True when at least one game on this date has an entrant — i.e. the day was actually played. */
  hasAnyEntry(date: string): boolean {
    return GAMES.some((g) => this.earliestMessagesByUser(date, g).length > 0);
  }

  /** The channel a date's earliest recorded entry came from, or null if none was stored. */
  channelForDate(date: string): string | null {
    for (const g of GAMES) {
      const msg = this.earliestMessagesByUser(date, g).find((m) => m.channel_id);
      if (msg) return msg.channel_id;
    }
    return null;
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

  // Recompute the current king live from settled weekly totals, avoiding stale Friday snapshots.
  // Walks back from the ISO week before currentDate, returning the first week with results.
  latestCompletedWeekWinner(
    currentDate: string,
  ): { weekKey: string; start: string; end: string; winners: string[]; points: number } | null {
    const base = DateTime.fromISO(currentDate, { zone: TZ });
    for (let back = 1; back <= 8; back++) {
      const prevDate = base.minus({ weeks: back }).toISODate()!;
      const { start, end } = weekStartEnd(prevDate);
      const totals = this.weeklyTotals(start, end);
      if (!totals.length) continue;
      const points = totals[0].points;
      const winners = totals.filter((t) => t.points === points).map((t) => t.user_id);
      return { weekKey: weekKeyFor(prevDate), start, end, winners, points };
    }
    return null;
  }

  /**
   * Points contributed by a single date+game.
   * - Resolved games score their settled random awards.
   * - Dates in the random-scoring era that have not settled yet score nothing (a window still
   *   open at noon must not leak provisional points into the leaderboard).
   * - Dates before the cutover keep the legacy 3-2-1 podium weights.
   */
  private scoreFor(date: string, game: Game): Array<{ user_id: string; points: number }> {
    const awards = this.data.awards?.[date]?.[game];
    if (Array.isArray(awards)) return awards.map((a) => ({ user_id: a.user_id, points: a.points }));

    // Random era: settled awards are the only source, so an open window scores nothing yet.
    if (this.isRandomEra(date)) return [];

    return this.computePodium(date, game).map((user_id, idx) => ({
      user_id,
      points: PODIUM_WEIGHTS[idx] || 0,
    }));
  }

  weeklyTotals(startDate: string, endDate: string): Array<{ user_id: string; points: number }> {
    const res = new Map<string, number>();
    // Seed baselines if present for the week
    const weekKey = weekKeyForRange(startDate, endDate);
    const baselines = this.data.weekly_adjustments?.[weekKey] || {};
    for (const [user, pts] of Object.entries(baselines)) {
      res.set(user, pts);
    }
    // Iterate all settled results in the date range
    let d = DateTime.fromISO(startDate);
    const end = DateTime.fromISO(endDate);
    for (; d <= end; d = d.plus({ days: 1 })) {
      const date = d.toISODate()!;
      for (const g of GAMES) {
        for (const { user_id, points } of this.scoreFor(date, g)) {
          if (points > 0) res.set(user_id, (res.get(user_id) || 0) + points);
        }
      }
    }
    return Array.from(res.entries())
      .map(([user_id, points]) => ({ user_id, points }))
      .sort((a, b) => (b.points - a.points) || a.user_id.localeCompare(b.user_id));
  }
}
