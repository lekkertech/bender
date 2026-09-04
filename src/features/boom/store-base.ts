import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DateTime } from 'luxon';
import type { Scoring } from '../../env.js';
import type { Game } from './rules.js';
import {
  earliestPerUser,
  initialData,
  normalizeData,
  type MessageRef,
  type StoreData,
  type Winner,
} from './store-data.js';

export class StoreBase {
  protected file: string;
  protected data: StoreData;

  constructor(file = join(process.cwd(), 'data', 'store.json')) {
    this.file = file;
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(file)) {
      this.data = readStoreFile(file);
      return;
    }
    this.data = initialData();
    this.flush();
  }

  protected flush() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  protected ensureDay(date: string) {
    if (!this.data.placements[date]) this.data.placements[date] = {} as any;
    if (!this.data.counts[date]) this.data.counts[date] = { boom: 0, hadeda: 0, wednesday: 0 } as any;
    if (!this.data.messages) this.data.messages = {};
    if (!this.data.messages[date]) this.data.messages[date] = { boom: [], hadeda: [], wednesday: [] } as any;
    const perGame = this.data.messages[date] as Record<Game, Winner[]>;
    if (!perGame.boom) perGame.boom = [];
    if (!perGame.hadeda) perGame.hadeda = [];
    if (!perGame.wednesday) perGame.wednesday = [];
  }

  protected getMessages(date: string, game: Game): Winner[] {
    const mg = this.data.messages?.[date]?.[game];
    return Array.isArray(mg) ? mg : [];
  }

  protected earliestMessagesByUser(date: string, game: Game): Winner[] {
    return earliestPerUser(this.getMessages(date, game));
  }

  protected appendMessage(date: string, game: Game, user: string, msg: MessageRef) {
    (this.data.messages as any)[date][game] = [
      ...this.getMessages(date, game),
      {
        user_id: user,
        channel_id: msg.channel_id,
        message_ts: msg.ts,
        created_at: DateTime.now().toISO()!,
      } as Winner,
    ];
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

  scoringFor(date: string): Scoring {
    const stamped = this.data.scoring?.[date];
    if (stamped) return stamped;
    const from = this.data.random_scoring_from;
    return from && date >= from ? 'random' : 'legacy';
  }

  protected stampScoring(date: string, mode: Scoring) {
    const byDate = (this.data.scoring ||= {});
    if (!byDate[date]) byDate[date] = mode;
  }

  isRandomEra(date: string): boolean {
    return this.scoringFor(date) === 'random';
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
}

function readStoreFile(file: string): StoreData {
  try {
    return normalizeData(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return initialData();
  }
}
