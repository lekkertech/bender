import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { DateTime } from 'luxon';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBoomFeature } from '../src/features/boom/index.ts';

type MessageHandler = (ctx: any) => Promise<void> | void;

function toTs(iso: string, zone = 'Africa/Johannesburg'): string {
  const sec = Math.floor(DateTime.fromISO(iso, { zone }).toSeconds());
  return `${sec}.000000`;
}

function setupFakeApp() {
  let messageHandler: MessageHandler | null = null;
  const reactionsAddCalls: any[] = [];
  const chatPostCalls: any[] = [];

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
      info: async ({ user }: { user: string }) => ({
        user: { id: user, name: user, profile: { display_name: user, real_name: user } },
      }),
    },
  };

  const app: any = {
    message: (fn: MessageHandler) => {
      messageHandler = fn;
    },
    event: () => {},
  };

  const logger = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
  const cfg: any = { allowedChannels: undefined, features: new Set(['boom']), defaultReplyMode: 'thread' };
  registerBoomFeature(app, cfg);

  async function triggerMessage({ text, user, ts }: { text: string; user: string; ts: string }) {
    if (!messageHandler) throw new Error('message handler not registered');
    await messageHandler({ message: { type: 'message', text, user, channel: 'C1', ts }, client, logger });
  }

  return { triggerMessage, calls: { reactionsAddCalls, chatPostCalls } };
}

let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'boom-race-'));
  process.chdir(dir);
  process.env.BOOM_ANNOUNCE_GRACE_MS = '0';
});

afterEach(() => {
  const dir = process.cwd();
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

// 2026-08-31 incident: bryan posted :hadeda-boom: 3rd by message ts, but Slack delivered
// Sean's later message first. The clown gate ran before addPlacement, so bryan was clowned
// and never recorded; Sean kept bronze despite the later ts.
describe('podium placement under out-of-order delivery', () => {
  const D = '2025-03-03'; // a Monday, not a holiday

  it('awards 3rd place by message ts even when a later message is delivered first', async () => {
    const t = setupFakeApp();
    const boom = ':boom:';
    const hadeda = ':hadeda-boom:';

    // Channel ts order (as rendered in Slack):
    const events = [
      { text: hadeda, user: 'Z', ts: toTs(`${D}T12:00:01`) },
      { text: boom, user: 'Z', ts: toTs(`${D}T12:00:02`) },
      { text: boom, user: 'JESSE', ts: toTs(`${D}T12:00:03`) },
      { text: boom, user: 'SEAN', ts: toTs(`${D}T12:00:04`) },
      { text: boom, user: 'BRYAN', ts: toTs(`${D}T12:00:05`) }, // 4th in boom: clown is correct
      { text: hadeda, user: 'BRYAN', ts: toTs(`${D}T12:00:07`) }, // 2nd in hadeda by ts
      { text: hadeda, user: 'SEAN', ts: toTs(`${D}T12:00:08`) }, // 3rd in hadeda by ts
    ];
    const bryanHadeda = events[5];
    const seanHadeda = events[6];

    // Delivery order: Sean's hadeda arrives before bryan's (out-of-order WebSocket delivery).
    const delivery = [...events.slice(0, 5), seanHadeda, bryanHadeda];
    for (const e of delivery) await t.triggerMessage(e);

    const clowns = t.calls.reactionsAddCalls.filter((r) => r.name === 'clown_face').map((r) => r.timestamp);
    const silver = t.calls.reactionsAddCalls.filter((r) => r.name === 'second_place_medal').map((r) => r.timestamp);
    const bronze = t.calls.reactionsAddCalls.filter((r) => r.name === 'third_place_medal').map((r) => r.timestamp);

    // bryan's boom (4th) is clowned; his hadeda (2nd by ts, delivered last) must place, not clown.
    expect(clowns).toContain(events[4].ts);
    expect(clowns).not.toContain(bryanHadeda.ts);
    expect(silver).toContain(bryanHadeda.ts);
    expect(bronze).toContain(seanHadeda.ts);

    // Announced podium ranks by ts, not delivery order.
    const podiumPost = t.calls.chatPostCalls.find((p) => String(p.text).includes('Daily Podium'));
    expect(podiumPost).toBeTruthy();
    const hadedaLine = String(podiumPost.text)
      .split('\n')
      .find((l) => l.includes(':hadeda-boom:'));
    expect(hadedaLine).toContain('2) BRYAN +2pt');
    expect(hadedaLine).toContain('3) SEAN +1pt');
  });

  it('holds the announcement for the grace window so a straggler delivered after the full house still places', async () => {
    // Real 2026-08-31 delivery order: bryan's hadeda (3rd by ts) arrived AFTER sean's (4th by ts)
    // had filled the podium. Without a grace window the announcement fires before bryan lands.
    process.env.BOOM_ANNOUNCE_GRACE_MS = '5000';
    vi.useFakeTimers();
    try {
      const t = setupFakeApp();
      const boom = ':boom:';
      const hadeda = ':hadeda-boom:';

      const zH = { text: hadeda, user: 'Z', ts: toTs(`${D}T12:00:01`) };
      const zB = { text: boom, user: 'Z', ts: toTs(`${D}T12:00:02`) };
      const jesseB = { text: boom, user: 'JESSE', ts: toTs(`${D}T12:00:03`) };
      const seanB = { text: boom, user: 'SEAN', ts: toTs(`${D}T12:00:04`) };
      const bryanB = { text: boom, user: 'BRYAN', ts: toTs(`${D}T12:00:05`) };
      const jesseH = { text: hadeda, user: 'JESSE', ts: toTs(`${D}T12:00:06`) };
      const bryanH = { text: hadeda, user: 'BRYAN', ts: toTs(`${D}T12:00:07`) };
      const seanH = { text: hadeda, user: 'SEAN', ts: toTs(`${D}T12:00:08`) };

      // Delivery order as seen in production journald: sean's hadeda before jesse's and bryan's.
      for (const e of [zH, zB, jesseB, seanB, bryanB, seanH, jesseH]) await t.triggerMessage(e);

      // Full house reached (z, sean, jesse recorded in hadeda) but grace holds the announcement.
      expect(t.calls.chatPostCalls.length).toBe(0);

      // Straggler with the earlier ts lands during the grace window.
      await t.triggerMessage(bryanH);

      await vi.advanceTimersByTimeAsync(5000);

      const bronze = t.calls.reactionsAddCalls.filter((r) => r.name === 'third_place_medal').map((r) => r.timestamp);
      const clowns = t.calls.reactionsAddCalls.filter((r) => r.name === 'clown_face').map((r) => r.timestamp);
      expect(bronze).toContain(bryanH.ts);
      expect(bronze).not.toContain(seanH.ts);
      expect(clowns).toContain(bryanB.ts);
      expect(clowns).not.toContain(bryanH.ts);

      const podiumPost = t.calls.chatPostCalls.find((p) => String(p.text).includes('Daily Podium'));
      expect(podiumPost).toBeTruthy();
      const hadedaLine = String(podiumPost.text)
        .split('\n')
        .find((l) => l.includes(':hadeda-boom:'));
      expect(hadedaLine).toContain('3) BRYAN +1pt');
    } finally {
      vi.useRealTimers();
    }
  });
});
