import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { DateTime } from 'luxon';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBoomFeature } from '../src/features/boom/index.ts';
import { ENTRY_GRACE_MS, ENTRY_WINDOW_MS } from '../src/features/boom/rules.ts';

type MessageHandler = (ctx: any) => Promise<void> | void;

const ZONE = 'Africa/Johannesburg';

function toTs(iso: string, micros = 0): string {
  const sec = Math.floor(DateTime.fromISO(iso, { zone: ZONE }).toSeconds());
  return `${sec}.${String(micros).padStart(6, '0')}`;
}

function msOf(ts: string): number {
  return Math.round(Number(ts) * 1000);
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

  /** `at` is the delivery instant, which for out-of-order delivery is not the message ts. */
  async function triggerMessage({ text, user, ts, at }: { text: string; user: string; ts: string; at?: string }) {
    if (!messageHandler) throw new Error('message handler not registered');
    vi.setSystemTime(msOf(at ?? ts));
    await messageHandler({ message: { type: 'message', text, user, channel: 'C1', ts }, client, logger });
  }

  return { triggerMessage, calls: { reactionsAddCalls, chatPostCalls } };
}

/** Deploy the day before, so the game day falls in the random-scoring era. */
function bootAt(iso: string) {
  const target = DateTime.fromISO(iso, { zone: ZONE });
  vi.setSystemTime(target.minus({ days: 1 }).set({ hour: 9 }).startOf('hour').toMillis());
  const t = setupFakeApp();
  vi.setSystemTime(target.toMillis());
  return t;
}

let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'boom-race-'));
  process.chdir(dir);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  const dir = process.cwd();
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

// 2026-08-31 incident: bryan posted :hadeda-boom: 3rd by message ts, but Slack delivered Sean's
// later message first. Under the old 3-2-1 podium the third slot was already taken by the time
// bryan's event arrived, so he was clowned off a podium he had earned.
//
// Random scoring removes the slot that could be taken: every unique entrant inside the tally
// window is recorded and scores, whatever order the events arrive in. These tests replay the
// incident to hold that property.
describe('entry recording under out-of-order delivery', () => {
  const D = '2025-03-03'; // a Monday, not a holiday

  it('records a straggler whose event arrives after four later posters', async () => {
    const t = bootAt(`${D}T12:00:01`);
    const hadeda = ':hadeda-boom:';

    const zH = { text: hadeda, user: 'Z', ts: toTs(`${D}T12:00:01`) };
    const jesseH = { text: hadeda, user: 'JESSE', ts: toTs(`${D}T12:00:06`) };
    const bryanH = { text: hadeda, user: 'BRYAN', ts: toTs(`${D}T12:00:07`) };
    const seanH = { text: hadeda, user: 'SEAN', ts: toTs(`${D}T12:00:08`) };

    // Production journald order: sean's event landed before jesse's and bryan's.
    await t.triggerMessage({ ...zH, at: toTs(`${D}T12:00:01`) });
    // The day's other needed game, so the day can announce on its own timers.
    await t.triggerMessage({ text: ':boom:', user: 'Z', ts: toTs(`${D}T12:00:02`) });
    await t.triggerMessage({ ...seanH, at: toTs(`${D}T12:00:09`) });
    await t.triggerMessage({ ...jesseH, at: toTs(`${D}T12:00:10`) });
    await t.triggerMessage({ ...bryanH, at: toTs(`${D}T12:00:11`) });

    const clowns = t.calls.reactionsAddCalls.filter((r) => r.name === 'clown_face').map((r) => r.timestamp);
    const acks = t.calls.reactionsAddCalls.filter((r) => r.name === 'white_check_mark').map((r) => r.timestamp);

    // Nobody is clowned for arriving late in the queue; all four are in the tally.
    expect(clowns).toEqual([]);
    expect(acks).toEqual(expect.arrayContaining([zH.ts, seanH.ts, jesseH.ts, bryanH.ts]));

    await vi.advanceTimersByTimeAsync(ENTRY_WINDOW_MS + ENTRY_GRACE_MS + 1000);

    const podium = t.calls.chatPostCalls.find((p) => String(p.text).includes('Daily Podium'));
    expect(podium).toBeTruthy();
    const line = String(podium.text)
      .split('\n')
      .find((l) => l.startsWith('• :hadeda-boom: '))!;
    const scored = [...line.matchAll(/\d+\)\s+(.+?)\s\+(\d+)pt/g)].map((m) => ({ user: m[1], points: Number(m[2]) }));
    // Four entrants, four distinct amounts, and everyone who posted got one.
    expect(scored.map((s) => s.user).sort()).toEqual(['BRYAN', 'JESSE', 'SEAN', 'Z']);
    expect(scored.map((s) => s.points).sort()).toEqual([1, 2, 3, 4]);
  });

  it('accepts a microsecond-close pair delivered newest first', async () => {
    const t = bootAt(`${D}T12:00:01`);
    const early = toTs(`${D}T12:00:00`, 100000);
    const late = toTs(`${D}T12:00:00`, 900000);

    await t.triggerMessage({ text: ':boom:', user: 'A', ts: late, at: toTs(`${D}T12:00:01`) });
    await t.triggerMessage({ text: ':boom:', user: 'B', ts: early, at: toTs(`${D}T12:00:02`) });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'A', ts: toTs(`${D}T12:00:03`) });

    expect(t.calls.reactionsAddCalls.filter((r) => r.name === 'clown_face')).toEqual([]);

    await vi.advanceTimersByTimeAsync(ENTRY_WINDOW_MS + ENTRY_GRACE_MS + 1000);

    const podium = t.calls.chatPostCalls.find((p) => String(p.text).includes('Daily Podium'));
    const line = String(podium.text)
      .split('\n')
      .find((l) => l.startsWith('• :boom: '))!;
    expect([...line.matchAll(/\d+\)\s+(.+?)\s\+(\d+)pt/g)].map((m) => m[1]).sort()).toEqual(['A', 'B']);
  });
});
