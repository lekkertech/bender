import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Scoring } from '../../env.js';
import { GAMES, PODIUM_WEIGHTS, TZ, weekKeyFor, weekStartEnd, type Game } from './rules.js';
import { DateTime } from 'luxon';

export type Winner = { user_id: string; channel_id: string; message_ts: string; created_at: string };

export type MessageRef = { ts: string; channel_id: string };

export type Award = {
  user_id: string;
  points: number;
  channel_id: string;
  message_ts: string;
  awarded_at: string;
};

export type WeeklyKing = { winners: string[]; points: number; crowned_at: string };

export type StoreData = {
  placements: Record<string, Record<Game, string[]>>;
  counts: Record<string, Record<Game, number>>;
  daily_announced: Record<string, string>;
  weekly_crowned: Record<string, string>;
  weekly_kings?: Record<string, WeeklyKing>;
  weekly_adjustments?: Record<string, Record<string, number>>;
  messages?: Record<string, Record<Game, Winner[]>>;
  awards?: Record<string, Partial<Record<Game, Award[]>>>;
  medalled?: Record<string, Partial<Record<Game, string>>>;
  random_scoring_from?: string;
  scoring?: Record<string, Scoring>;
};

export type NestedByGame<T> = Record<string, Partial<Record<Game, T>>>;

export type Scored = { user_id: string; points: number };

export type WeekWinner = { weekKey: string; start: string; end: string; winners: string[]; points: number };

export const RETRY_DAYS = 2;

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

function asRecord<T>(v: unknown, fallback: T): T {
  return isObject(v) ? (v as T) : fallback;
}

function assignUserArrays(target: Record<string, string[]>, perGame: Record<string, unknown>) {
  for (const [game, users] of Object.entries(perGame)) {
    if (Array.isArray(users)) target[game] = users as string[];
  }
}

function mergeLegacyWins(data: StoreData, wins: unknown) {
  if (!isObject(wins)) return;
  for (const [date, perGame] of Object.entries(wins)) {
    if (!isObject(perGame)) continue;
    const p: Record<string, string[]> = (data.placements[date] ||= {} as any);
    assignUserArrays(p, perGame);
  }
}

function normalizeData(raw: Partial<StoreData & Record<string, unknown>>): StoreData {
  const base = initialData();
  const src = raw as Record<string, unknown>;
  const data: StoreData = {
    placements: asRecord(raw.placements, base.placements),
    counts: asRecord(raw.counts, base.counts),
    daily_announced: asRecord(raw.daily_announced, base.daily_announced),
    weekly_crowned: asRecord(raw.weekly_crowned, base.weekly_crowned),
    weekly_kings: asRecord(src.weekly_kings, {} as Record<string, WeeklyKing>),
    weekly_adjustments: asRecord(raw.weekly_adjustments, undefined as StoreData['weekly_adjustments']),
    messages: asRecord(src.messages, {} as Record<string, Record<Game, Winner[]>>),
    awards: asRecord(src.awards, {} as Record<string, Partial<Record<Game, Award[]>>>),
    medalled: asRecord(src.medalled, {} as Record<string, Partial<Record<Game, string>>>),
    random_scoring_from: typeof src.random_scoring_from === 'string' ? src.random_scoring_from : undefined,
    scoring: asRecord(src.scoring, {} as Record<string, Scoring>),
  };
  mergeLegacyWins(data, src.wins);
  return data;
}

export function loadStore(file: string): StoreData {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) return initialData();
  try {
    return normalizeData(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return initialData();
  }
}

export function writeStore(file: string, data: StoreData) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function ensureDay(data: StoreData, date: string) {
  data.placements[date] ||= {} as Record<Game, string[]>;
  data.counts[date] ||= { boom: 0, hadeda: 0, wednesday: 0 };
  const perGame = ((data.messages ||= {})[date] ||= {} as Record<Game, Winner[]>);
  for (const game of GAMES) perGame[game] ||= [];
}

export function nested<T>(root: NestedByGame<T> | undefined, date: string, game: Game): T | undefined {
  return root?.[date]?.[game];
}

export function setNested<T>(root: NestedByGame<T>, date: string, game: Game, value: T) {
  (root[date] ||= {})[game] = value;
}

function byEarliestTs(a: Winner, b: Winner): number {
  return a.message_ts.localeCompare(b.message_ts) || a.user_id.localeCompare(b.user_id);
}

function earliestPerUser(msgs: readonly Winner[]): Winner[] {
  const earliest = new Map<string, Winner>();
  for (const m of msgs) {
    const cur = earliest.get(m.user_id);
    if (!cur || byEarliestTs(m, cur) < 0) earliest.set(m.user_id, m);
  }
  return Array.from(earliest.values()).sort(byEarliestTs);
}

export function messagesFor(data: StoreData, date: string, game: Game): Winner[] {
  return nested<Winner[]>(data.messages, date, game) || [];
}

export function earliestFor(data: StoreData, date: string, game: Game): Winner[] {
  return earliestPerUser(messagesFor(data, date, game));
}

export function podiumFor(data: StoreData, date: string, game: Game): string[] {
  const msgs = messagesFor(data, date, game);
  if (msgs.length) return earliestPerUser(msgs).slice(0, 3).map((m) => m.user_id);
  return nested<string[]>(data.placements, date, game)?.slice(0, 3) || [];
}

export function isResolved(data: StoreData, date: string, game: Game): boolean {
  return Array.isArray(nested<Award[]>(data.awards, date, game));
}

export function awardsFor(data: StoreData, date: string, game: Game): Award[] {
  const arr = nested<Award[]>(data.awards, date, game);
  return Array.isArray(arr) ? [...arr].sort((a, b) => b.points - a.points) : [];
}

export function scoringFor(data: StoreData, date: string): Scoring {
  const stamped = data.scoring?.[date];
  if (stamped) return stamped;
  const from = data.random_scoring_from;
  return from && date >= from ? 'random' : 'legacy';
}

export function isRandomEra(data: StoreData, date: string): boolean {
  return scoringFor(data, date) === 'random';
}

export function datesRecorded(data: StoreData): string[] {
  const set = new Set<string>([...Object.keys(data.messages || {}), ...Object.keys(data.placements || {})]);
  return Array.from(set)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

function scoreFor(data: StoreData, date: string, game: Game): Scored[] {
  const awards = nested<Award[]>(data.awards, date, game);
  if (Array.isArray(awards)) return awards.map((a) => ({ user_id: a.user_id, points: a.points }));
  if (isRandomEra(data, date)) return [];
  return podiumFor(data, date, game).map((user_id, idx) => ({ user_id, points: PODIUM_WEIGHTS[idx] || 0 }));
}

function scoredRange(data: StoreData, startDate: string, endDate: string): Scored[] {
  const out: Scored[] = [];
  const end = DateTime.fromISO(endDate);
  for (let d = DateTime.fromISO(startDate); d <= end; d = d.plus({ days: 1 })) {
    const date = d.toISODate()!;
    out.push(...GAMES.flatMap((g) => scoreFor(data, date, g)));
  }
  return out;
}

export function weeklyTotals(data: StoreData, startDate: string, endDate: string): Scored[] {
  const baselines = data.weekly_adjustments?.[weekKeyFor(startDate)] || {};
  const res = new Map<string, number>(Object.entries(baselines));
  for (const { user_id, points } of scoredRange(data, startDate, endDate)) {
    if (points > 0) res.set(user_id, (res.get(user_id) || 0) + points);
  }
  return Array.from(res.entries())
    .map(([user_id, points]) => ({ user_id, points }))
    .sort((a, b) => (b.points - a.points) || a.user_id.localeCompare(b.user_id));
}

export function latestCompletedWeekWinner(data: StoreData, currentDate: string): WeekWinner | null {
  const base = DateTime.fromISO(currentDate, { zone: TZ });
  for (let back = 1; back <= 8; back++) {
    const prevDate = base.minus({ weeks: back }).toISODate()!;
    const { start, end } = weekStartEnd(prevDate);
    const totals = weeklyTotals(data, start, end);
    if (!totals.length) continue;
    const points = totals[0].points;
    return { weekKey: weekKeyFor(prevDate), start, end, points, winners: winnersAt(totals, points) };
  }
  return null;
}

function winnersAt(totals: Scored[], points: number): string[] {
  return totals.filter((t) => t.points === points).map((t) => t.user_id);
}
