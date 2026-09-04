export function inChannelSet(set: Set<string> | undefined, channel?: string): boolean {
  if (!set) return true;
  return channel ? set.has(channel) : false;
}
