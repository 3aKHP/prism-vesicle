export type HostShutdownCleanup = () => void | Promise<void>;

type RegisteredCleanup = {
  cleanup: HostShutdownCleanup;
  priority: number;
};

const cleanups = new Set<RegisteredCleanup>();
let hooksInstalled = false;
let shutdownPromise: Promise<void> | undefined;
const signalShutdownTimeoutMs = 10_000;

/** Register host-owned cleanup. Lower priorities run first. */
export function registerHostShutdownCleanup(
  cleanup: HostShutdownCleanup,
  priority = 0,
): () => void {
  if (shutdownPromise) {
    throw new Error("Cannot register a host cleanup after process shutdown has started.");
  }
  const registered = { cleanup, priority };
  cleanups.add(registered);
  return () => cleanups.delete(registered);
}

/** Install the CLI process lifecycle owner once. Provider modules never exit the host. */
export function installHostShutdownHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.once("beforeExit", () => { void runHostShutdownCleanups(); });
  process.once("SIGINT", () => { void shutdownForSignal(130); });
  process.once("SIGTERM", () => { void shutdownForSignal(143); });
}

export function runHostShutdownCleanups(): Promise<void> {
  // Process shutdown is a one-shot transaction. Keeping the settled promise
  // prevents `beforeExit` from rerunning resources already closed by an
  // explicit noninteractive cleanup; late registration is rejected above.
  shutdownPromise ??= (async () => {
    const ordered = [...cleanups].sort((left, right) => left.priority - right.priority);
    for (const { cleanup } of ordered) {
      try {
        await cleanup();
      } catch {
        // Shutdown is best-effort per resource. One failed owner must not keep
        // later resources (especially provider sockets) alive.
        console.error("A host resource failed to clean up; continuing shutdown.");
      }
    }
  })();
  return shutdownPromise;
}

async function shutdownForSignal(exitCode: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      runHostShutdownCleanups(),
      new Promise<void>((resolve) => { timeout = setTimeout(resolve, signalShutdownTimeoutMs); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    process.exit(exitCode);
  }
}
