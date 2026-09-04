import type { App } from '@slack/bolt';
import type { Config } from '../../../env.js';
import { inChannelSet } from '../../../util/channels.js';
import { slackTsToSeconds } from '../../../util/slack.js';
import type { Store } from '../store.js';
import { registerLeaderboard } from '../leaderboard.js';
import {
  detectAnyGameEmoji,
  detectGameFromMessage,
  inEntryWindow,
  localDayInfo,
  neededGamesForDate,
  type Game,
} from '../rules.js';
import {
  catchUp,
  logFailures,
  scheduleSettle,
  startSweep,
  type Io,
  type Settler,
} from './settle.js';

const ACK_REACTION = 'white_check_mark';

type Boom = {
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

function classify(cfg: Config, m: any): Post | null {
  if (!m || m.subtype || !m.user) return null;
  if (m.thread_ts && m.thread_ts !== m.ts) return null;
  if (!inChannelSet(cfg.allowedChannels, m.channel)) return null;
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
  if (outcome === 'duplicate') return react(io.client, post, 'clown_face');
  scheduleSettle(boom.settler, io, post.date);
  await react(io.client, post, ACK_REACTION);
}

async function dispatch(boom: Boom, io: Io, post: Post) {
  if (post.emoji && !post.inWindow) return react(io.client, post, 'clown_face');
  if (!post.isWorkday) return noticeNotPlayed(boom, io, post);
  if (post.emoji && isPastSettling(boom.db, post, post.emoji)) return react(io.client, post, 'clown_face');
  if (!post.game) return;
  await record(boom, io, post, post.game);
}

async function handleMessage(boom: Boom, io: Io, message: unknown) {
  await logFailures(io, async () => {
    const post = classify(boom.cfg, message);
    if (!post) return;
    await catchUp(boom.settler, io);
    await dispatch(boom, io, post);
  });
}

export function registerRandomBoom(app: App, cfg: Config, db: Store) {
  const settler: Settler = { db, announcing: new Set<string>(), timers: new Map() };
  const boom: Boom = { cfg, db, settler, notPlayedNotified: new Set<string>() };
  const sweepClient = (app as any).client;
  if (sweepClient) startSweep(settler, { client: sweepClient, logger: (app as any).logger });

  app.message(async ({ message, client, logger }) => {
    await handleMessage(boom, { client, logger }, message);
  });

  registerLeaderboard(app, cfg, db, (client, logger) => catchUp(settler, { client, logger }));
}
