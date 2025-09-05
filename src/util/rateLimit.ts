type Bucket = {
  tokens: number;
  lastRefillMs: number;
};

export type RateLimiterOptions = {
  capacity: number; // max tokens
  refillTokens: number; // tokens added each interval
  refillIntervalMs: number; // interval length
};

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private opts: RateLimiterOptions) {}

  private keyFor(scope: string, id: string) {
    return `${scope}:${id}`;
  }

  private refill(b: Bucket) {
    const now = Date.now();
    if (now <= b.lastRefillMs) return;
    const elapsed = now - b.lastRefillMs;
    const intervals = Math.floor(elapsed / this.opts.refillIntervalMs);
    if (intervals > 0) {
      const add = intervals * this.opts.refillTokens;
      b.tokens = Math.min(this.opts.capacity, b.tokens + add);
      b.lastRefillMs += intervals * this.opts.refillIntervalMs;
    }
  }

  /**
   * Try to consume 1 token for a given scope/id (e.g., scope='user', id='U123').
   * Returns true if allowed, false if rate-limited.
   */
  consume(scope: 'user' | 'channel', id: string): boolean {
    const k = this.keyFor(scope, id);
    let b = this.buckets.get(k);
    if (!b) {
      b = { tokens: this.opts.capacity, lastRefillMs: Date.now() };
      this.buckets.set(k, b);
    }
    this.refill(b);
    if (b.tokens > 0) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }
}