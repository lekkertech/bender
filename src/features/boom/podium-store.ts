import { GAMES, type Game } from './rules.js';
import { earliestPerUser, type MessageRef, type Winner } from './store-data.js';
import { StoreBase } from './store-base.js';

export class PodiumStore extends StoreBase {
  protected computePodium(date: string, game: Game): string[] {
    const msgs = this.getMessages(date, game);
    if (msgs.length) return earliestPerUser(msgs).slice(0, 3).map((m) => m.user_id);
    const arr = (this.data.placements[date] as any)?.[game] as string[] | undefined;
    return arr ? arr.slice(0, 3) : [];
  }

  placementsCount(date: string, game: Game): number {
    this.ensureDay(date);
    return this.computePodium(date, game).length;
  }

  addPlacement(date: string, game: Game, user: string, msg?: MessageRef): number {
    this.stampScoring(date, 'legacy');
    this.ensureDay(date);
    if (!msg) return this.appendArrivalPlacement(date, game, user);
    this.recordUnlessDuplicate(date, game, user, msg);
    return this.podiumPositionFor(date, game, user, msg.ts);
  }

  private appendArrivalPlacement(date: string, game: Game, user: string): number {
    const stored = (this.data.placements[date] as any)[game] as string[] | undefined;
    const arr = stored ? [...stored] : [];
    if (arr.includes(user) || arr.length >= 3) return 0;
    arr.push(user);
    (this.data.placements[date] as any)[game] = arr;
    this.flush();
    return arr.length;
  }

  private recordUnlessDuplicate(date: string, game: Game, user: string, msg: MessageRef) {
    const arr = this.getMessages(date, game);
    if (arr.some((w) => w.user_id === user && w.message_ts === msg.ts)) return;
    this.appendMessage(date, game, user, msg);
    this.flush();
  }

  private podiumPositionFor(date: string, game: Game, user: string, ts: string): number {
    const earliest = this.earliestMessagesByUser(date, game).find((m) => m.user_id === user);
    if (!earliest || earliest.message_ts !== ts) return 0;
    return this.computePodium(date, game).indexOf(user) + 1;
  }

  getPlacements(date: string, game: Game): string[] {
    this.ensureDay(date);
    return this.computePodium(date, game);
  }

  getPodiumMessages(date: string, game: Game): Winner[] {
    this.ensureDay(date);
    return this.earliestMessagesByUser(date, game).slice(0, 3);
  }

  recordedDates(): string[] {
    const set = new Set<string>([
      ...Object.keys(this.data.messages || {}),
      ...Object.keys(this.data.placements || {}),
    ]);
    return Array.from(set)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
  }

  hasAnyPlacement(date: string): boolean {
    return GAMES.some((g) => this.computePodium(date, g).length > 0);
  }
}
