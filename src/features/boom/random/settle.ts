import type { Award, Store } from '../store.js';
import { GAMES, neededGamesForDate, windowSettlesAtMs, type Game } from '../rules.js';
import { announceDay } from './announce.js';

const SWEEP_INTERVAL_MS = 30 * 1000;
const PODIUM_MEDALS = ['first_place_medal', 'second_place_medal', 'third_place_medal'] as const;
/** Marks the first, last and middle to post: the entrants whose bonus entry went into the draw. */
const TIMING_MEDAL = 'medal';

export type Io = { client: any; logger?: any };

export type Settler = {
  db: Store;
  announcing: Set<string>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
};

export async function logFailures(io: Io, run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    io.logger?.error?.(err);
  }
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
  await announceDay(s, io, date);
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
    await logFailures(io, () => announceDay(s, io, date));
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

const PERMANENT_REACTION_ERRORS = new Set(['already_reacted', 'invalid_name']);

function isPermanentlySettled(err: any): boolean {
  return PERMANENT_REACTION_ERRORS.has(err?.data?.error) || PERMANENT_REACTION_ERRORS.has(err?.message);
}

async function addMedal(client: any, award: Award, medal: string): Promise<unknown | null> {
  if (!award.channel_id || !award.message_ts) return null;
  try {
    await client.reactions.add({ channel: award.channel_id, timestamp: award.message_ts, name: medal });
    return null;
  } catch (err) {
    return isPermanentlySettled(err) ? null : err;
  }
}

/** Podium medals for the three biggest earners (awards are sorted by points), then a timing medal each. */
function medalTargets(awards: Award[]): Array<{ award: Award; medal: string }> {
  const podium = PODIUM_MEDALS.flatMap((medal, i) => (awards[i] ? [{ award: awards[i]!, medal }] : []));
  const timing = awards.filter((a) => a.medal).map((award) => ({ award, medal: TIMING_MEDAL }));
  return [...podium, ...timing];
}

async function applyMedals(db: Store, io: Io, date: string, game: Game) {
  if (db.hasMedalled(date, game)) return;
  const awards = db.getAwards(date, game);
  if (!awards.length) return;

  let failed = false;
  for (const { award, medal } of medalTargets(awards)) {
    const err = await addMedal(io.client, award, medal);
    if (!err) continue;
    failed = true;
    io.logger?.warn?.({ date, game, medal, err }, '[boom] failed to apply medal reaction');
  }
  if (!failed) db.markMedalled(date, game);
}
