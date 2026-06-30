/**
 * Resolve a Slack user's display name via users.info.
 * Falls back to real_name, then username, then the raw userId.
 */
export async function getDisplayName(client: any, userId: string): Promise<string> {
  try {
    const info = await client.users.info({ user: userId });
    const user = (info as any)?.user;
    const profile = user?.profile || {};
    return (
      (profile.display_name && String(profile.display_name).trim()) ||
      (profile.real_name && String(profile.real_name).trim()) ||
      (user?.name ? String(user.name) : userId)
    );
  } catch {
    return userId;
  }
}

/**
 * Build a cached display-name resolver. Use to render names instead of <@id>
 * mentions so listed users are not notified, while avoiding repeat users.info calls.
 */
export function makeDisplayNameResolver(client: any): (userId: string) => Promise<string> {
  const cache = new Map<string, string>();
  return async (userId: string): Promise<string> => {
    const cached = cache.get(userId);
    if (cached !== undefined) return cached;
    const name = await getDisplayName(client, userId);
    cache.set(userId, name);
    return name;
  };
}

/** Extract the integer seconds portion from a Slack message timestamp. */
export function slackTsToSeconds(ts: string): number {
  return Math.floor(Number(String(ts || '0').split('.')[0] || '0'));
}
