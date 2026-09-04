import type { App } from '@slack/bolt';
import type { Config } from '../../env.js';
import { Store } from './store.js';
import { registerRandomBoom } from './random/index.js';

export function registerBoomFeature(app: App, cfg: Config) {
  const db = new Store();
  registerRandomBoom(app, cfg, db);
}
