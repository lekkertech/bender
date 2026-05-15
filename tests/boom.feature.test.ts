import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { DateTime } from 'luxon';
import { registerBoomFeature } from '../src/features/boom/index.ts';

type MessageHandler = (ctx: any) => Promise<void> | void;
type EventHandler = (ctx: any) => Promise<void> | void;

function toTs(iso: string, zone = 'Africa/Johannesburg'): string {
  const sec = Math.floor(DateTime.fromISO(iso, { zone }).toSeconds());
  return `${sec}.000000`;
}

function toTsMicros(iso: string, micros: number, zone = 'Africa/Johannesburg'): string {
  const sec = Math.floor(DateTime.fromISO(iso, { zone }).toSeconds());
  return `${sec}.${String(micros).padStart(6, '0')}`;
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

  async function triggerMessage({ text, user, channel, ts, thread_ts }: { text: string; user: string; channel: string; ts: string; thread_ts?: string }) {
    if (!messageHandler) throw new Error('message handler not registered');
    const message: any = { type: 'message', text, user, channel, ts };
    if (thread_ts) message.thread_ts = thread_ts;
    await messageHandler({ message, client, logger });
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

  it('defers all podium reactions until announce (no per-arrival reactions)', async () => {
    const t = setupFakeApp();
    await t.triggerMessage({
      text: ':boom:',
      user: 'U1',
      channel: 'C1',
      ts: toTs('2025-03-03T12:00:05'),
    });
    // No reactions added eagerly on arrival; medals are applied at announce time
    expect(t.calls.reactionsAddCalls.length).toBe(0);
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

  it('announcement orders podium by message ts when WebSocket delivers out-of-order', async () => {
    const t = setupFakeApp();
    const day = '2025-03-03'; // Monday
    // Delivery order: U1 (latest ts), U2 (earliest ts), U3 (middle ts)
    // Expected podium by ts: U2, U3, U1
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTsMicros(`${day}T12:00:00`, 800000) });
    await t.triggerMessage({ text: ':boom:', user: 'U2', channel: 'C1', ts: toTsMicros(`${day}T12:00:00`, 100000) });
    await t.triggerMessage({ text: ':boom:', user: 'U3', channel: 'C1', ts: toTsMicros(`${day}T12:00:00`, 500000) });

    // Hadeda podium (in-order) to trigger daily announcement
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U4', channel: 'C1', ts: toTsMicros(`${day}T12:00:01`, 0) });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U5', channel: 'C1', ts: toTsMicros(`${day}T12:00:02`, 0) });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U6', channel: 'C1', ts: toTsMicros(`${day}T12:00:03`, 0) });

    const podium = t.calls.chatPostCalls.find((c) => typeof c.text === 'string' && c.text.includes('Daily Podium'));
    expect(podium).toBeDefined();
    const text = podium!.text as string;
    expect(text).toMatch(/:boom: 1\) <@U2> \+3pt {2}2\) <@U3> \+2pt {2}3\) <@U1> \+1pt/);
  });

  it('announcement handles microsecond-close out-of-order delivery correctly', async () => {
    const t = setupFakeApp();
    const day = '2025-03-03';
    // Two boom messages with ts differing by 1 microsecond, delivered in reverse order
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTsMicros(`${day}T12:00:00`, 255560) }); // later by 1us
    await t.triggerMessage({ text: ':boom:', user: 'U2', channel: 'C1', ts: toTsMicros(`${day}T12:00:00`, 255559) }); // earlier
    await t.triggerMessage({ text: ':boom:', user: 'U3', channel: 'C1', ts: toTsMicros(`${day}T12:00:01`, 0) });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U1', channel: 'C1', ts: toTsMicros(`${day}T12:00:01`, 0) });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U2', channel: 'C1', ts: toTsMicros(`${day}T12:00:02`, 0) });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U3', channel: 'C1', ts: toTsMicros(`${day}T12:00:03`, 0) });

    const podium = t.calls.chatPostCalls.find((c) => typeof c.text === 'string' && c.text.includes('Daily Podium'));
    expect(podium).toBeDefined();
    const text = podium!.text as string;
    // U2 (ts ...255559) must beat U1 (ts ...255560) despite arriving second
    expect(text).toMatch(/:boom: 1\) <@U2> \+3pt {2}2\) <@U1> \+2pt {2}3\) <@U3> \+1pt/);
  });

  it('applies gold/silver/bronze medals to the correct messages under out-of-order delivery', async () => {
    const t = setupFakeApp();
    const day = '2025-03-03';
    // Boom: delivery order [U1 late, U2 early, U3 middle]; expected by ts: U2 gold, U3 silver, U1 bronze
    const boomLate = toTsMicros(`${day}T12:00:00`, 800000);
    const boomEarly = toTsMicros(`${day}T12:00:00`, 100000);
    const boomMid = toTsMicros(`${day}T12:00:00`, 500000);
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: boomLate });
    await t.triggerMessage({ text: ':boom:', user: 'U2', channel: 'C1', ts: boomEarly });
    await t.triggerMessage({ text: ':boom:', user: 'U3', channel: 'C1', ts: boomMid });

    // No reactions yet — deferred until both games complete podium
    expect(t.calls.reactionsAddCalls.length).toBe(0);

    // Hadeda podium also out-of-order: delivery [U4 late, U5 early, U6 middle]
    const hadLate = toTsMicros(`${day}T12:00:10`, 800000);
    const hadEarly = toTsMicros(`${day}T12:00:10`, 100000);
    const hadMid = toTsMicros(`${day}T12:00:10`, 500000);
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U4', channel: 'C1', ts: hadLate });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U5', channel: 'C1', ts: hadEarly });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U6', channel: 'C1', ts: hadMid });

    const byName = (name: string) => t.calls.reactionsAddCalls.filter((r) => r.name === name);
    const gold = byName('first_place_medal').map((r) => r.timestamp).sort();
    const silver = byName('second_place_medal').map((r) => r.timestamp).sort();
    const bronze = byName('third_place_medal').map((r) => r.timestamp).sort();

    // Gold on the earliest-ts message in each game
    expect(gold).toEqual([boomEarly, hadEarly].sort());
    // Silver on the middle-ts message in each game
    expect(silver).toEqual([boomMid, hadMid].sort());
    // Bronze on the latest-ts message in each game
    expect(bronze).toEqual([boomLate, hadLate].sort());

    // Total reactions: exactly 3 per game, no duplicates from arrival order
    expect(t.calls.reactionsAddCalls.length).toBe(6);
  });

  it('ignores thread replies (does not award points or react)', async () => {
    const t = setupFakeApp();
    // Boom emoji posted as a reply in a thread rooted on a prior day
    await t.triggerMessage({
      text: ':boom:',
      user: 'U1',
      channel: 'C1',
      ts: toTs('2025-03-03T12:00:05'),
      thread_ts: toTs('2025-03-02T09:00:00'),
    });
    expect(t.calls.reactionsAddCalls.length).toBe(0);
    expect(t.calls.chatPostCalls.length).toBe(0);
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'data', 'store.json'), 'utf8')) as any;
    expect(raw.messages?.['2025-03-03']?.boom ?? []).toEqual([]);
    expect(raw.counts?.['2025-03-03']).toBeUndefined();
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
