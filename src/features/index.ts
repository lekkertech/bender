import type { App } from '@slack/bolt';
import type { Config } from '../env.js';
import { registerBoomFeature } from './boom/index.js';
import { registerChatFeature } from './chat/index.js';

// Feature registry: call per-feature registrars in a defined order.
// Chat is registered before Boom to ensure non-leaderboard mentions are handled there first.
export function registerFeatures(app: App, cfg: Config): void {
  const order = ['chat', 'boom'] as const;
  for (const feature of order) {
    if (!cfg.features.has(feature)) continue;
    switch (feature) {
      case 'chat':
        registerChatFeature(app, cfg);
        break;
      case 'boom':
        registerBoomFeature(app, cfg);
        break;
    }
  }
}