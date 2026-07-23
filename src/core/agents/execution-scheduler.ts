export type AgentExecutionLease = {
  release(): void;
};

export class AgentExecutionScheduler {
  private readonly slotWaiters: Array<() => void> = [];
  private runningCount = 0;
  private readonly delegationRunning = new Set<string>();
  private readonly delegationWaiters = new Map<string, Array<() => void>>();

  constructor(readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("SubAgent maxConcurrent must be a positive integer.");
    }
  }

  async acquire(signal: AbortSignal, delegationKey?: string): Promise<AgentExecutionLease> {
    let delegationAcquired = false;
    let slotAcquired = false;
    try {
      if (delegationKey) {
        await this.acquireDelegation(delegationKey, signal);
        delegationAcquired = true;
      }
      await this.acquireSlot(signal);
      slotAcquired = true;
    } catch (error) {
      if (slotAcquired) this.releaseSlot();
      if (delegationAcquired) this.releaseDelegation(delegationKey!);
      throw error;
    }

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releaseSlot();
        if (delegationAcquired) this.releaseDelegation(delegationKey!);
      },
    };
  }

  private async acquireSlot(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    if (this.runningCount < this.maxConcurrent) {
      this.runningCount += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        signal.removeEventListener("abort", abort);
        this.runningCount += 1;
        resolve();
      };
      const abort = () => {
        const index = this.slotWaiters.indexOf(resume);
        if (index >= 0) this.slotWaiters.splice(index, 1);
        reject(signal.reason);
      };
      this.slotWaiters.push(resume);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private releaseSlot(): void {
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.slotWaiters.shift()?.();
  }

  private async acquireDelegation(key: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    if (!this.delegationRunning.has(key)) {
      this.delegationRunning.add(key);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const queue = this.delegationWaiters.get(key) ?? [];
        const index = queue.indexOf(resume);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      };
      const queue = this.delegationWaiters.get(key) ?? [];
      queue.push(resume);
      this.delegationWaiters.set(key, queue);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private releaseDelegation(key: string): void {
    const queue = this.delegationWaiters.get(key);
    const next = queue?.shift();
    if (queue?.length === 0) this.delegationWaiters.delete(key);
    if (next) next();
    else this.delegationRunning.delete(key);
  }
}
