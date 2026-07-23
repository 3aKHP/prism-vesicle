/**
 * Poll an assertion until it passes or the attempt budget runs out.
 *
 * Use for asynchronous conditions that settle within a short window (process
 * exit, background task completion, session record flush). The last thrown
 * error is re-thrown so failures surface a meaningful message instead of a
 * generic timeout.
 */
export async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(5);
    }
  }
  throw lastError;
}
