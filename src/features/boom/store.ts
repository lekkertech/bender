import { DateTime } from 'luxon';
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
import {
  RETRY_DAYS,
  weekKeyForRange,
  type Award,
  type MessageRef,
  type WeeklyKing,
  type Winner,
} from './store-data.js';
import { PodiumStore } from './podium-store.js';

export type { Award } from './store-data.js';

type Crown = { weekKey: string } & WeeklyKing;

type DueSettlement = { date: string; game: Game; channel_id: string };

type WeekWinner = { weekKey: string; start: string; end: string; winners: string[]; points: number };

export class Store extends PodiumStore {
  entrants(date: string, game: Game): Winner[] {
    this.ensureDay(date);
    return this.earliestMessagesByUser(date, game);
  }

  entryFor(date: string, game: Game, user: string): Winner | null {
    return this.earliestMessagesByUser(date, game).find((m) => m.user_id === user) || null;
  }

  addEntry(date: string, game: Game, user: string, msg: MessageRef): 'recorded' | 'duplicate' | 'redelivery' {
    this.stampScoring(date, 'random');
    this.ensureDay(date);
    const prior = this.entryFor(date, game, user);
    if (prior) return prior.message_ts === msg.ts ? 'redelivery' : 'duplicate';

    this.data.counts[date][game] = (this.data.counts[date][game] || 0) + 1;
    this.appendMessage(date, game, user, msg);
    this.flush();
    return 'recorded';
  }

  isResolved(date: string, game: Game): boolean {
    return Array.isArray(this.data.awards?.[date]?.[game]);
  }

  getAwards(date: string, game: Game): Award[] {
    const arr = this.data.awards?.[date]?.[game];
    return Array.isArray(arr) ? [...arr].sort((a, b) => b.points - a.points) : [];
  }

  resolveGame(date: string, game: Game, rng: () => number = Math.random, nowMs = Date.now()): Award[] {
    this.ensureDay(date);
    if (this.isResolved(date, game)) return this.getAwards(date, game);
    if (!this.isRandomEra(date)) return [];

    const entrants = this.earliestMessagesByUser(date, game);
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

  duePending(nowMs = Date.now()): DueSettlement[] {
    return Object.keys(this.data.messages || {})
      .filter((date) => this.isDueForSettling(date, nowMs))
      .flatMap((date) => this.unsettledGames(date));
  }

  private isDueForSettling(date: string, nowMs: number): boolean {
    if (!this.isRandomEra(date) || this.hasDailyAnnounced(date)) return false;
    return nowMs >= windowSettlesAtMs(date) && this.hasAnyEntry(date);
  }

  private unsettledGames(date: string): DueSettlement[] {
    const needed = neededGamesForDate(date);
    return GAMES.filter((game) => !this.isResolved(date, game))
      .map((game) => ({ game, first: this.earliestMessagesByUser(date, game)[0] }))
      .filter(({ game, first }) => first || needed.includes(game))
      .map(({ game, first }) => ({
        date,
        game,
        channel_id: first?.channel_id || this.channelForDate(date) || '',
      }));
  }

  hasMedalled(date: string, game: Game): boolean {
    return !!this.data.medalled?.[date]?.[game];
  }

  markMedalled(date: string, game: Game) {
    const byDate = (this.data.medalled ||= {});
    const perGame = (byDate[date] ||= {});
    perGame[game] = DateTime.now().toISO()!;
    this.flush();
  }

  pendingMedals(nowMs = Date.now()): Array<{ date: string; game: Game }> {
    const oldest = this.oldestRetryDate(nowMs);
    return Object.keys(this.data.awards || {})
      .filter((date) => date >= oldest && this.isRandomEra(date))
      .flatMap((date) => GAMES.filter((game) => this.needsMedal(date, game)).map((game) => ({ date, game })));
  }

  private needsMedal(date: string, game: Game): boolean {
    if (!this.isResolved(date, game) || this.hasMedalled(date, game)) return false;
    return this.getAwards(date, game).length > 0;
  }

  private oldestRetryDate(nowMs: number): string {
    return DateTime.fromMillis(nowMs).setZone(TZ).minus({ days: RETRY_DAYS }).toISODate()!;
  }

  isWithinRetryWindow(date: string, nowMs = Date.now()): boolean {
    return date >= this.oldestRetryDate(nowMs);
  }

  pendingAnnouncements(nowMs = Date.now()): string[] {
    const oldest = this.oldestRetryDate(nowMs);
    return Object.keys(this.data.awards || {})
      .filter((date) => date >= oldest && this.isRandomEra(date) && this.owesAnnouncement(date))
      .sort();
  }

  private owesAnnouncement(date: string): boolean {
    const owesResults = !this.hasDailyAnnounced(date);
    const owesCrown = isFriday(date) && !this.hasCrowned(weekKeyFor(date));
    if (!owesResults && !owesCrown) return false;
    return neededGamesForDate(date).every((g) => this.isResolved(date, g));
  }

  hasAnyEntry(date: string): boolean {
    return GAMES.some((g) => this.earliestMessagesByUser(date, g).length > 0);
  }

  channelForDate(date: string): string | null {
    for (const g of GAMES) {
      const msg = this.earliestMessagesByUser(date, g).find((m) => m.channel_id);
      if (msg) return msg.channel_id;
    }
    return null;
  }

  setCrown(weekKey: string, winners: string[], points: number) {
    const kings = (this.data.weekly_kings ||= {});
    const tsMs = Math.max(Date.now(), this.latestCrownMs() + 1);
    kings[weekKey] = {
      winners: [...winners],
      points,
      crowned_at: DateTime.fromMillis(tsMs).toISO()!,
    };
    this.flush();
  }

  private latestCrownMs(): number {
    const times = Object.values(this.data.weekly_kings || {})
      .filter((val) => val?.crowned_at)
      .map((val) => DateTime.fromISO(val.crowned_at).toMillis())
      .filter((ms) => Number.isFinite(ms));
    return times.length ? Math.max(...times) : 0;
  }

  getLatestCrown(): Crown | null {
    const crowned = Object.entries(this.data.weekly_kings || {}).filter(([, val]) => val?.crowned_at);
    if (!crowned.length) return null;
    const [weekKey, val] = crowned.reduce((best, cur) =>
      DateTime.fromISO(cur[1].crowned_at) > DateTime.fromISO(best[1].crowned_at) ? cur : best,
    );
    return { weekKey, ...val };
  }

  latestCompletedWeekWinner(currentDate: string): WeekWinner | null {
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

  private scoreFor(date: string, game: Game): Array<{ user_id: string; points: number }> {
    const awards = this.data.awards?.[date]?.[game];
    if (Array.isArray(awards)) return awards.map((a) => ({ user_id: a.user_id, points: a.points }));
    if (this.isRandomEra(date)) return [];
    return this.computePodium(date, game).map((user_id, idx) => ({
      user_id,
      points: PODIUM_WEIGHTS[idx] || 0,
    }));
  }

  private scoredRange(startDate: string, endDate: string): Array<{ user_id: string; points: number }> {
    const out: Array<{ user_id: string; points: number }> = [];
    const end = DateTime.fromISO(endDate);
    for (let d = DateTime.fromISO(startDate); d <= end; d = d.plus({ days: 1 })) {
      const date = d.toISODate()!;
      out.push(...GAMES.flatMap((g) => this.scoreFor(date, g)));
    }
    return out;
  }

  weeklyTotals(startDate: string, endDate: string): Array<{ user_id: string; points: number }> {
    const baselines = this.data.weekly_adjustments?.[weekKeyForRange(startDate)] || {};
    const res = new Map<string, number>(Object.entries(baselines));
    for (const { user_id, points } of this.scoredRange(startDate, endDate)) {
      if (points > 0) res.set(user_id, (res.get(user_id) || 0) + points);
    }
    return Array.from(res.entries())
      .map(([user_id, points]) => ({ user_id, points }))
      .sort((a, b) => (b.points - a.points) || a.user_id.localeCompare(b.user_id));
  }
}
