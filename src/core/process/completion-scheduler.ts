import type { BackgroundProcessState, ProcessManager } from "./manager";

export type ProcessResultDelivery = (
  parentSessionId: string,
  tasks: BackgroundProcessState[],
  packet: string,
) => Promise<void>;

export class ProcessDeliveryDeferred extends Error {
  constructor() {
    super("Parent session is not ready for background shell result delivery.");
    this.name = "ProcessDeliveryDeferred";
  }
}

/**
 * Wakes an idle parent session when a background shell task completes. The
 * skeleton intentionally mirrors `AgentContinuationScheduler` (debounce, idle
 * gate, rerun edge) without sharing a base: the two inboxes differ in delivery
 * semantics (three-state agent inbox vs. the per-task `notified` flag), so
 * they are not unified — scheduling-semantics changes must update both.
 *
 * The scheduler stays domain-pure: the composition root injects the packet
 * renderer, so the process domain never imports agent-loop presentation.
 */
export class ProcessCompletionScheduler {
  private readonly scheduled = new Map<string, Promise<void>>();
  private readonly rerunRequested = new Set<string>();

  constructor(
    private readonly processManager: ProcessManager,
    private readonly deliver: ProcessResultDelivery,
    private readonly options: {
      renderPacket: (tasks: BackgroundProcessState[]) => string;
      debounceMs?: number;
      isParentIdle?: (parentSessionId: string) => boolean;
    },
  ) {}

  notify(parentSessionId: string): Promise<void> {
    const current = this.scheduled.get(parentSessionId);
    if (current) {
      // A task may reach its terminal state while an earlier batch is already
      // being delivered. Preserve that edge so the new completion cannot be
      // stranded when the current delivery promise settles.
      this.rerunRequested.add(parentSessionId);
      return current;
    }
    const task = this.drainUntilQuiet(parentSessionId).finally(() => {
      this.scheduled.delete(parentSessionId);
      this.rerunRequested.delete(parentSessionId);
    });
    this.scheduled.set(parentSessionId, task);
    return task;
  }

  private async drainUntilQuiet(parentSessionId: string): Promise<void> {
    do {
      this.rerunRequested.delete(parentSessionId);
      await this.drainAfterDelay(parentSessionId);
    } while (this.rerunRequested.has(parentSessionId));
  }

  private async drainAfterDelay(parentSessionId: string): Promise<void> {
    const delay = this.options.debounceMs ?? 30;
    if (delay > 0) await Bun.sleep(delay);
    if (this.options.isParentIdle && !this.options.isParentIdle(parentSessionId)) return;
    const tasks = await this.processManager.collectNotifications(parentSessionId);
    if (tasks.length === 0) return;
    try {
      await this.deliver(parentSessionId, tasks, this.options.renderPacket(tasks));
    } catch (error) {
      if (error instanceof ProcessDeliveryDeferred) return;
      throw error;
    }
  }
}
