export type HostShutdownCleanup = () => void | Promise<void>;

type RegisteredCleanup = {
  cleanup: HostShutdownCleanup;
  priority: number;
};

const cleanups = new Set<RegisteredCleanup>();
let hooksInstalled = false;
let shutdownPromise: Promise<void> | undefined;

/** Register host-owned cleanup. Lower priorities run first. */
export function registerHostShutdownCleanup(
  cleanup: HostShutdownCleanup,
  priority = 0,
): () => void {
  const registered = { cleanup, priority };
  cleanups.add(registered);
  return () => cleanups.delete(registered);
}

/** Install the CLI process lifecycle owner once. Provider modules never exit the host. */
export function installHostShutdownHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.once("beforeExit", () => { void runHostShutdownCleanups(); });
  process.once("exit", () => { void runHostShutdownCleanups(); });
  process.once("SIGINT", () => { void shutdownForSignal(130); });
  process.once("SIGTERM", () => { void shutdownForSignal(143); });
}

export function runHostShutdownCleanups(): Promise<void> {
  shutdownPromise ??= (async () => {
    const ordered = [...cleanups].sort((left, right) => left.priority - right.priority);
    for (const { cleanup } of ordered) await cleanup();
  })();
  return shutdownPromise;
}

async function shutdownForSignal(exitCode: number): Promise<void> {
  try {
    await runHostShutdownCleanups();
  } finally {
    process.exit(exitCode);
  }
}
