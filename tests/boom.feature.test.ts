import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { DateTime } from 'luxon';
import { registerBoomFeature } from '../src/features/boom/index.ts';

type MessageHandler = (ctx: any) => Promise<void> | void;
type EventHandler = (ctx: any) => Promise<void> | void;

function toTs(iso: string, zone = 'Africa/Johannesburg'): string {
  const sec = Math.floor(DateTime.fromISO(iso, { zone }).toSeconds());
  return `${sec}.000000`;
}

function setupFakeApp() {
  let messageHandler: MessageHandler | null = null;
  const eventHandlers = new Map<string, EventHandler>();

  const reactionsAddCalls: any[] = [];
  const chatPostCalls: any[] = [];
  const usersInfoCalls: any[] = [];

  const client = {
    reactions: {
      add: async (args: any) => {
        reactionsAddCalls.push(args);
        return {};
      },
    },
    chat: {
      postMessage: async (args: any) => {
        chatPostCalls.push(args);
        return { ts: '1.23' };
      },
    },
    users: {
      info: async ({ user }: { user: string }) => {
        usersInfoCalls.push(user);
        return {
          user: {
            id: user,
            name: `user_${user}`,
            profile: {
              display_name: `User ${user}`,
              real_name: `Real ${user}`,
            },
          },
        };
      },
    },
  };

  const app: any = {
    message: (fn: MessageHandler) => {
      messageHandler = fn;
    },
    event: (name: string, fn: EventHandler) => {
      eventHandlers.set(name, fn);
    },
  };

  const logger = {
    error: (_e?: any) => {},
    info: (_m?: any) => {},
    warn: (_m?: any) => {},
    debug: (_m?: any) => {},
  };

  const cfg: any = {
    allowedChannels: undefined,
    features: new Set(['boom']),
    defaultReplyMode: 'thread',
  };

  // Register handlers under test
  registerBoomFeature(app, cfg);

  async function triggerMessage({ text, user, channel, ts }: { text: string; user: string; channel: string; ts: string }) {
    if (!messageHandler) throw new Error('message handler not registered');
    await messageHandler({ message: { type: 'message', text, user, channel, ts }, client, logger });
  }

  async function triggerEvent(name: string, event: any) {
    const h = eventHandlers.get(name);
    if (!h) throw new Error(`event handler not registered: ${name}`);
    await h({ event, client, logger });
  }

  return {
    app,
    client,
    logger,
    triggerMessage,
    triggerEvent,
    calls: { reactionsAddCalls, chatPostCalls, usersInfoCalls },
  };
}

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let prevCwd: string;

beforeEach(() => {
  // Isolate Store() persistence by running each test in a fresh temp CWD
  prevCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'boom-feature-'));
  process.chdir(dir);
});

afterEach(() => {
  const dir = process.cwd();
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('Boom feature integration-like behavior', () => {
  it("does not award points on holidays and tells the user the game isn't played", async () => {
    const t = setupFakeApp();

    // Seed a holiday file for the temp CWD, using JSONC-style comments to exercise robust parsing.
    const holidaysDir = join(process.cwd(), 'data', 'holidays');
    mkdirSync(holidaysDir, { recursive: true });
    writeFileSync(
      join(holidaysDir, 'za-2025.json'),
      '[\n  "2025-03-21", // Human Rights Day\n]\n',
      'utf8',
    );

    await t.triggerMessage({
      text: ':boom:',
      user: 'U1',
      channel: 'C1',
      ts: toTs('2025-03-21T12:00:05'),
    });

    // No reactions (no points, no podium, no clowning in-window)
    expect(t.calls.reactionsAddCalls.length).toBe(0);

    // Explicit message to user
    expect(t.calls.chatPostCalls.length).toBe(1);
    expect(String(t.calls.chatPostCalls[0].text)).toContain("Boom isn't played today");
    expect(String(t.calls.chatPostCalls[0].text)).toContain('holiday');

    // No store updates for that date
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'data', 'store.json'), 'utf8')) as any;
    expect(raw.counts?.['2025-03-21']).toBeUndefined();
    expect(raw.placements?.['2025-03-21']).toBeUndefined();
    expect(raw.messages?.['2025-03-21']).toBeUndefined();
  });

  it('adds clown reaction when game emoji posted outside noon window', async () => {
    const t = setupFakeApp();
    await t.triggerMessage({
      text: ':boom:',
      user: 'U1',
      channel: 'C1',
      ts: toTs('2025-03-03T13:00:00'),
    });
    expect(t.calls.reactionsAddCalls.length).toBe(1);
    expect(t.calls.reactionsAddCalls[0]).toMatchObject({
      channel: 'C1',
      name: 'clown_face',
    });
    // No messages should be posted
    expect(t.calls.chatPostCalls.length).toBe(0);
  });

  it('reacts with game emoji for first place during noon window', async () => {
    const t = setupFakeApp();
    await t.triggerMessage({
      text: ':boom:',
      user: 'U1',
      channel: 'C1',
      ts: toTs('2025-03-03T12:00:05'),
    });
    // First place adds reaction with the specific emoji name
    expect(t.calls.reactionsAddCalls.length).toBe(1);
    expect(t.calls.reactionsAddCalls[0]).toMatchObject({
      channel: 'C1',
      name: 'boom',
    });
    // No daily announcement yet
    expect(t.calls.chatPostCalls.length).toBe(0);
  });

  it('posts a daily podium announcement once both games reach 3 valid posts (non-Wed)', async () => {
    const t = setupFakeApp();
    // Monday (neededGames: boom, hadeda)
    const baseTs = '2025-03-03T12:00:10';

    // Boom podium U1, U2, U3
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs(baseTs) });
    await t.triggerMessage({ text: ':boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-03T12:00:11') });
    await t.triggerMessage({ text: ':boom:', user: 'U3', channel: 'C1', ts: toTs('2025-03-03T12:00:12') });

    // Hadeda podium U4, U5, U6
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U4', channel: 'C1', ts: toTs('2025-03-03T12:00:13') });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U5', channel: 'C1', ts: toTs('2025-03-03T12:00:14') });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U6', channel: 'C1', ts: toTs('2025-03-03T12:00:15') });

    // Daily announcement should have been posted exactly once
    const postCalls = t.calls.chatPostCalls.filter((c) => typeof c.text === 'string' && c.text.includes('Boom Game — Daily Podium'));
    expect(postCalls.length).toBe(1);
    const text = postCalls[0].text as string;
    expect(text).toContain('(2025-03-03)');
    expect(text).toContain(':boom:');
    expect(text).toContain(':hadeda-boom:');
  });

  it('posts a Friday Weekly Crown after the first Friday boom placement', async () => {
    const t = setupFakeApp();
    // Seed earlier week placements to create scores
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-03T12:00:01') }); // +5
    await t.triggerMessage({ text: ':boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-03T12:00:02') }); // +3
    await t.triggerMessage({ text: ':boom:', user: 'U3', channel: 'C1', ts: toTs('2025-03-03T12:00:03') }); // +1

    // On Friday, first boom placement by U1 should trigger crown
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-07T12:00:05') }); // +5

    const crownCalls = t.calls.chatPostCalls.filter((c) => typeof c.text === 'string' && c.text.includes('Boom Game — Weekly Crown'));
    expect(crownCalls.length).toBe(1);
    const crownText = crownCalls[0].text as string;
    expect(crownText).toContain('2025-03-03 to 2025-03-07');
    expect(crownText).toMatch(/Winner(s)?: .*<@U1>/);
  });

  it('app_mention leaderboard "no data" path posts empty leaderboard and no crown', async () => {
    const t = setupFakeApp();

    // Trigger mention with only a mention token and the keyword
    await t.triggerEvent('app_mention', {
      type: 'app_mention',
      user: 'UQ',
      channel: 'C1',
      text: '<@UBOT> leaderboard',
      ts: toTs('2025-03-05T12:00:00'),
    });

    const posts = t.calls.chatPostCalls;
    expect(posts.length).toBe(1);
    const p = posts[0];
    expect(p.text).toContain('Boom Game — Leaderboard (week-to-date)');
    expect(p.text).toContain('No results yet this week.');
    // Crown context shows none
    expect(p.text).toContain('Current king(s): none crowned yet');
    // Blocks present as well
    expect(Array.isArray(p.blocks)).toBe(true);
    expect(p.blocks.length).toBeGreaterThan(0);
  });
});
