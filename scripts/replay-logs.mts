// Replay extracted Slack events through the new registered boom handler.
// Compares the resulting per-day podium against the production store and prints diffs.
import { readFileSync, mkdtempSync, rmSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DateTime } from 'luxon';
import { registerBoomFeature } from '/Users/zayinkrige/Downloads/slack-bot-ts/src/features/boom/index.ts';
import { Store } from '/Users/zayinkrige/Downloads/slack-bot-ts/src/features/boom/store.ts';

type Event = { ts: string; channel: string; user: string; text: string; thread_ts?: string };

const TZ = 'Africa/Johannesburg';
const PROD_STORE = JSON.parse(readFileSync('/tmp/slack-bot-replay/prod-store.json', 'utf8'));
const events: Event[] = readFileSync('/tmp/slack-bot-replay/events.jsonl', 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));

// Group events by SAST date
const byDate = new Map<string, Event[]>();
for (const e of events) {
  const sec = Number(e.ts.split('.')[0]);
  const dt = DateTime.fromSeconds(sec, { zone: TZ });
  const date = dt.toISODate()!;
  if (!byDate.has(date)) byDate.set(date, []);
  byDate.get(date)!.push(e);
}

const COPY_HOLIDAYS_FROM = '/Users/zayinkrige/Downloads/slack-bot-ts/data/holidays';

function setupFakeApp() {
  let messageHandler: any = null;
  const reactions: any[] = [];
  const posts: any[] = [];

  const client = {
    reactions: { add: async (args: any) => { reactions.push(args); return {}; } },
    chat: { postMessage: async (args: any) => { posts.push(args); return { ts: '1.0' }; } },
    users: { info: async ({ user }: any) => ({ user: { id: user, name: user, profile: { display_name: user, real_name: user } } }) },
  };
  const app: any = {
    message: (fn: any) => { messageHandler = fn; },
    event: (_n: string, _fn: any) => {},
  };
  const logger = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
  const cfg: any = { allowedChannels: new Set(['C0919MX7KJS']), features: new Set(['boom']), defaultReplyMode: 'thread' };
  registerBoomFeature(app, cfg);
  return { trigger: async (e: Event) => {
    const message: any = { type: 'message', text: e.text, user: e.user, channel: e.channel, ts: e.ts };
    if (e.thread_ts) message.thread_ts = e.thread_ts;
    await messageHandler({ message, client, logger });
  }, reactions, posts };
}

function podiumFromMessages(msgs: any[]): string[] {
  const earliest = new Map<string, { tsNum: number; tsStr: string }>();
  for (const m of msgs) {
    const t = Number(m.message_ts);
    const cur = earliest.get(m.user_id);
    if (!cur || t < cur.tsNum) earliest.set(m.user_id, { tsNum: t, tsStr: m.message_ts });
  }
  return Array.from(earliest.entries())
    .sort((a, b) => a[1].tsNum - b[1].tsNum)
    .map(([u]) => u).slice(0, 3);
}

// Per date, replay through fresh store; collect podium decisions and compare with production
const dates = [...byDate.keys()].sort();
const report: any[] = [];

for (const date of dates) {
  // Fresh temp cwd so holiday loader and store don't bleed between days
  const dir = mkdtempSync(join(tmpdir(), `replay-${date}-`));
  const prevCwd = process.cwd();
  process.chdir(dir);
  // Copy holiday files so isHoliday is correct
  mkdirSync(join(dir, 'data', 'holidays'), { recursive: true });
  for (const f of readdirSync(COPY_HOLIDAYS_FROM)) {
    copyFileSync(join(COPY_HOLIDAYS_FROM, f), join(dir, 'data', 'holidays', f));
  }

  const t = setupFakeApp();
  const dayEvents = byDate.get(date)!;
  // Replay in delivery order (= log appearance order)
  for (const e of dayEvents) await t.trigger(e);

  // Read the replay store to extract podiums
  const replayStore = JSON.parse(readFileSync(join(dir, 'data', 'store.json'), 'utf8'));
  const games: Array<'boom' | 'hadeda' | 'wednesday'> = ['boom', 'hadeda', 'wednesday'];
  const replayPodium: Record<string, string[]> = {};
  for (const g of games) {
    const msgs = replayStore.messages?.[date]?.[g] || [];
    replayPodium[g] = podiumFromMessages(msgs);
  }
  const prodPodium: Record<string, string[]> = {};
  for (const g of games) {
    const msgs = PROD_STORE.messages?.[date]?.[g] || [];
    prodPodium[g] = podiumFromMessages(msgs);
  }
  // Medal reactions issued during replay
  const medals = t.reactions.filter((r: any) => ['first_place_medal', 'second_place_medal', 'third_place_medal'].includes(r.name));

  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });

  // Diff
  const diffs: string[] = [];
  for (const g of games) {
    const a = replayPodium[g].join(',') || '(none)';
    const b = prodPodium[g].join(',') || '(none)';
    if (a !== b) diffs.push(`  ${g}: replay=[${a}]  prod=[${b}]`);
  }
  report.push({ date, diffs, medals: medals.length, posts: t.posts.length, eventsForDay: dayEvents.length });
}

let changedDays = 0;
console.log('==== Replay vs Production (per day) ====');
for (const r of report) {
  const tag = r.diffs.length ? 'DIFF' : 'same';
  console.log(`${r.date}  ${tag}  events=${r.eventsForDay}  medals=${r.medals}  posts=${r.posts}`);
  if (r.diffs.length) {
    changedDays++;
    for (const d of r.diffs) console.log(d);
  }
}
console.log('=========================================');
console.log(`days replayed: ${report.length}, days with podium changes: ${changedDays}`);
