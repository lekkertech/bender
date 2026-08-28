import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { DateTime } from 'luxon';
import { registerBoomFeature } from '../src/features/boom/index.ts';

type MessageHandler = (ctx: any) => Promise<void> | void;
type EventHandler = (ctx: any) => Promise<void> | void;

const ZONE = 'Africa/Johannesburg';
const WINDOW_MS = 5 * 60 * 1000;

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
    triggerMessage,
    triggerEvent,
    calls: { reactionsAddCalls, chatPostCalls, usersInfoCalls },
  };
}

/** Set the clock, then register the feature so its Store stamps the right cutover date. */
function bootAt(iso: string) {
  vi.setSystemTime(DateTime.fromISO(iso, { zone: ZONE }).toMillis());
  return setupFakeApp();
}

/** Let every open tally window close (5 minutes) and its timer callbacks settle. */
async function closeWindows() {
  await vi.advanceTimersByTimeAsync(WINDOW_MS + 1000);
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

  it('stays silent while a tally window is still open', async () => {
    const t = bootAt('2025-03-03T12:00:05');
    await t.triggerMessage({ text: ':boom:', user: 'U1', channel: 'C1', ts: toTs('2025-03-03T12:00:05') });
    await t.triggerMessage({ text: ':boom:', user: 'U2', channel: 'C1', ts: toTs('2025-03-03T12:00:06') });

    // Points are only assigned once the window closes: no medals, no announcement, no awards yet.
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 10_000);
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

    // Same day, still inside the noon hour, but boom has already settled
    await t.triggerMessage({ text: ':boom:', user: 'U3', channel: 'C1', ts: toTs('2025-03-03T12:10:00') });
    expect(clowned(t)).toEqual([toTs('2025-03-03T12:10:00')]);
    expect(reactions(t, 'clown_face')[0]).toMatchObject({ channel: 'C1' });
    // A closed-window entry is never acknowledged
    expect(acked(t)).not.toContain(toTs('2025-03-03T12:10:00'));

    const boom = readStore().awards['2025-03-03'].boom;
    expect(boom.map((a: any) => a.user_id).sort()).toEqual(['U1', 'U2']);

    // A late hadeda entry still opens its own window and scores normally
    await t.triggerMessage({ text: ':hadeda-boom:', user: 'U3', channel: 'C1', ts: toTs('2025-03-03T12:11:00') });
    await closeWindows();
    expect(readStore().awards['2025-03-03'].hadeda).toEqual([
      expect.objectContaining({ user_id: 'U3', points: 1 }),
    ]);
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
