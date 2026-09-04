import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { DateTime } from 'luxon';
import { registerBoomFeature } from '../src/features/boom/index.ts';
import { ENTRY_GRACE_MS, ENTRY_WINDOW_MS } from '../src/features/boom/rules.ts';

type MessageHandler = (ctx: any) => Promise<void> | void;
type EventHandler = (ctx: any) => Promise<void> | void;

const ZONE = 'Africa/Johannesburg';

/** Slack ts string for a local wall-clock time, with optional microseconds. */
function toTs(iso: string, micros = 0): string {
  const sec = Math.floor(DateTime.fromISO(iso, { zone: ZONE }).toSeconds());
  return `${sec}.${String(micros).padStart(6, '0')}`;
}

function toTsMicros(iso: string, micros: number): string {
  return toTs(iso, micros);
}

/** Epoch ms for a Slack ts string. */
function msOf(ts: string): number {
  return Math.round(Number(ts) * 1000);
}

function setupFakeApp() {
  let messageHandler: MessageHandler | null = null;
  const eventHandlers = new Map<string, EventHandler>();

  const reactionsAddCalls: any[] = [];
  const chatPostCalls: any[] = [];
  const usersInfoCalls: any[] = [];

  // Lets a test make Slack calls fail, to exercise the retry paths. failReactionIf may return an
  // Error to control the failure, or true for a generic one. Failed calls are not recorded.
  const control: {
    failIf: ((args: any) => boolean) | null;
    failReactionIf: ((args: any) => boolean | Error) | null;
  } = { failIf: null, failReactionIf: null };

  const client = {
    reactions: {
      add: async (args: any) => {
        const fail = control.failReactionIf?.(args);
        if (fail) throw fail instanceof Error ? fail : new Error('slack_error');
        reactionsAddCalls.push(args);
        return {};
      },
    },
    chat: {
      postMessage: async (args: any) => {
        if (control.failIf?.(args)) throw new Error('slack_error');
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

  async function triggerMessage({
    text,
    user,
    channel,
    ts,
    thread_ts,
    at,
  }: {
    text: string;
    user: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    /** Arrival time, when it differs from the message ts (out-of-order delivery). */
    at?: string;
  }) {
    if (!messageHandler) throw new Error('message handler not registered');
    // Messages arrive in real time: advance the clock to the arrival instant first.
    vi.setSystemTime(msOf(at ?? ts));
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
    control,
    triggerMessage,
    triggerEvent,
    calls: { reactionsAddCalls, chatPostCalls, usersInfoCalls },
  };
}

/**
 * Register the feature the day before the game day, then jump the clock to it. The Store stamps
 * the random-scoring cutover as the boot date, so this is "deployed yesterday" and the game day is
 * comfortably inside the random era.
 */
function bootAt(iso: string) {
  const target = DateTime.fromISO(iso, { zone: ZONE });
  vi.setSystemTime(target.minus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 }).toMillis());
  const t = setupFakeApp();
  vi.setSystemTime(target.toMillis());
  return t;
}

/** Let every open entry window close and settle (window + grace), running its timer callbacks. */
async function closeWindows() {
  await vi.advanceTimersByTimeAsync(ENTRY_WINDOW_MS + ENTRY_GRACE_MS + 1000);
}

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let prevCwd: string;

function readStore(): any {
  return JSON.parse(readFileSync(join(process.cwd(), 'data', 'store.json'), 'utf8'));
}

function postsMatching(t: ReturnType<typeof setupFakeApp>, needle: string) {
  return t.calls.chatPostCalls.filter((c) => typeof c.text === 'string' && c.text.includes(needle));
}

function reactions(t: ReturnType<typeof setupFakeApp>, name: string) {
  return t.calls.reactionsAddCalls.filter((r) => r.name === name);
}

/** Message timestamps that got the "entry accepted" tick. */
function acked(t: ReturnType<typeof setupFakeApp>) {
  return reactions(t, 'white_check_mark').map((r) => r.timestamp);
}

/** Message timestamps that got clowned. */
function clowned(t: ReturnType<typeof setupFakeApp>) {
  return reactions(t, 'clown_face').map((r) => r.timestamp);
}

/** Pull "N) <name> +Ppt" pairs out of one game's line in the daily results message. */
function parseAwards(text: string, emoji: string): Array<{ name: string; points: number }> {
  const line = text.split('\n').find((l) => l.startsWith(`• ${emoji} `));
  if (!line) return [];
  return [...line.matchAll(/\d+\)\s+(.+?)\s\+(\d+)pt/g)].map((m) => ({ name: m[1]!, points: Number(m[2]) }));
}

beforeEach(() => {
  // Isolate Store() persistence by running each test in a fresh temp CWD
  prevCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'boom-feature-'));
  process.chdir(dir);
  // Tally windows are wall-clock driven, so every test owns the clock.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  const dir = process.cwd();
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('Boom feature integration-like behavior', () => {
  it("does not award points on holidays and tells the user the game isn't played", async () => {
    vi.setSystemTime(DateTime.fromISO('2025-03-21T12:00:05', { zone: ZONE }).toMillis());

    // Seed a holiday file for the temp CWD, using JSONC-style comments to exercise robust parsing.
    const holidaysDir = join(process.cwd(), 'data', 'holidays');
    mkdirSync(holidaysDir, { recursive: true });
    writeFileSync(
      join(holidaysDir, 'za-2025.json'),
      '[\n  "2025-03-21", // Human Rights Day\n]\n',
      'utf8',
    );

    const t = setupFakeApp();

    await t.triggerMessage({
      text: ':boom:',
      user: 'U1',
      channel: 'C1',
      ts: toTs('2025-03-21T12:00:05'),
    });

    // No reactions (no points, no tally, no clowning in-window)
    expect(t.calls.reactionsAddCalls.length).toBe(0);

    // Explicit message to user
    expect(t.calls.chatPostCalls.length).toBe(1);
    expect(String(t.calls.chatPostCalls[0].text)).toContain("Boom isn't played today");
    expect(String(t.calls.chatPostCalls[0].text)).toContain('holiday');

    // No store updates for that date
    const raw = readStore();
    expect(raw.counts?.['2025-03-21']).toBeUndefined();
    expect(raw.placements?.['2025-03-21']).toBeUndefined();
    expect(raw.messages?.['2025-03-21']).toBeUndefined();
    expect(raw.awards?.['2025-03-21']).toBeUndefined();
  });

  it('adds clown reaction when game emoji posted outside noon window', async () => {
    const t = bootAt('2025-03-03T13:00:00');
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

  it('acknowledges each accepted entry as it arrives', async () => {
    const t = bootAt('2025-03-03T12:00:05');
    const first = toTs('2025-03-03T12:00:05');
    const second = toTs('2025-03-03T12:00:06');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: first });
    await t.triggerMessage({ text: '💥', user: 'U2', channel: 'C1', ts: second });

    // Every valid entry is ticked immediately, in the channel it was posted in
    expect(acked(t)).toEqual([first, second]);
    expect(t.calls.reactionsAddCalls[0]).toMatchObject({ channel: 'C1', name: 'white_check_mark' });
    expect(clowned(t)).toEqual([]);
  });

  it('stays silent while a entry window is still open', async () => {
    const t = bootAt('2025-03-03T12:00:05');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-03T12:00:05') });
    await t.triggerMessage({ text: ':boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-03T12:00:06') });

    // Points are only assigned once the window closes: no medals, no announcement, no awards yet.
    await vi.advanceTimersByTimeAsync(ENTRY_WINDOW_MS - 10_000);
    expect(reactions(t, 'first_place_medal')).toEqual([]);
    expect(reactions(t, 'second_place_medal')).toEqual([]);
    expect(t.calls.chatPostCalls.length).toBe(0);
    expect(readStore().awards?.['2025-03-03']?.boom).toBeUndefined();
  });

  it('gives every entrant a unique random 1..n score when the window closes (non-Wed)', async () => {
    const t = bootAt('2025-03-03T12:00:10'); // Monday: boom + hadeda needed

    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-03T12:00:10') });
    await t.triggerMessage({ text: ':boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-03T12:00:11') });
    await t.triggerMessage({ text: ':boom:', user: 'U3', channel: 'C1', ts: toTs('2025-03-03T12:00:12') });

    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U4', channel: 'C1', ts: toTs('2025-03-03T12:00:13') });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U5', channel: 'C1', ts: toTs('2025-03-03T12:00:14') });

    // Nothing announced until both windows have closed
    expect(postsMatching(t, 'Boom Game — Daily Podium').length).toBe(0);
    await closeWindows();

    const posts = postsMatching(t, 'Boom Game — Daily Podium');
    expect(posts.length).toBe(1);
    const text = posts[0].text as string;
    expect(text).toContain('(2025-03-03)');

    // 3 boom entrants split 3/2/1 in some order; 2 hadeda entrants split 2/1.
    const boom = parseAwards(text, ':boom:');
    expect(boom.map((a) => a.points).sort()).toEqual([1, 2, 3]);
    expect(boom.map((a) => a.name).sort()).toEqual(['User U1', 'User U2', 'User U3']);
    const hadeda = parseAwards(text, ':hadeda-boom:');
    expect(hadeda.map((a) => a.points).sort()).toEqual([1, 2]);
    expect(hadeda.map((a) => a.name).sort()).toEqual(['User U4', 'User U5']);

    // Highest score is listed first for each game
    expect(boom[0].points).toBe(3);
    expect(hadeda[0].points).toBe(2);

    // Daily announcement must not notify listed users: no <@id> mentions anywhere in it.
    expect(text).not.toContain('<@');

    // Week-to-date leaderboard totals match the settled awards
    expect(text).toContain('Leaderboard (week-to-date):');
    const awards = readStore().awards['2025-03-03'];
    expect(awards.boom.map((a: any) => a.points).sort()).toEqual([1, 2, 3]);
    expect(awards.hadeda.map((a: any) => a.points).sort()).toEqual([1, 2]);
  });

  it('scales to nine entrants: one gets 9 points, the next 8, down to 1', async () => {
    const t = bootAt('2025-03-03T12:00:00');

    const users = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9'];
    for (let i = 0; i < users.length; i++) {
      await t.triggerMessage({
        text: ':hadeda-boom:',
        user: users[i]!,
        channel: 'C1',
        ts: toTs(`2025-03-03T12:00:${String(i + 1).padStart(2, '0')}`),
      });
    }
    // A single boom entrant so the day can complete
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-03T12:00:20') });

    await closeWindows();

    const text = postsMatching(t, 'Boom Game — Daily Podium')[0].text as string;
    const hadeda = parseAwards(text, ':hadeda-boom:');
    expect(hadeda.length).toBe(9);
    expect(hadeda.map((a) => a.points).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(hadeda[0].points).toBe(9);
    expect(new Set(hadeda.map((a) => a.name)).size).toBe(9);

    // A lone entrant scores 1
    expect(parseAwards(text, ':boom:')).toEqual([{ name: 'User U1', points: 1 }]);
  });

  it('medals the three biggest point earners, not the fastest posters', async () => {
    const t = bootAt('2025-03-03T12:00:01');
    // rng always 0 → deterministic assignment: 2nd entrant 3pt, 1st entrant 2pt, 3rd entrant 1pt
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const first = toTs('2025-03-03T12:00:01');
    const second = toTs('2025-03-03T12:00:02');
    const third = toTs('2025-03-03T12:00:03');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: first });
    await t.triggerMessage({ text: ':boom:', user: 'U2', channel: 'C1', ts: second });
    await t.triggerMessage({ text: ':boom:', user: 'U3', channel: 'C1', ts: third });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U4', channel: 'C1', ts: toTs('2025-03-03T12:00:04') });

    // Entries are acknowledged on arrival; medals wait for the window to close
    expect(acked(t).length).toBe(4);
    expect(reactions(t, 'first_place_medal')).toEqual([]);
    await closeWindows();

    const medalFor = (name: string) => reactions(t, name).map((r) => r.timestamp);
    // U2 drew 3pt, U1 2pt, U3 1pt — medals follow the points, not the post order
    expect(medalFor('first_place_medal')).toEqual([second, toTs('2025-03-03T12:00:04')]);
    expect(medalFor('second_place_medal')).toEqual([first]);
    expect(medalFor('third_place_medal')).toEqual([third]);

    const text = postsMatching(t, 'Boom Game — Daily Podium')[0].text as string;
    expect(text).toContain(':boom: 1) User U2 +3pt  2) User U1 +2pt  3) User U3 +1pt');
    // Only one entrant in hadeda: it takes gold and 1 point
    expect(text).toContain(':hadeda-boom: 1) User U4 +1pt');
  });

  it('ignores and clowns repeat posts from a user who already has an entry', async () => {
    const t = bootAt('2025-03-03T12:00:00');

    const uaFirst = toTsMicros('2025-03-03T12:00:00', 100000);
    const uaRepeats = [toTsMicros('2025-03-03T12:00:00', 200000), toTsMicros('2025-03-03T12:00:00', 300000)];
    await t.triggerMessage({ text: ':boom:', user: 'UA', channel: 'C1', ts: uaFirst });
    for (const ts of uaRepeats) {
      await t.triggerMessage({ text: ':boom:', user: 'UA', channel: 'C1', ts });
    }
    const ubTs = toTsMicros('2025-03-03T12:00:01', 0);
    await t.triggerMessage({ text: ':boom:', user: 'UB', channel: 'C1', ts: ubTs });
    // The same user may still enter a different game
    const uaHadeda = toTsMicros('2025-03-03T12:00:02', 0);
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'UA', channel: 'C1', ts: uaHadeda });

    // Only the first entry per user per game is acknowledged; the repeats are clowned
    expect(acked(t)).toEqual([uaFirst, ubTs, uaHadeda]);
    expect(clowned(t)).toEqual(uaRepeats);

    await closeWindows();

    const raw = readStore();
    // Duplicates never reach the tally: counts equal the number of entrants
    expect(raw.counts['2025-03-03'].boom).toBe(2);
    expect(raw.messages['2025-03-03'].boom.map((m: any) => m.message_ts)).toEqual([uaFirst, ubTs]);
    // n = 2, so points are exactly 2 and 1
    expect(raw.awards['2025-03-03'].boom.map((a: any) => a.points).sort()).toEqual([1, 2]);
    expect(raw.awards['2025-03-03'].boom.map((a: any) => a.user_id).sort()).toEqual(['UA', 'UB']);
  });

  it('drops a redelivery of an already-recorded entry without clowning it', async () => {
    const t = bootAt('2025-03-03T12:00:00');
    const ts = toTs('2025-03-03T12:00:00');

    await t.triggerMessage({ text: ':boom:', user: 'UA', channel: 'C1', ts });
    // Same message delivered again (Slack retry): not a repeat post, so no clown and no second tick
    await t.triggerMessage({ text: ':boom:', user: 'UA', channel: 'C1', ts, at: toTs('2025-03-03T12:00:30') });

    expect(acked(t)).toEqual([ts]);
    expect(clowned(t)).toEqual([]);
    expect(readStore().counts['2025-03-03'].boom).toBe(1);
  });

  it('accepts an entry sent inside the window but delivered during the grace period', async () => {
    const t = bootAt('2025-03-03T12:00:00');
    const firstTs = toTs('2025-03-03T12:00:00');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: firstTs });

    // Sent 12:04:59 (inside the window, which shuts at 12:05:00), delivered 12:05:03 — settling is
    // deferred to 12:05:05, so the entry still counts instead of being clowned as too late.
    const graceTs = toTs('2025-03-03T12:04:59');
    await t.triggerMessage({
      text: ':boom:',
      user: 'U2',
      channel: 'C1',
      ts: graceTs,
      at: toTs('2025-03-03T12:05:03'),
    });
    expect(acked(t)).toEqual([firstTs, graceTs]);
    expect(clowned(t)).toEqual([]);

    // Delivered after settling, points are already assigned: unavoidably too late
    const tooLateTs = toTs('2025-03-03T12:04:58');
    await t.triggerMessage({
      text: ':boom:',
      user: 'U3',
      channel: 'C1',
      ts: tooLateTs,
      at: toTs('2025-03-03T12:20:00'),
    });
    expect(clowned(t)).toEqual([tooLateTs]);

    const boom = readStore().awards['2025-03-03'].boom;
    expect(boom.map((a: any) => a.user_id).sort()).toEqual(['U1', 'U2']);
    expect(boom.map((a: any) => a.points).sort()).toEqual([1, 2]);
  });

  it('runs 12:00:00 to 12:05:00 whatever time the first entry lands', async () => {
    const t = bootAt('2025-03-03T11:59:00');

    // Too early: the window has not opened yet.
    const earlyTs = toTs('2025-03-03T11:59:59');
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U0', channel: 'C1', ts: earlyTs });

    // The window does not start when the first person posts — it opened at noon regardless, so a
    // first entry at 12:04:00 gets 60 seconds, not a fresh 5 minutes.
    const firstTs = toTs('2025-03-03T12:04:00');
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U1', channel: 'C1', ts: firstTs });
    const lastTs = toTs('2025-03-03T12:04:59');
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U2', channel: 'C1', ts: lastTs });
    expect(acked(t)).toEqual([firstTs, lastTs]);

    // 12:05:01 is late even though only a minute of tallying happened.
    const lateTs = toTs('2025-03-03T12:05:01');
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U3', channel: 'C1', ts: lateTs });
    expect(clowned(t)).toEqual([earlyTs, lateTs]);

    await closeWindows();
    const hadeda = readStore().awards['2025-03-03'].hadeda;
    expect(hadeda.map((a: any) => a.user_id).sort()).toEqual(['U1', 'U2']);
  });

  it('retries a daily announcement lost to a failed Slack post', async () => {
    const t = bootAt('2025-03-03T12:00:00');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-03T12:00:00') });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-03T12:00:01') });

    let failures = 1;
    t.control.failIf = () => failures-- > 0;
    await closeWindows();

    // Points are settled, but the results post failed and must not be marked announced
    expect(readStore().awards['2025-03-03'].boom.length).toBe(1);
    expect(postsMatching(t, 'Daily Podium').length).toBe(0);
    expect(readStore().daily_announced['2025-03-03']).toBeUndefined();

    // The next message drives the catch-up, which retries the announcement
    await t.triggerMessage({ text: 'hello', user: 'U9', channel: 'C1', ts: toTs('2025-03-03T12:40:00') });
    expect(postsMatching(t, 'Daily Podium').length).toBe(1);
    expect(readStore().daily_announced['2025-03-03']).toBeDefined();
  });

  it('retries medal reactions lost to a failed Slack call', async () => {
    const t = bootAt('2025-03-03T12:00:00');
    const boomTs = toTs('2025-03-03T12:00:00');
    const hadedaTs = toTs('2025-03-03T12:00:01');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: boomTs });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U2', channel: 'C1', ts: hadedaTs });

    // Both games' medals fail as they settle. Points are already flushed at that moment, so
    // without a retry the medals would be lost for good.
    let medalFailures = 2;
    t.control.failReactionIf = (args: any) => String(args.name).endsWith('_place_medal') && medalFailures-- > 0;
    await closeWindows();

    expect(reactions(t, 'first_place_medal')).toEqual([]);
    expect(readStore().medalled['2025-03-03']).toBeUndefined();
    // The day itself is settled and announced regardless
    expect(postsMatching(t, 'Daily Podium').length).toBe(1);

    // The next message retries just the medals
    await t.triggerMessage({ text: 'hello', user: 'U9', channel: 'C1', ts: toTs('2025-03-03T12:40:00') });
    expect(reactions(t, 'first_place_medal').map((r) => r.timestamp).sort()).toEqual([boomTs, hadedaTs].sort());
    expect(readStore().medalled['2025-03-03']).toEqual({
      boom: expect.any(String),
      hadeda: expect.any(String),
    });
    expect(postsMatching(t, 'Daily Podium').length).toBe(1);

    // Once marked, they are never re-applied
    await t.triggerMessage({ text: 'hello again', user: 'U9', channel: 'C1', ts: toTs('2025-03-03T12:45:00') });
    expect(reactions(t, 'first_place_medal').length).toBe(2);
  });

  it('treats a medal that is already on the message as applied', async () => {
    const t = bootAt('2025-03-03T12:00:00');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-03T12:00:00') });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-03T12:00:01') });

    // Slack rejects a reaction that is already there; that must not loop forever as a "failure"
    const alreadyReacted: any = new Error('An API error occurred: already_reacted');
    alreadyReacted.data = { ok: false, error: 'already_reacted' };
    t.control.failReactionIf = (args: any) =>
      String(args.name).endsWith('_place_medal') ? alreadyReacted : false;
    await closeWindows();

    expect(readStore().medalled['2025-03-03']).toEqual({
      boom: expect.any(String),
      hadeda: expect.any(String),
    });
  });

  it('retries a lost Friday crown without re-posting the daily results', async () => {
    const t = bootAt('2025-03-07T12:00:00');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-07T12:00:00') });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-07T12:00:01') });

    // Only the crown post fails, and only once
    let crownFailures = 1;
    t.control.failIf = (args: any) => String(args.text).includes('Weekly Crown') && crownFailures-- > 0;
    await closeWindows();

    expect(postsMatching(t, 'Daily Podium').length).toBe(1);
    expect(postsMatching(t, 'Weekly Crown').length).toBe(0);
    expect(readStore().weekly_crowned['2025-W10']).toBeUndefined();
    // And no persisted record of a crown nobody saw
    expect(readStore().weekly_kings['2025-W10']).toBeUndefined();

    await t.triggerMessage({ text: 'hello', user: 'U9', channel: 'C1', ts: toTs('2025-03-07T12:40:00') });

    // The crown is retried on its own; the already-posted results are not repeated
    expect(postsMatching(t, 'Weekly Crown').length).toBe(1);
    expect(postsMatching(t, 'Daily Podium').length).toBe(1);
    expect(readStore().weekly_crowned['2025-W10']).toBeDefined();
    expect(readStore().weekly_kings['2025-W10']).toMatchObject({ winners: expect.any(Array) });
  });

  it('counts out-of-order deliveries that arrive inside the window', async () => {
    const t = bootAt('2025-03-03T12:00:01');
    const late = toTsMicros('2025-03-03T12:00:00', 800000);
    const early = toTsMicros('2025-03-03T12:00:00', 100000);

    // Delivered newest-first: both were sent inside the window, so both count.
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: late, at: toTs('2025-03-03T12:00:01') });
    await t.triggerMessage({ text: ':boom:', user: 'U2', channel: 'C1', ts: early, at: toTs('2025-03-03T12:00:02') });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U3', channel: 'C1', ts: toTs('2025-03-03T12:00:03') });

    await closeWindows();

    const boom = readStore().awards['2025-03-03'].boom;
    expect(boom.map((a: any) => a.user_id).sort()).toEqual(['U1', 'U2']);
    expect(boom.map((a: any) => a.points).sort()).toEqual([1, 2]);
  });

  it('clowns entries that land after their game window closed and awards them nothing', async () => {
    const t = bootAt('2025-03-03T12:00:00');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-03T12:00:00') });
    await t.triggerMessage({ text: ':boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-03T12:00:01') });

    await closeWindows();
    expect(readStore().awards['2025-03-03'].boom.length).toBe(2);

    // Same day, still inside the noon hour, but the window shut at 12:05
    await t.triggerMessage({ text: ':boom:', user: 'U3', channel: 'C1', ts: toTs('2025-03-03T12:10:00') });
    expect(clowned(t)).toEqual([toTs('2025-03-03T12:10:00')]);
    expect(reactions(t, 'clown_face')[0]).toMatchObject({ channel: 'C1' });
    // A closed-window entry is never acknowledged
    expect(acked(t)).not.toContain(toTs('2025-03-03T12:10:00'));

    const boom = readStore().awards['2025-03-03'].boom;
    expect(boom.map((a: any) => a.user_id).sort()).toEqual(['U1', 'U2']);

    // A late hadeda entry gets no window of its own: the day's single window is already shut.
    const lateHadeda = toTs('2025-03-03T12:11:00');
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U3', channel: 'C1', ts: lateHadeda });
    await closeWindows();
    expect(clowned(t)).toContain(lateHadeda);
    expect(readStore().awards['2025-03-03'].hadeda).toEqual([]);
    expect(postsMatching(t, 'Boom Game — Daily Podium').length).toBe(1);
  });

  it('settles a window abandoned by a restart on the next message', async () => {
    const first = bootAt('2025-03-03T12:00:00');
    await first.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-03T12:00:00') });
    await first.triggerMessage({ text: ':hadeda-boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-03T12:00:01') });

    // Simulate a restart mid-window: pending timers die with the old process.
    vi.clearAllTimers();
    const restarted = setupFakeApp();
    expect(readStore().awards?.['2025-03-03']).toBeUndefined();

    // Any later message drives the catch-up, using the channel recorded with the entries.
    await restarted.triggerMessage({ text: 'hello', user: 'U9', channel: 'C1', ts: toTs('2025-03-03T12:30:00') });

    const posts = postsMatching(restarted, 'Boom Game — Daily Podium');
    expect(posts.length).toBe(1);
    expect(posts[0].channel).toBe('C1');
    const awards = readStore().awards['2025-03-03'];
    expect(awards.boom).toEqual([expect.objectContaining({ user_id: 'U1', points: 1 })]);
    expect(awards.hadeda).toEqual([expect.objectContaining({ user_id: 'U2', points: 1 })]);
  });

  it('posts a Friday Weekly Crown once the Friday windows have closed', async () => {
    const week = '2025-W10'; // ISO week containing 2025-03-03 .. 2025-03-07
    const dataDir = join(process.cwd(), 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'store.json'),
      JSON.stringify({
        placements: {},
        counts: {},
        daily_announced: {},
        weekly_crowned: {},
        weekly_kings: {},
        // UZ carries an unassailable lead into Friday (max Friday haul is 3+3).
        weekly_adjustments: { [week]: { UZ: 100, UA: 1, UB: 1 } },
        messages: {},
        awards: {},
      }),
      'utf8',
    );

    const t = bootAt('2025-03-07T12:00:01');

    await t.triggerMessage({ text: ':boom:', user: 'UZ', channel: 'C1', ts: toTs('2025-03-07T12:00:01') });
    await t.triggerMessage({ text: ':boom:', user: 'UA', channel: 'C1', ts: toTs('2025-03-07T12:00:02') });
    await t.triggerMessage({ text: ':boom:', user: 'UB', channel: 'C1', ts: toTs('2025-03-07T12:00:03') });

    // No crown while the day is unsettled
    expect(postsMatching(t, 'Weekly Crown').length).toBe(0);

    await t.triggerMessage({ text: ':hadeda-boom:', user: 'UZ', channel: 'C1', ts: toTs('2025-03-07T12:00:04') });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'UA', channel: 'C1', ts: toTs('2025-03-07T12:00:05') });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'UB', channel: 'C1', ts: toTs('2025-03-07T12:00:06') });
    expect(postsMatching(t, 'Weekly Crown').length).toBe(0);

    await closeWindows();

    const podiumIdx = t.calls.chatPostCalls.findIndex((c) => String(c.text).includes('Daily Podium'));
    const crownIdx = t.calls.chatPostCalls.findIndex((c) => String(c.text).includes('Weekly Crown'));
    expect(podiumIdx).toBeGreaterThanOrEqual(0);
    // Crown posts once, after the daily results message
    expect(postsMatching(t, 'Weekly Crown').length).toBe(1);
    expect(crownIdx).toBeGreaterThan(podiumIdx);

    // The crown total is the baseline plus UZ's two settled random awards
    const awards = readStore().awards['2025-03-07'];
    const uzTotal = ['boom', 'hadeda'].reduce(
      (sum, g) => sum + awards[g].find((a: any) => a.user_id === 'UZ').points,
      100,
    );
    const crownText = t.calls.chatPostCalls[crownIdx].text as string;
    expect(crownText).toContain('2025-03-03 to 2025-03-07');
    expect(crownText).toContain('<@UZ>');
    expect(crownText).toContain(`${uzTotal} pts`);
  });

  it('ignores thread replies (does not award points or react)', async () => {
    const t = bootAt('2025-03-03T12:00:05');
    // Boom emoji posted as a reply in a thread rooted on a prior day
    await t.triggerMessage({
      text: ':boom:',
      user: 'U1',
      channel: 'C1',
      ts: toTs('2025-03-03T12:00:05'),
      thread_ts: toTs('2025-03-02T09:00:00'),
    });
    await closeWindows();
    expect(t.calls.reactionsAddCalls.length).toBe(0);
    expect(t.calls.chatPostCalls.length).toBe(0);
    const raw = readStore();
    expect(raw.messages?.['2025-03-03']?.boom ?? []).toEqual([]);
    expect(raw.counts?.['2025-03-03']).toBeUndefined();
    expect(raw.awards?.['2025-03-03']).toBeUndefined();
  });

  it('app_mention leaderboard "no data" path posts empty leaderboard and no crown', async () => {
    const t = bootAt('2025-03-05T12:00:00');

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

  it('app_mention leaderboard reflects settled random points', async () => {
    const t = bootAt('2025-03-03T12:00:00');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-03T12:00:00') });
    await t.triggerMessage({ text: ':boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-03T12:00:01') });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-03T12:00:02') });
    await closeWindows();

    await t.triggerEvent('app_mention', {
      type: 'app_mention',
      user: 'U1',
      channel: 'C1',
      text: '<@UBOT> leaderboard',
      ts: toTs('2025-03-03T13:00:00'),
    });

    const board = postsMatching(t, 'Boom Game — Leaderboard (week-to-date)');
    expect(board.length).toBe(1);
    const awards = readStore().awards['2025-03-03'];
    const u1 =
      awards.boom.find((a: any) => a.user_id === 'U1').points +
      awards.hadeda.find((a: any) => a.user_id === 'U1').points;
    expect(board[0].text).toContain(`User U1 — ${u1} pt`);
  });
});

/**
 * Upstream fixed these against the 3-2-1 podium, where a game that never reached three entrants
 * left the day unannounced forever. Random scoring settles each game on its own timer, so a short
 * game is no longer special — but a needed game *nobody* entered still has no window to close, and
 * would stall the day's results (and a Friday crown) if the noon close did not settle it empty.
 */
describe('Boom feature: needed games that go unplayed', () => {
  it('announces a game that closed with only two entrants', async () => {
    const t = bootAt('2025-03-10T12:00:00');
    for (const u of ['U1', 'U2', 'U3']) {
      await t.triggerMessage({ text: ':boom:', user: u, channel: 'C1', ts: toTs(`2025-03-10T12:00:0${u[1]}`) });
    }
    for (const u of ['U1', 'U2']) {
      await t.triggerMessage({ text: ':hadeda-boom:', user: u, channel: 'C1', ts: toTs(`2025-03-10T12:01:0${u[1]}`) });
    }

    // Windows still open: the day stays silent.
    expect(t.calls.chatPostCalls.length).toBe(0);

    await closeWindows();

    const text = String(postsMatching(t, 'Daily Podium')[0].text);
    expect(text).toContain('Daily Podium (2025-03-10)');
    // Two entrants share the two available amounts, in some order.
    const hadeda = parseAwards(text, ':hadeda-boom:');
    expect(hadeda.map((a) => a.points).sort()).toEqual([1, 2]);
    expect(hadeda.map((a) => a.name).sort()).toEqual(['User U1', 'User U2']);
    expect(readStore().daily_announced['2025-03-10']).toBeTruthy();
  });

  it('settles a needed game nobody played when the window shuts, and says so', async () => {
    const t = bootAt('2025-03-10T12:00:00');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-10T12:00:01') });
    expect(t.calls.chatPostCalls.length).toBe(0);

    // One window covers the whole day, so hadeda settles empty alongside boom rather than
    // stalling the day on a game nobody played.
    await closeWindows();

    const text = String(postsMatching(t, 'Daily Podium')[0].text);
    expect(text).toContain(':hadeda-boom: — no entries');
    expect(parseAwards(text, ':boom:')).toEqual([{ name: 'User U1', points: 1 }]);
    expect(readStore().awards['2025-03-10'].hadeda).toEqual([]);
  });

  it('crowns the week on a Friday where a needed game went unplayed', async () => {
    const t = bootAt('2025-03-14T12:00:00');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-14T12:00:01') });
    expect(postsMatching(t, 'Weekly Crown').length).toBe(0);

    await closeWindows();

    expect(postsMatching(t, 'Daily Podium').length).toBe(1);
    expect(postsMatching(t, 'Weekly Crown').length).toBe(1);
    expect(readStore().weekly_crowned['2025-W11']).toBeTruthy();
  });

  it('leaves a fully-played day alone once it is older than the retry window', async () => {
    const t = bootAt('2025-03-10T12:00:00');
    // Every needed game played, so nothing but the retry bound stands between this day and a post.
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-10T12:00:01') });
    await t.triggerMessage({ text: ':boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-10T12:00:02') });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-10T12:01:01') });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-10T12:01:02') });

    // The timers never fire (the process was down). Three weeks on, someone says hello: the day
    // may settle, but resurrecting its podium into the channel is worse than never posting it.
    vi.setSystemTime(DateTime.fromISO('2025-03-31T09:00:00', { zone: ZONE }).toMillis());
    await t.triggerMessage({ text: 'hello', user: 'U9', channel: 'C1', ts: toTs('2025-03-31T09:00:01') });

    expect(t.calls.chatPostCalls).toEqual([]);
    expect(readStore().daily_announced['2025-03-10']).toBeUndefined();
  });

  it('leaves a stalled part-played day alone once it is older than the retry window', async () => {
    const t = bootAt('2025-03-10T12:00:00');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-10T12:00:01') });

    vi.setSystemTime(DateTime.fromISO('2025-03-17T09:00:00', { zone: ZONE }).toMillis());
    await t.triggerMessage({ text: 'hi', user: 'U9', channel: 'C1', ts: toTs('2025-03-17T09:00:01') });

    expect(t.calls.chatPostCalls).toEqual([]);
    expect(readStore().daily_announced['2025-03-10']).toBeUndefined();
  });

  it('does not announce a workday nobody played at all', async () => {
    const t = bootAt('2025-03-10T12:00:00');
    // Chatter only: no game emoji, so there is nothing to settle or announce.
    await t.triggerMessage({ text: 'morning', user: 'U1', channel: 'C1', ts: toTs('2025-03-10T12:00:01') });

    vi.setSystemTime(DateTime.fromISO('2025-03-10T13:00:01', { zone: ZONE }).toMillis());
    await t.triggerMessage({ text: 'hi', user: 'U9', channel: 'C1', ts: toTs('2025-03-10T13:00:02') });

    expect(t.calls.chatPostCalls.length).toBe(0);
    expect(readStore().daily_announced['2025-03-10']).toBeUndefined();
  });
});

describe('Boom feature: announcement regressions', () => {
  it('tells the channel the game is off once per weekend day, not once per poster', async () => {
    const t = bootAt('2025-03-15T12:00:00');
    for (const u of ['U1', 'U2', 'U3']) {
      await t.triggerMessage({ text: ':boom:', user: u, channel: 'C1', ts: toTs(`2025-03-15T12:00:0${u[1]}`) });
    }
    expect(t.calls.chatPostCalls.length).toBe(1);
    expect(String(t.calls.chatPostCalls[0].text)).toContain("Boom isn't played today");
  });

  it('scores and posts the day it was deployed on', async () => {
    vi.setSystemTime(DateTime.fromISO('2025-03-10T09:00:00', { zone: ZONE }).toMillis());
    const t = setupFakeApp();

    for (const u of ['U1', 'U2']) {
      await t.triggerMessage({ text: ':boom:', user: u, channel: 'C1', ts: toTs(`2025-03-10T12:00:0${u[1]}`) });
      await t.triggerMessage({ text: ':hadeda-boom:', user: u, channel: 'C1', ts: toTs(`2025-03-10T12:01:0${u[1]}`) });
    }
    await closeWindows();

    const text = String(postsMatching(t, 'Daily Podium')[0].text);
    expect(text).toContain('Daily Podium (2025-03-10)');
    expect(parseAwards(text, ':boom:').map((a) => a.points).sort()).toEqual([1, 2]);
    expect(readStore().daily_announced['2025-03-10']).toBeTruthy();
    expect(readStore().scoring['2025-03-10']).toBe('random');
  });

  it('posts a single podium when two messages settle the day in the same tick', async () => {
    const t = bootAt('2025-03-10T12:00:00');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-10T12:00:01') });
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-10T12:00:02') });

    // Both windows have closed but their timers never ran (as after a restart), so the catch-up on
    // each incoming message settles the day. Delivered together, each starts before the other ends.
    vi.setSystemTime(DateTime.fromISO('2025-03-10T12:30:00', { zone: ZONE }).toMillis());
    await Promise.all([
      t.triggerMessage({ text: 'hi', user: 'U8', channel: 'C1', ts: toTs('2025-03-10T12:30:01') }),
      t.triggerMessage({ text: 'there', user: 'U9', channel: 'C1', ts: toTs('2025-03-10T12:30:02') }),
    ]);

    expect(postsMatching(t, 'Daily Podium').length).toBe(1);
  });
});
