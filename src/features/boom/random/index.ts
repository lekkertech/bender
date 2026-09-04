import type { App } from '@slack/bolt';
import type { Config } from '../../../env.js';
import type { Store } from '../store.js';
import { registerLeaderboard } from '../leaderboard.js';
import { createAnnouncer } from './announce.js';
import { catchUp, createSettler, startSweep } from './settle.js';
import { createBoom, handleMessage } from './handler.js';

export function registerRandomBoom(app: App, cfg: Config, db: Store) {
  const settler = createSettler(db, createAnnouncer(db));
  const boom = createBoom(cfg, db, settler);
  const sweepClient = (app as any).client;
  if (sweepClient) startSweep(settler, { client: sweepClient, logger: (app as any).logger });

  app.message(async ({ message, client, logger }) => {
    await handleMessage(boom, { client, logger }, message);
  });

  registerLeaderboard(app, cfg, db, (client, logger) => catchUp(settler, { client, logger }));
}
