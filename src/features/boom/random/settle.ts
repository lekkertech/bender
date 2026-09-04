import type { Store } from '../store.js';
import { GAMES, neededGamesForDate, windowSettlesAtMs, type Game } from '../rules.js';
import { logFailures, type Io } from './io.js';
import { applyMedals } from './medals.js';
import { announceDay, type Announcer } from './announce.js';

const SWEEP_INTERVAL_MS = 30 * 1000;

export type Settler = {
  db: Store;
  announcer: Announcer;
  timers: Map<string, ReturnType<typeof setTimeout>>;
};

export function createSettler(db: Store, announcer: Announcer): Settler {
  return { db, announcer, timers: new Map() };
}

export function scheduleSettle(s: Settler, io: Io, date: string) {
  if (s.timers.has(date) || !s.db.isRandomEra(date) || s.db.hasDailyAnnounced(date)) return;
  const timer = setTimeout(() => {
    s.timers.delete(date);
    settleDay(s, io, date).catch((err) => io.logger?.error?.(err));
  }, Math.max(0, windowSettlesAtMs(date) - Date.now()));
  timer.unref?.();
  s.timers.set(date, timer);
}

export function startSweep(s: Settler, io: Io) {
  const sweep = setInterval(() => {
    catchUp(s, io).catch((err) => io.logger?.error?.(err));
  }, SWEEP_INTERVAL_MS);
  sweep.unref?.();
}

function cancelTimer(s: Settler, date: string) {
  const timer = s.timers.get(date);
  if (!timer) return;
  clearTimeout(timer);
  s.timers.delete(date);
}

function gamesToClose(db: Store, date: string): Set<Game> {
  return new Set([...neededGamesForDate(date), ...GAMES.filter((g) => db.entrants(date, g).length)]);
}

async function closeGame(s: Settler, io: Io, date: string, game: Game) {
  s.db.resolveGame(date, game);
  await applyMedals(s.db, io, date, game);
}

async function settleDay(s: Settler, io: Io, date: string) {
  cancelTimer(s, date);
  for (const game of gamesToClose(s.db, date)) {
    await closeGame(s, io, date, game);
  }
  await announceDay(s.announcer, io, date);
}

async function settleDue(s: Settler, io: Io): Promise<Set<string>> {
  const settled = new Set<string>();
  for (const p of s.db.duePending()) {
    await logFailures(io, async () => {
      await closeGame(s, io, p.date, p.game);
      settled.add(p.date);
    });
  }
  return settled;
}

async function announceEach(s: Settler, io: Io, dates: Iterable<string>) {
  for (const date of dates) {
    await logFailures(io, () => announceDay(s.announcer, io, date));
  }
}

export async function catchUp(s: Settler, io: Io) {
  const orphanedMedals = s.db.pendingMedals();
  await announceEach(s, io, await settleDue(s, io));
  for (const p of orphanedMedals) {
    await logFailures(io, () => applyMedals(s.db, io, p.date, p.game));
  }
  await announceEach(s, io, s.db.pendingAnnouncements());
}
