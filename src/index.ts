import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Load Bolt via CommonJS require to avoid ESM interop issues on Node 22/24
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bolt = require('@slack/bolt');
const App: any = bolt.App;
const ExpressReceiver: any = bolt.ExpressReceiver;
import { loadConfig } from './env.js';
import { TTLSet } from './dedupe.js';
import { registerHandlers } from './handlers.js';

// Capture unhandled errors for clearer diagnostics
process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UncaughtException:', err);
});

async function main() {
  const cfg = loadConfig();
  const dedupe = new TTLSet(5 * 60 * 1000); // 5 minutes

  let app: any;

  if (cfg.socketMode) {
    app = new App({
      token: cfg.botToken,
      appToken: cfg.appToken,
      socketMode: true,
      developerMode: process.env.NODE_ENV !== 'production',
      logLevel: cfg.logLevel,
    });
  } else {
    const receiver = new ExpressReceiver({
      signingSecret: cfg.signingSecret!,
      processBeforeResponse: true,
    });
    app = new App({
      token: cfg.botToken,
      receiver,
      developerMode: process.env.NODE_ENV !== 'production',
      logLevel: cfg.logLevel,
    });
  }

  // Global middleware: dedupe by event_id
  app.use(async ({ next, body, logger }: any) => {
    const id = (body as any)?.event_id as string | undefined;
    if (dedupe.has(id)) {
      logger?.debug?.({ id }, 'duplicate event ignored');
      return;
    }
    dedupe.add(id);
    const ev = (body as any)?.event || {};
    const summary = {
      id,
      type: ev.type,
      channel: ev.channel,
      user: ev.user,
      text: ev.text,
      team: (body as any)?.team_id,
    };
    if (cfg.logLevel === 'debug') {
      console.debug('Incoming Slack event:', summary);
    }
    await next?.();
  });

  registerHandlers(app, cfg);

  if (cfg.socketMode) {
    await app.start(process.env.PORT ? Number(process.env.PORT) : undefined);
    console.log('⚡️ Slack bot (Socket Mode) is running');
  } else {
    await app.start(cfg.port);
    console.log(`⚡️ Slack bot (HTTP) listening on :${cfg.port}`);
  }

  // Optional: periodic sweep for dedupe memory
  setInterval(() => dedupe.sweep(), 60 * 1000).unref?.();
}

main().catch((err) => {
  console.error('Fatal error starting Slack bot:', err);
  process.exitCode = 1;
});
