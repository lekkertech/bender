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

/** Extract the integer seconds portion from a Slack message timestamp. */
export function slackTsToSeconds(ts: string): number {
  return Math.floor(Number(String(ts || '0').split('.')[0] || '0'));
}
