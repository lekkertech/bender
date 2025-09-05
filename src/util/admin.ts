/**
 * Workspace admin/owner detection with lightweight caching and env allowlist.
 *
 * Requirements:
 * - Slack scope: users:read (for bot token) to read user.is_admin / user.is_owner via users.info
 * - Optional: ADMIN_USER_IDS=U123,U456 to force specific users as admins (bypass when Slack scopes are missing)
 */

type CacheEntry = { v: boolean; exp: number };

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map<string, CacheEntry>();

function now() {
  return Date.now();
}

function envAdmins(): Set<string> {
  const raw = (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(raw);
}

/**
 * Return true if the provided userId is a known admin/owner in the current workspace.
 * Strategy:
 * 1) Check ADMIN_USER_IDS allowlist (immediate true if listed).
 * 2) Check in-memory cache (TTL).
 * 3) Fallback to Slack API users.info (requires users:read) and cache the result.
 *
 * On API errors or missing scope, this returns false unless ADMIN_USER_IDS lists the user.
 *
 * @param client Slack Web API client (e.g., app.client from @slack/bolt)
 * @param userId Slack user ID (e.g., "U123...")
 * @param ttlMs Cache TTL in milliseconds (default 10 minutes)
 */
export async function isWorkspaceAdmin(
  client: { users?: { info?: (args: { user: string }) => Promise<any> } } | any,
  userId: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<boolean> {
  if (!userId) return false;

  // 1) Env allowlist
  if (envAdmins().has(userId)) return true;

  // 2) Cache
  const hit = cache.get(userId);
  if (hit && hit.exp > now()) {
    return hit.v;
  }

  // 3) Slack API
  try {
    const infoFn = client?.users?.info;
    if (typeof infoFn !== 'function') {
      // No client available; cache negative to avoid loops for ttlMs/10
      const v = false;
      cache.set(userId, { v, exp: now() + Math.max(10_000, Math.floor(ttlMs / 10)) });
      return v;
    }
    const res = await infoFn({ user: userId });
    // Expect shape: { ok: boolean, user?: { is_admin?: boolean, is_owner?: boolean } }
    const u = res?.user || {};
    const v = !!(u.is_admin || u.is_owner);
    cache.set(userId, { v, exp: now() + ttlMs });
    return v;
  } catch {
    // On any failure (rate limit, scope, network), keep a short negative cache
    const v = false;
    cache.set(userId, { v, exp: now() + Math.max(10_000, Math.floor(ttlMs / 10)) });
    return v;
  }
}

/**
 * Manually seed or override the cache for a specific user.
 */
export function setAdminCache(userId: string, isAdmin: boolean, ttlMs: number = DEFAULT_TTL_MS): void {
  if (!userId) return;
  cache.set(userId, { v: isAdmin, exp: now() + ttlMs });
}

/**
 * Invalidate cache for a specific user or all users.
 */
export function invalidateAdminCache(userId?: string): void {
  if (!userId) {
    cache.clear();
    return;
  }
  cache.delete(userId);
}

/**
 * Convenience: determine if a user should bypass rate limiting.
 * Currently identical to isWorkspaceAdmin but kept separate for future expansion.
 */
export async function shouldBypassRateLimit(
  client: any,
  userId: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<boolean> {
  return isWorkspaceAdmin(client, userId, ttlMs);
}

/*
Usage (Bolt middleware), bypassing a rate limiter:

import type { App, Middleware, SlackEventMiddlewareArgs } from '@slack/bolt';
import { RateLimiter } from '../util/rateLimit.js';
import { shouldBypassRateLimit } from '../util/admin.js';

const rl = new RateLimiter({ capacity: 5, refillTokens: 5, refillIntervalMs: 60_000 });

app.message(async ({ message, client, next, logger }) => {
  const userId = (message as any)?.user as string | undefined;
  if (!userId) return next?.();

  if (await shouldBypassRateLimit(client, userId)) {
    logger?.debug?.({ userId }, 'admin/owner bypassed rate limit');
    return next?.();
  }
  if (!rl.consume('user', userId)) {
    // Optionally inform or silently drop
    return;
  }
  await next?.();
});

Notes:
- Ensure your app's bot token has users:read scope to get user.is_admin/is_owner via users.info.
- As a fallback (or during testing), set ADMIN_USER_IDS in your environment to force bypass.
*/