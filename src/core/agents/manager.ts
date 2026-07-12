import { AgentStore } from "./store";
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
  ownedPaths: Set<string>;
};

export type SpawnedAgent = {
  runId: string;
  handle: string;
  completion: Promise<AgentTerminalResult>;
};

export class AgentManager {
  private readonly active = new Map<string, ActiveAgent>();
  private readonly waiters: Array<() => void> = [];
  private readonly writeOwners = new Map<string, string>();
  private readonly handleInitializers = new Map<string, Promise<number>>();
  private readonly nextHandleOrdinals = new Map<string, number>();
  private runningCount = 0;

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
  }

  get maxConcurrent(): number {
    return this.options.maxConcurrent ?? 4;
  }

  async spawn(spec: AgentSpec, invocation?: AgentInvocationContext): Promise<SpawnedAgent> {
    const runId = `run_${crypto.randomUUID()}`;
    const handle = await this.allocateHandle(spec.parentSessionId, spec.profileId);
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
    this.active.set(runId, { metadata, controller, completion, messages: [], ownedPaths: new Set() });
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
    this.claimPaths(`host:${ownerId}`, paths);
  }

  releaseHostMutations(ownerId: string): void {
    const owner = `host:${ownerId}`;
    for (const [path, current] of this.writeOwners) {
      if (current === owner) this.writeOwners.delete(path);
    }
  }

  private async execute(
    initial: AgentMetadata,
    controller: AbortController,
    invocation?: AgentInvocationContext,
  ): Promise<AgentTerminalResult> {
    let metadata = initial;
    let acquired = false;
    try {
      await this.acquire(controller.signal);
      acquired = true;
      metadata = { ...metadata, status: "running", updatedAt: new Date().toISOString() };
      await this.store.save(metadata);
      this.updateActive(metadata);
      this.options.onEvent?.({ type: "agent_started", agent: metadata });
      const output = await this.runner({
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
      };
      metadata = {
        ...metadata,
        status: "completed",
        result: output.content,
        ...(output.childSessionId ? { childSessionId: output.childSessionId } : {}),
        ...(output.usage ? { usage: output.usage } : {}),
        ...(output.toolUses ? { toolUses: output.toolUses } : {}),
        updatedAt: new Date().toISOString(),
      };
      await this.finish(metadata, result);
      return result;
    } catch (error) {
      const cancelled = controller.signal.aborted || isAbortError(error);
      const content = cancelled ? "SubAgent was cancelled." : errorMessage(error);
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
      };
      metadata = {
        ...metadata,
        status: result.status,
        error: content,
        updatedAt: new Date().toISOString(),
      };
      await this.finish(metadata, result);
      return result;
    } finally {
      this.releaseMutations(metadata.runId);
      if (acquired) this.release();
    }
  }

  private async claimMutation(runId: string, handle: string, paths: string[]): Promise<void> {
    const active = this.active.get(runId);
    if (!active) throw new Error(`SubAgent is no longer active: ${handle}.`);
    this.claimPaths(runId, paths);
    for (const path of paths) active.ownedPaths.add(path);
  }

  private claimPaths(ownerId: string, paths: string[]): void {
    const unique = [...new Set(paths)].sort();
    const conflict = unique.find((path) => {
      const owner = this.writeOwners.get(path);
      return owner && owner !== ownerId;
    });
    if (conflict) {
      const owner = this.writeOwners.get(conflict)!;
      const ownerLabel = owner.startsWith("host:")
        ? "the parent Engine"
        : this.active.get(owner)?.metadata.handle ?? "another SubAgent";
      throw new Error(`Concurrent Agent write conflict on "${conflict}"; the path is owned by ${ownerLabel}.`);
    }
    for (const path of unique) {
      this.writeOwners.set(path, ownerId);
    }
  }

  private releaseMutations(runId: string): void {
    const active = this.active.get(runId);
    if (!active) return;
    for (const path of active.ownedPaths) {
      if (this.writeOwners.get(path) === runId) this.writeOwners.delete(path);
    }
    active.ownedPaths.clear();
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

  private async allocateHandle(parentSessionId: string, profileId: string): Promise<string> {
    const key = `${parentSessionId}\u0000${profileId}`;
    let initializer = this.handleInitializers.get(key);
    if (!initializer) {
      initializer = this.store.nextHandleOrdinal(parentSessionId, profileId);
      this.handleInitializers.set(key, initializer);
    }
    const initial = await initializer;
    const ordinal = this.nextHandleOrdinals.get(key) ?? initial;
    this.nextHandleOrdinals.set(key, ordinal + 1);
    return `${profileId}-${ordinal}`;
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
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isControllable(metadata: AgentMetadata): boolean {
  return metadata.status === "created" || metadata.status === "running";
}
