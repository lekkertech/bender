import type { Award, Store } from '../store.js';
import type { Game } from '../rules.js';
import type { Io } from './io.js';

const PODIUM_MEDALS = ['first_place_medal', 'second_place_medal', 'third_place_medal'] as const;

function isAlreadyReacted(err: any): boolean {
  return err?.data?.error === 'already_reacted' || err?.message === 'already_reacted';
}

async function addMedal(client: any, award: Award, medal: string): Promise<unknown | null> {
  if (!award.channel_id || !award.message_ts) return null;
  try {
    await client.reactions.add({ channel: award.channel_id, timestamp: award.message_ts, name: medal });
    return null;
  } catch (err) {
    return isAlreadyReacted(err) ? null : err;
  }
}

export async function applyMedals(db: Store, io: Io, date: string, game: Game) {
  if (db.hasMedalled(date, game)) return;
  const awards = db.getAwards(date, game);
  if (!awards.length) return;

  let failed = false;
  for (const [i, medal] of PODIUM_MEDALS.entries()) {
    const award = awards[i];
    if (!award) continue;
    const err = await addMedal(io.client, award, medal);
    if (!err) continue;
    failed = true;
    io.logger?.warn?.({ date, game, medal, err }, '[boom] failed to apply medal reaction');
  }
  if (!failed) db.markMedalled(date, game);
}
