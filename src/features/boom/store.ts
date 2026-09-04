import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import type { Scoring } from '../../env.js';
import {
  assignRandomPoints,
  GAMES,
  isFriday,
  neededGamesForDate,
  windowSettlesAtMs,
  TZ,
  weekKeyFor,
  type Game,
} from './rules.js';
import {
  awardsFor,
  datesRecorded,
  earliestFor,
  ensureDay,
  isRandomEra,
  isResolved,
  latestCompletedWeekWinner,
  loadStore,
  messagesFor,
  nested,
  podiumFor,
  scoringFor,
  setNested,
  weeklyTotals,
  writeStore,
  RETRY_DAYS,
  type Award,
  type MessageRef,
  type Scored,
  type StoreData,
  type WeekWinner,
  type Winner,
} from './store-data.js';

export type { Award } from './store-data.js';

type DueSettlement = { date: string; game: Game; channel_id: string };

export class Store {
  private file: string;
  private data: StoreData;

  constructor(file = join(process.cwd(), 'data', 'store.json')) {
    this.file = file;
    this.data = loadStore(file);
    if (!existsSync(file)) this.flush();
  }

  private flush() { writeStore(this.file, this.data); }

  private appendMessage(date: string, game: Game, user: string, msg: MessageRef) {
    const entry: Winner = {
      user_id: user,
      channel_id: msg.channel_id,
      message_ts: msg.ts,
      created_at: DateTime.now().toISO()!,
    };
    setNested(this.data.messages ||= {}, date, game, [...messagesFor(this.data, date, game), entry]);
  }

  incrementCount(date: string, game: Game): number {
    ensureDay(this.data, date);
    this.data.counts[date][game] = (this.data.counts[date][game] || 0) + 1;
    this.flush();
    return this.data.counts[date][game];
  }

  getCounts(date: string): Record<Game, number> {
    ensureDay(this.data, date);
    return { ...this.data.counts[date] };
  }

  scoringFor(date: string): Scoring { return scoringFor(this.data, date); }

  isRandomEra(date: string): boolean { return isRandomEra(this.data, date); }

  private stampScoring(date: string, mode: Scoring) {
    const byDate = (this.data.scoring ||= {});
    if (!byDate[date]) byDate[date] = mode;
  }

  private stamp(bucket: Record<string, string>, key: string) {
    bucket[key] = DateTime.now().toISO()!;
    this.flush();
  }

  markDailyAnnounced(date: string) { this.stamp(this.data.daily_announced, date); }

  hasDailyAnnounced(date: string): boolean { return !!this.data.daily_announced[date]; }

  markCrowned(weekKey: string) { this.stamp(this.data.weekly_crowned, weekKey); }

  hasCrowned(weekKey: string): boolean { return !!this.data.weekly_crowned[weekKey]; }

  addPlacement(date: string, game: Game, user: string, msg: MessageRef): number {
    this.stampScoring(date, 'legacy');
    ensureDay(this.data, date);
    this.recordUnlessDuplicate(date, game, user, msg);
    return this.podiumPositionFor(date, game, user, msg.ts);
  }

  private recordUnlessDuplicate(date: string, game: Game, user: string, msg: MessageRef) {
    const arr = messagesFor(this.data, date, game);
    if (arr.some((w) => w.user_id === user && w.message_ts === msg.ts)) return;
    this.appendMessage(date, game, user, msg);
    this.flush();
  }

  private podiumPositionFor(date: string, game: Game, user: string, ts: string): number {
    const earliest = earliestFor(this.data, date, game).find((m) => m.user_id === user);
    if (!earliest || earliest.message_ts !== ts) return 0;
    return podiumFor(this.data, date, game).indexOf(user) + 1;
  }

  getPlacements(date: string, game: Game): string[] {
    ensureDay(this.data, date);
    return podiumFor(this.data, date, game);
  }

  placementsCount(date: string, game: Game): number { return this.getPlacements(date, game).length; }

  getPodiumMessages(date: string, game: Game): Winner[] {
    ensureDay(this.data, date);
    return earliestFor(this.data, date, game).slice(0, 3);
  }

  recordedDates(): string[] { return datesRecorded(this.data); }

  hasAnyPlacement(date: string): boolean {
    return GAMES.some((g) => podiumFor(this.data, date, g).length > 0);
  }

  entrants(date: string, game: Game): Winner[] {
    ensureDay(this.data, date);
    return earliestFor(this.data, date, game);
  }

  entryFor(date: string, game: Game, user: string): Winner | null {
    return earliestFor(this.data, date, game).find((m) => m.user_id === user) || null;
  }

  addEntry(date: string, game: Game, user: string, msg: MessageRef): 'recorded' | 'duplicate' | 'redelivery' {
    this.stampScoring(date, 'random');
    ensureDay(this.data, date);
    const prior = this.entryFor(date, game, user);
    if (prior) return prior.message_ts === msg.ts ? 'redelivery' : 'duplicate';

    this.data.counts[date][game] = (this.data.counts[date][game] || 0) + 1;
    this.appendMessage(date, game, user, msg);
    this.flush();
    return 'recorded';
  }

  isResolved(date: string, game: Game): boolean { return isResolved(this.data, date, game); }

  getAwards(date: string, game: Game): Award[] { return awardsFor(this.data, date, game); }

  resolveGame(date: string, game: Game, rng: () => number = Math.random, nowMs = Date.now()): Award[] {
    ensureDay(this.data, date);
    if (this.isResolved(date, game)) return this.getAwards(date, game);
    if (!this.isRandomEra(date)) return [];

    const entrants = earliestFor(this.data, date, game);
    if (!entrants.length && nowMs < windowSettlesAtMs(date)) return [];

    const awarded_at = DateTime.now().toISO()!;
    const awards: Award[] = assignRandomPoints(entrants, rng).map(({ entrant, points }) => ({
      user_id: entrant.user_id,
      points,
      channel_id: entrant.channel_id,
      message_ts: entrant.message_ts,
      awarded_at,
    }));

    setNested(this.data.awards ||= {}, date, game, awards);
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
      .map((game) => ({ game, first: earliestFor(this.data, date, game)[0] }))
      .filter(({ game, first }) => first || needed.includes(game))
      .map(({ game, first }) => ({
        date,
        game,
        channel_id: first?.channel_id || this.channelForDate(date) || '',
      }));
  }

  hasMedalled(date: string, game: Game): boolean {
    return !!nested<string>(this.data.medalled, date, game);
  }

  markMedalled(date: string, game: Game) {
    setNested(this.data.medalled ||= {}, date, game, DateTime.now().toISO()!);
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
    return GAMES.some((g) => earliestFor(this.data, date, g).length > 0);
  }

  channelForDate(date: string): string | null {
    for (const g of GAMES) {
      const msg = earliestFor(this.data, date, g).find((m) => m.channel_id);
      if (msg) return msg.channel_id;
    }
    return null;
  }

  setCrown(weekKey: string, winners: string[], points: number) {
    const kings = (this.data.weekly_kings ||= {});
    kings[weekKey] = { winners: [...winners], points, crowned_at: DateTime.now().toISO()! };
    this.flush();
  }

  latestCompletedWeekWinner(currentDate: string): WeekWinner | null {
    return latestCompletedWeekWinner(this.data, currentDate);
  }

  weeklyTotals(startDate: string, endDate: string): Scored[] {
    return weeklyTotals(this.data, startDate, endDate);
  }
}
