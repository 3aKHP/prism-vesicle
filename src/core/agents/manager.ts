import { AgentStore } from "./store";
import { normalizeHarnessAdapterError } from "../harness/driver";
import { AgentHandleAllocator } from "./handle-allocator";
import { PathOwnershipTable } from "./path-ownership";
import type {
  AgentMetadata,
  AgentInvocationContext,
  AgentRunContext,
  AgentRunOutput,
  AgentRuntimeEvent,
  AgentSpec,
  AgentTerminalResult,
} from "./types";

export type AgentRunner = (context: AgentRunContext) => Promise<AgentRunOutput>;

type ActiveAgent = {
  metadata: AgentMetadata;
  controller: AbortController;
  completion: Promise<AgentTerminalResult>;
  messages: string[];
};

export type SpawnedAgent = {
  runId: string;
  handle: string;
  completion: Promise<AgentTerminalResult>;
};

export class AgentManager {
  private readonly active = new Map<string, ActiveAgent>();
  private readonly waiters: Array<() => void> = [];
  private readonly handleAllocator: AgentHandleAllocator;
  private readonly pathOwnership: PathOwnershipTable;
  private runningCount = 0;
  private readonly delegationRunning = new Set<string>();
  private readonly delegationWaiters = new Map<string, Array<() => void>>();

  constructor(
    private readonly store: AgentStore,
    private readonly runner: AgentRunner,
    private readonly options: {
      maxConcurrent?: number;
      onEvent?: (event: AgentRuntimeEvent) => void;
    } = {},
  ) {
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1) {
      throw new Error("SubAgent maxConcurrent must be a positive integer.");
    }
    this.handleAllocator = new AgentHandleAllocator(store);
    this.pathOwnership = new PathOwnershipTable();
  }

  get maxConcurrent(): number {
    return this.options.maxConcurrent ?? 4;
  }

  async spawn(spec: AgentSpec, invocation?: AgentInvocationContext): Promise<SpawnedAgent> {
    const runId = `run_${crypto.randomUUID()}`;
    const handle = await this.handleAllocator.allocate(spec.parentSessionId, spec.profileId);
    const now = new Date().toISOString();
    const metadata: AgentMetadata = {
      ...spec,
      runId,
      handle,
      status: "created",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.save(metadata);
    this.options.onEvent?.({ type: "agent_created", agent: metadata });

    const controller = new AbortController();
    const abortFromParent = () => controller.abort(invocation?.parentSignal?.reason);
    if (spec.mode === "foreground" && invocation?.parentSignal) {
      if (invocation.parentSignal.aborted) abortFromParent();
      else invocation.parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
    const completion = this.execute(metadata, controller, invocation);
    this.active.set(runId, { metadata, controller, completion, messages: [] });
    const cleanup = () => {
      invocation?.parentSignal?.removeEventListener("abort", abortFromParent);
      this.active.delete(runId);
    };
    void completion.then(cleanup, cleanup);
    return { runId, handle, completion };
  }

  async interrupt(reference: string, parentSessionId: string): Promise<boolean> {
    const active = this.findActive(reference, parentSessionId, true);
    if (!active) return false;
    active.controller.abort(new DOMException("SubAgent interrupted.", "AbortError"));
    return true;
  }

  sendMessage(reference: string, message: string, parentSessionId: string): boolean {
    const active = this.findActive(reference, parentSessionId, true);
    if (!active || !message.trim()) return false;
    active.messages.push(message.trim());
    return true;
  }

  listActive(parentSessionId?: string): AgentMetadata[] {
    return [...this.active.values()]
      .map((entry) => entry.metadata)
      .filter((agent) => !parentSessionId || agent.parentSessionId === parentSessionId);
  }

  async wait(reference: string, parentSessionId: string): Promise<AgentTerminalResult | undefined> {
    const active = this.findActive(reference, parentSessionId);
    if (active) return active.completion;
    return terminalFromMetadata(await this.store.resolveReference(parentSessionId, reference));
  }

  reportIntegrated(result: Pick<AgentTerminalResult, "runId" | "handle" | "parentSessionId">): void {
    this.options.onEvent?.({ type: "agent_integrated", runId: result.runId, handle: result.handle, parentSessionId: result.parentSessionId });
  }

  async claimHostMutation(ownerId: string, paths: string[]): Promise<void> {
    this.pathOwnership.claim(`host:${ownerId}`, "the parent Engine", paths);
  }

  releaseHostMutations(ownerId: string): void {
    this.pathOwnership.release(`host:${ownerId}`);
  }

  private async execute(
    initial: AgentMetadata,
    controller: AbortController,
    invocation?: AgentInvocationContext,
  ): Promise<AgentTerminalResult> {
    let metadata = initial;
    let acquired = false;
    let delegationAcquired = false;
    let executionStarted = false;
    try {
      if (metadata.delegation) {
        await this.acquireDelegation(metadata.parentSessionId, controller.signal);
        delegationAcquired = true;
      }
      await this.acquire(controller.signal);
      acquired = true;
      metadata = { ...metadata, status: "running", updatedAt: new Date().toISOString() };
      await this.store.save(metadata);
      this.updateActive(metadata);
      this.options.onEvent?.({ type: "agent_started", agent: metadata });
      executionStarted = true;
      while (true) {
        let output: AgentRunOutput;
        try {
          output = await this.runner({
            runId: metadata.runId,
            handle: metadata.handle,
            spec: metadata,
            signal: controller.signal,
            invocation,
            onProgress: (text) => this.options.onEvent?.({ type: "agent_progress", runId: metadata.runId, handle: metadata.handle, parentSessionId: metadata.parentSessionId, text }),
            takeMessages: () => this.active.get(metadata.runId)?.messages.splice(0) ?? [],
            claimMutation: (paths) => this.claimMutation(metadata.runId, metadata.handle, paths),
            registerChildSession: async (childSessionId) => {
              metadata = { ...metadata, childSessionId, updatedAt: new Date().toISOString() };
              await this.store.save(metadata);
              this.updateActive(metadata);
            },
          });
        } catch (error) {
          const cancelled = controller.signal.aborted || isAbortError(error);
          const normalized = normalizeHarnessAdapterError(error);
          const content = cancelled ? "SubAgent was cancelled." : normalized.message;
          const attempt = metadata.delegation?.attempt;
          const attempts = attempt ? [...(metadata.attempts ?? []), {
            attempt,
            status: cancelled ? "cancelled" as const : "failed" as const,
            finishedAt: new Date().toISOString(),
            ...(metadata.childSessionId ? { childSessionId: metadata.childSessionId } : {}),
            ...(!cancelled ? { errorCategory: normalized.category, error: content } : {}),
          }] : metadata.attempts;
          const retry = !cancelled
            && normalized.category === "transient"
            && metadata.delegation
            && metadata.delegation.attempt <= metadata.delegation.retryLimit;
          if (retry) {
            const { childSessionId: _previousChildSession, ...withoutChildSession } = metadata;
            const nextDelegation = {
              ...metadata.delegation!,
              attempt: metadata.delegation!.attempt + 1,
            };
            metadata = {
              ...withoutChildSession,
              delegation: nextDelegation,
              attempts,
              updatedAt: new Date().toISOString(),
            };
            await this.store.save(metadata);
            this.updateActive(metadata);
            this.options.onEvent?.({
              type: "agent_progress",
              runId: metadata.runId,
              handle: metadata.handle,
              parentSessionId: metadata.parentSessionId,
              text: `retry ${nextDelegation.attempt}/${nextDelegation.retryLimit + 1}`,
            });
            continue;
          }
          const result: AgentTerminalResult = {
            runId: metadata.runId,
            handle: metadata.handle,
            parentSessionId: metadata.parentSessionId,
            profileId: metadata.profileId,
            description: metadata.description,
            mode: metadata.mode,
            status: cancelled ? "cancelled" : "failed",
            content,
            ...(metadata.childSessionId ? { childSessionId: metadata.childSessionId } : {}),
            ...(metadata.delegation ? { delegation: metadata.delegation } : {}),
            ...(attempts ? { attempts } : {}),
            ...(!cancelled ? { errorCategory: normalized.category } : {}),
          };
          metadata = {
            ...metadata,
            status: result.status,
            error: content,
            ...(attempts ? { attempts } : {}),
            ...(!cancelled ? { errorCategory: normalized.category } : {}),
            updatedAt: new Date().toISOString(),
          };
          await this.finish(metadata, result);
          return result;
        }
        const attempts = metadata.delegation ? [...(metadata.attempts ?? []), {
          attempt: metadata.delegation.attempt,
          status: "completed" as const,
          finishedAt: new Date().toISOString(),
          ...(output.childSessionId ? { childSessionId: output.childSessionId } : {}),
        }] : metadata.attempts;
        const result: AgentTerminalResult = {
          runId: metadata.runId,
          handle: metadata.handle,
          parentSessionId: metadata.parentSessionId,
          profileId: metadata.profileId,
          description: metadata.description,
          mode: metadata.mode,
          status: "completed",
          content: output.content,
          ...(output.childSessionId ? { childSessionId: output.childSessionId } : {}),
          ...(output.usage ? { usage: output.usage } : {}),
          ...(output.toolUses ? { toolUses: output.toolUses } : {}),
          ...(metadata.delegation ? { delegation: metadata.delegation } : {}),
          ...(attempts ? { attempts } : {}),
        };
        metadata = {
          ...metadata,
          status: "completed",
          result: output.content,
          ...(output.childSessionId ? { childSessionId: output.childSessionId } : {}),
          ...(output.usage ? { usage: output.usage } : {}),
          ...(output.toolUses ? { toolUses: output.toolUses } : {}),
          ...(attempts ? { attempts } : {}),
          updatedAt: new Date().toISOString(),
        };
        await this.finish(metadata, result);
        return result;
      }
    } catch (error) {
      if (executionStarted) throw error;
      const cancelled = controller.signal.aborted || isAbortError(error);
      const normalized = normalizeHarnessAdapterError(error);
      const content = cancelled ? "SubAgent was cancelled." : normalized.message;
      const attempts = metadata.delegation ? [...(metadata.attempts ?? []), {
        attempt: metadata.delegation.attempt,
        status: cancelled ? "cancelled" as const : "failed" as const,
        finishedAt: new Date().toISOString(),
        ...(!cancelled ? { errorCategory: normalized.category, error: content } : {}),
      }] : metadata.attempts;
      const result: AgentTerminalResult = {
        runId: metadata.runId,
        handle: metadata.handle,
        parentSessionId: metadata.parentSessionId,
        profileId: metadata.profileId,
        description: metadata.description,
        mode: metadata.mode,
        status: cancelled ? "cancelled" : "failed",
        content,
        ...(metadata.delegation ? { delegation: metadata.delegation } : {}),
        ...(attempts ? { attempts } : {}),
        ...(!cancelled ? { errorCategory: normalized.category } : {}),
      };
      metadata = {
        ...metadata,
        status: result.status,
        error: content,
        ...(attempts ? { attempts } : {}),
        ...(!cancelled ? { errorCategory: normalized.category } : {}),
        updatedAt: new Date().toISOString(),
      };
      await this.finish(metadata, result);
      return result;
    } finally {
      this.releaseMutations(metadata.runId);
      if (acquired) this.release();
      if (delegationAcquired) this.releaseDelegation(metadata.parentSessionId);
    }
  }

  private async claimMutation(runId: string, handle: string, paths: string[]): Promise<void> {
    const active = this.active.get(runId);
    if (!active) throw new Error(`SubAgent is no longer active: ${handle}.`);
    this.pathOwnership.claim(runId, handle, paths);
  }

  private releaseMutations(runId: string): void {
    this.pathOwnership.release(runId);
  }

  private async finish(metadata: AgentMetadata, result: AgentTerminalResult): Promise<void> {
    await this.store.save(metadata);
    this.updateActive(metadata);
    if (metadata.mode === "background" && result.status !== "cancelled") {
      await this.store.enqueue(metadata, result);
    }
    this.options.onEvent?.({ type: "agent_completed", result });
  }

  private updateActive(metadata: AgentMetadata): void {
    const active = this.active.get(metadata.runId);
    if (active) active.metadata = metadata;
  }

  private findActive(reference: string, parentSessionId: string, controllableOnly = false): ActiveAgent | undefined {
    const direct = this.active.get(reference);
    if (direct
      && direct.metadata.parentSessionId === parentSessionId
      && (!controllableOnly || isControllable(direct.metadata))) return direct;
    return [...this.active.values()].find((entry) => entry.metadata.handle === reference
      && entry.metadata.parentSessionId === parentSessionId
      && (!controllableOnly || isControllable(entry.metadata)));
  }

  private async acquire(signal: AbortSignal): Promise<void> {
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
        const index = this.waiters.indexOf(resume);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      this.waiters.push(resume);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private release(): void {
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.waiters.shift()?.();
  }

  private async acquireDelegation(parentSessionId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    if (!this.delegationRunning.has(parentSessionId)) {
      this.delegationRunning.add(parentSessionId);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const queue = this.delegationWaiters.get(parentSessionId) ?? [];
        const index = queue.indexOf(resume);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      };
      const queue = this.delegationWaiters.get(parentSessionId) ?? [];
      queue.push(resume);
      this.delegationWaiters.set(parentSessionId, queue);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private releaseDelegation(parentSessionId: string): void {
    const queue = this.delegationWaiters.get(parentSessionId);
    const next = queue?.shift();
    if (queue?.length === 0) this.delegationWaiters.delete(parentSessionId);
    if (next) next();
    else this.delegationRunning.delete(parentSessionId);
  }
}

function terminalFromMetadata(metadata: AgentMetadata | undefined): AgentTerminalResult | undefined {
  if (!metadata || (metadata.status !== "completed" && metadata.status !== "failed" && metadata.status !== "cancelled")) return undefined;
  return {
    runId: metadata.runId,
    handle: metadata.handle,
    parentSessionId: metadata.parentSessionId,
    profileId: metadata.profileId,
    description: metadata.description,
    mode: metadata.mode,
    status: metadata.status,
    content: metadata.result ?? metadata.error ?? "",
    ...(metadata.childSessionId ? { childSessionId: metadata.childSessionId } : {}),
    ...(metadata.usage ? { usage: metadata.usage } : {}),
    ...(metadata.toolUses ? { toolUses: metadata.toolUses } : {}),
    ...(metadata.delegation ? { delegation: metadata.delegation } : {}),
    ...(metadata.attempts ? { attempts: metadata.attempts } : {}),
    ...(metadata.errorCategory ? { errorCategory: metadata.errorCategory } : {}),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isControllable(metadata: AgentMetadata): boolean {
  return metadata.status === "created" || metadata.status === "running";
}
