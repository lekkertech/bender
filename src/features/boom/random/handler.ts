import type { Config } from '../../../env.js';
import { slackTsToSeconds } from '../../../util/slack.js';
import type { Store } from '../store.js';
import {
  detectAnyGameEmoji,
  detectGameFromMessage,
  inEntryWindow,
  localDayInfo,
  neededGamesForDate,
  type Game,
} from '../rules.js';
import type { Io } from './io.js';
import { catchUp, scheduleSettle, type Settler } from './settle.js';

const ACK_REACTION = 'white_check_mark';

export type Boom = {
  cfg: Config;
  db: Store;
  settler: Settler;
  notPlayedNotified: Set<string>;
};

type Post = {
  channel: string;
  user: string;
  ts: string;
  date: string;
  isWorkday: boolean;
  isHoliday: boolean;
  inWindow: boolean;
  emoji: Game | null;
  game: Game | null;
  neededGames: Game[];
};

export function createBoom(cfg: Config, db: Store, settler: Settler): Boom {
  return { cfg, db, settler, notPlayedNotified: new Set<string>() };
}

function inAllowedChannel(cfg: Config, channel?: string): boolean {
  if (!cfg.allowedChannels) return true;
  return channel ? cfg.allowedChannels.has(channel) : false;
}

function classify(cfg: Config, m: any): Post | null {
  if (!m || m.subtype || !m.user) return null;
  if (m.thread_ts && m.thread_ts !== m.ts) return null;
  if (!inAllowedChannel(cfg, m.channel)) return null;
  const ts = String(m.ts || '0');
  const seconds = slackTsToSeconds(ts);
  const { date, weekday, isWorkday, isHoliday } = localDayInfo(seconds);
  const text = m.text || '';
  return {
    channel: m.channel, user: m.user, ts, date, isWorkday, isHoliday,
    inWindow: inEntryWindow(seconds),
    emoji: detectAnyGameEmoji(text),
    game: detectGameFromMessage(text, weekday),
    neededGames: neededGamesForDate(date),
  };
}

async function react(client: any, post: Post, name: string) {
  try {
    await client.reactions.add({ channel: post.channel, timestamp: post.ts, name });
  } catch {}
}

async function clown(client: any, post: Post) {
  await react(client, post, 'clown_face');
}

async function noticeNotPlayed(boom: Boom, io: Io, post: Post) {
  if (!post.emoji || !post.inWindow || boom.notPlayedNotified.has(post.date)) return;
  boom.notPlayedNotified.add(post.date);
  const reason = post.isHoliday ? "it's a holiday" : "it's the weekend";
  await io.client.chat.postMessage({ channel: post.channel, text: `Boom isn't played today — ${reason}.` });
}

function isPastSettling(db: Store, post: Post, emoji: Game): boolean {
  return db.isResolved(post.date, emoji) || post.neededGames.every((g) => db.isResolved(post.date, g));
}

async function record(boom: Boom, io: Io, post: Post, game: Game) {
  const outcome = boom.db.addEntry(post.date, game, post.user, { ts: post.ts, channel_id: post.channel });
  if (outcome === 'redelivery') return;
  if (outcome === 'duplicate') return clown(io.client, post);
  scheduleSettle(boom.settler, io, post.date);
  await react(io.client, post, ACK_REACTION);
}

async function dispatch(boom: Boom, io: Io, post: Post) {
  if (post.emoji && !post.inWindow) return clown(io.client, post);
  if (!post.isWorkday) return noticeNotPlayed(boom, io, post);
  if (post.emoji && isPastSettling(boom.db, post, post.emoji)) return clown(io.client, post);
  if (!post.game) return;
  await record(boom, io, post, post.game);
}

export async function handleMessage(boom: Boom, io: Io, message: unknown) {
  try {
    const post = classify(boom.cfg, message);
    if (!post) return;
    await catchUp(boom.settler, io);
    await dispatch(boom, io, post);
  } catch (err) {
    io.logger?.error?.(err);
  }
}
