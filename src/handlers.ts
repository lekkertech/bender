import type { App } from '@slack/bolt';
import type { Config } from './env.js';
import { registerFeatures } from './features/index.js';

// Central registration entrypoint.
// Delegates to modular features based on cfg.features (see env.ts).
export function registerHandlers(app: App, cfg: Config) {
  registerFeatures(app, cfg);
}
