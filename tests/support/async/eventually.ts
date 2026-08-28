/**
 * Poll an assertion until it passes or the attempt budget runs out.
 *
 * Use for asynchronous conditions that settle within a short window (process
 * exit, background task completion, session record flush). The last thrown
 * error is re-thrown so failures surface a meaningful message instead of a
 * generic timeout.
 */
export async function eventually(
  assertion: () => void | Promise<void>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 500;
  const intervalMs = options.intervalMs ?? 5;
  const startedAt = performance.now();
  let lastError: unknown;
  while (true) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      if (performance.now() - startedAt >= timeoutMs) break;
      await Bun.sleep(intervalMs);
    }
  }
  throw lastError;
}
