export type Io = { client: any; logger?: any };

export async function logFailures(io: Io, run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    io.logger?.error?.(err);
  }
}
