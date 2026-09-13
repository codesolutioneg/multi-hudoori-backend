/**
 * In-process job lock — prevents overlapping cron runs in this Node process.
 * Not a distributed queue: two API instances can still run the same job twice.
 */
const locks = new Map<string, boolean>();

export function isJobRunning(name: string): boolean {
  return locks.get(name) === true;
}

export async function runExclusive<T>(
  name: string,
  fn: () => Promise<T>,
  opts?: { onSkip?: () => void },
): Promise<T | undefined> {
  if (locks.get(name)) {
    opts?.onSkip?.();
    return undefined;
  }
  locks.set(name, true);
  try {
    return await fn();
  } finally {
    locks.set(name, false);
  }
}
