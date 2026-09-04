import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/env.ts';

describe('BOOM_SCORING', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.BOOM_SCORING;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.BOOM_SCORING;
    else process.env.BOOM_SCORING = prev;
  });

  it('defaults to random', () => {
    delete process.env.BOOM_SCORING;
    expect(loadConfig().boomScoring).toBe('random');
  });

  it('accepts legacy', () => {
    process.env.BOOM_SCORING = 'legacy';
    expect(loadConfig().boomScoring).toBe('legacy');
  });

  it('rejects an unrecognised value', () => {
    process.env.BOOM_SCORING = 'randomised';
    expect(() => loadConfig()).toThrow(/BOOM_SCORING/);
  });
});
