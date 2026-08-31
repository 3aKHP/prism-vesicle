import type { BackgroundProcessState, ProcessManager } from "./manager";
import { renderBackgroundProcessNotifications } from "../agent-loop/background-process";

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
 * Wakes an idle parent session when a background shell task completes,
 * mirroring the SubAgent `AgentContinuationScheduler` skeleton (debounce,
 * idle gate, rerun edge) over the ProcessManager's durable `notified` inbox.
 * The scheduler never flips `notified`: delivery owns the flip, and only after
 * the completion record is durable, so an interrupted or deferred delivery
 * leaves the batch drainable again.
 */
export class ProcessCompletionScheduler {
  private readonly scheduled = new Map<string, Promise<void>>();
  private readonly rerunRequested = new Set<string>();

  constructor(
    private readonly processManager: ProcessManager,
    private readonly deliver: ProcessResultDelivery,
    private readonly options: {
      debounceMs?: number;
      isParentIdle?: (parentSessionId: string) => boolean;
    } = {},
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
      await this.deliver(parentSessionId, tasks, renderBackgroundProcessNotifications(tasks));
    } catch (error) {
      if (error instanceof ProcessDeliveryDeferred) return;
      throw error;
    }
  }
}
