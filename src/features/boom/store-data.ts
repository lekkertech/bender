import { DateTime } from 'luxon';
import type { Scoring } from '../../env.js';
import type { Game } from './rules.js';

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

export const RETRY_DAYS = 2;

export const initialData = (): StoreData => ({
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

export function normalizeData(raw: Partial<StoreData & Record<string, unknown>>): StoreData {
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

function parseSlackTs(ts: string): number {
  const n = Number(ts);
  if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  const f = parseFloat(ts);
  return Number.isNaN(f) ? 0 : f;
}

function byEarliestTs(a: Winner, b: Winner): number {
  const at = parseSlackTs(a.message_ts);
  const bt = parseSlackTs(b.message_ts);
  if (at !== bt) return at - bt;
  if (a.message_ts !== b.message_ts) return a.message_ts < b.message_ts ? -1 : 1;
  return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
}

export function earliestPerUser(msgs: readonly Winner[]): Winner[] {
  const earliest = new Map<string, Winner>();
  for (const m of msgs) {
    const cur = earliest.get(m.user_id);
    if (!cur || byEarliestTs(m, cur) < 0) earliest.set(m.user_id, m);
  }
  return Array.from(earliest.values()).sort(byEarliestTs);
}

export function weekKeyForRange(startDate: string): string {
  const start = DateTime.fromISO(startDate);
  const wk = start.weekNumber.toString().padStart(2, '0');
  return `${start.year}-W${wk}`;
}
