import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessExecutionPlan } from "../permissions";
import {
  startProcessPlan,
  type ProcessExecutionHandle,
  type ProcessExecutionProgress,
  type ProcessExecutionResult,
} from "./runtime";

export type BackgroundProcessStatus = "running" | "completed" | "failed" | "timed_out" | "cancelled" | "interrupted";

export type BackgroundProcessState = {
  taskId: string;
  parentSessionId: string;
  parentToolCallId: string;
  plan: ProcessExecutionPlan;
  status: BackgroundProcessStatus;
  pid?: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  exitCode?: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  notified: boolean;
};

export type BackgroundProcessEvent = {
  type: "background_process_updated";
  process: BackgroundProcessState;
};

type RuntimeTask = {
  state: BackgroundProcessState;
  handle?: ProcessExecutionHandle;
  settled: Promise<BackgroundProcessState>;
  resolveSettled: (state: BackgroundProcessState) => void;
  persistTail: Promise<void>;
  persistTimer?: ReturnType<typeof setTimeout>;
};

const managers = new Map<string, ProcessManager>();

export function getProcessManager(rootDir: string): ProcessManager {
  let manager = managers.get(rootDir);
  if (!manager) {
    manager = new ProcessManager(rootDir);
    managers.set(rootDir, manager);
  }
  return manager;
}

export class ProcessManager {
  private readonly tasks = new Map<string, RuntimeTask>();
  private readonly listeners = new Set<(event: BackgroundProcessEvent) => void>();
  private initialization?: Promise<void>;
  private nextOrdinal = 1;

  constructor(private readonly rootDir: string) {}

  subscribe(listener: (event: BackgroundProcessEvent) => void): () => void {
    this.listeners.add(listener);
    void this.initialize().then(() => {
      for (const task of this.tasks.values()) listener({ type: "background_process_updated", process: cloneState(task.state) });
    });
    return () => this.listeners.delete(listener);
  }

  async start(
    plan: ProcessExecutionPlan,
    context: { parentSessionId: string; parentToolCallId: string; signal?: AbortSignal },
  ): Promise<BackgroundProcessState> {
    await this.initialize();
    const taskId = `shell-${this.nextOrdinal++}`;
    const now = new Date().toISOString();
    let resolveSettled!: (state: BackgroundProcessState) => void;
    const settled = new Promise<BackgroundProcessState>((resolve) => { resolveSettled = resolve; });
    const state: BackgroundProcessState = {
      taskId,
      parentSessionId: context.parentSessionId,
      parentToolCallId: context.parentToolCallId,
      plan,
      status: "running",
      startedAt: now,
      updatedAt: now,
      durationMs: 0,
      stdout: "",
      stderr: "",
      stdoutTail: "",
      stderrTail: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      notified: false,
    };
    const task: RuntimeTask = { state, settled, resolveSettled, persistTail: Promise.resolve() };
    this.tasks.set(taskId, task);
    await this.persist(task);

    let handle: ProcessExecutionHandle;
    try {
      handle = startProcessPlan(this.rootDir, plan, {
        signal: context.signal,
        onProgress: (progress) => this.updateProgress(task, progress),
      });
    } catch (error) {
      await this.interrupt(task, error instanceof Error ? error.message : String(error));
      throw error;
    }
    task.handle = handle;
    task.state.pid = handle.pid;
    await this.persist(task);
    this.emit(task.state);
    void handle.result.then(
      (result) => this.finish(task, result),
      (error) => this.interrupt(task, error instanceof Error ? error.message : String(error)),
    );
    return cloneState(task.state);
  }

  async get(taskId: string): Promise<BackgroundProcessState | undefined> {
    await this.initialize();
    return this.tasks.get(taskId) ? cloneState(this.tasks.get(taskId)!.state) : undefined;
  }

  async list(parentSessionId?: string): Promise<BackgroundProcessState[]> {
    await this.initialize();
    return [...this.tasks.values()]
      .map((task) => cloneState(task.state))
      .filter((task) => !parentSessionId || task.parentSessionId === parentSessionId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async wait(taskId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<BackgroundProcessState> {
    await this.initialize();
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown background shell task: ${taskId}.`);
    if (task.state.status !== "running") return cloneState(task.state);
    const waits: Array<Promise<BackgroundProcessState>> = [task.settled.then(cloneState)];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    if (options.timeoutMs !== undefined) {
      waits.push(new Promise((resolve) => {
        timeout = setTimeout(() => resolve(cloneState(task.state)), options.timeoutMs);
        timeout.unref?.();
      }));
    }
    if (options.signal) {
      waits.push(new Promise((_, reject) => {
        if (options.signal!.aborted) reject(options.signal!.reason ?? new Error("Background shell wait was cancelled."));
        else {
          abortListener = () => reject(options.signal!.reason ?? new Error("Background shell wait was cancelled."));
          options.signal!.addEventListener("abort", abortListener, { once: true });
        }
      }));
    }
    try {
      return await Promise.race(waits);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) options.signal?.removeEventListener("abort", abortListener);
    }
  }

  async stop(taskId: string): Promise<BackgroundProcessState> {
    await this.initialize();
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown background shell task: ${taskId}.`);
    if (task.state.status !== "running" || !task.handle) return cloneState(task.state);
    task.handle.cancel();
    return task.settled.then(cloneState);
  }

  async drainNotifications(parentSessionId: string): Promise<BackgroundProcessState[]> {
    await this.initialize();
    const completed = [...this.tasks.values()].filter((task) =>
      task.state.parentSessionId === parentSessionId
      && task.state.status !== "running"
      && !task.state.notified
    );
    for (const task of completed) {
      task.state.notified = true;
      task.state.updatedAt = new Date().toISOString();
      await this.persist(task);
    }
    return completed.map((task) => cloneState(task.state));
  }

  async shutdown(): Promise<void> {
    await this.initialize();
    const running = [...this.tasks.values()].filter((task) => task.state.status === "running" && task.handle);
    for (const task of running) task.handle!.cancel();
    await Promise.all(running.map((task) => task.settled));
  }

  private async initialize(): Promise<void> {
    this.initialization ??= this.load();
    return this.initialization;
  }

  private async load(): Promise<void> {
    await mkdir(this.storeDir(), { recursive: true });
    let names: string[] = [];
    try {
      names = await readdir(this.storeDir());
    } catch {
      return;
    }
    for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
      try {
        const state = JSON.parse(await readFile(join(this.storeDir(), name), "utf8")) as BackgroundProcessState;
        const taskIdMatch = typeof state?.taskId === "string" ? /^shell-(\d+)$/.exec(state.taskId) : null;
        if (!taskIdMatch || name !== `${state.taskId}.json` || !state.plan?.command) continue;
        const ordinal = Number(taskIdMatch[1]);
        if (Number.isInteger(ordinal)) this.nextOrdinal = Math.max(this.nextOrdinal, ordinal + 1);
        if (state.status === "running") {
          state.status = "interrupted";
          state.completedAt = new Date().toISOString();
          state.updatedAt = state.completedAt;
          state.notified = false;
        }
        let resolveSettled!: (value: BackgroundProcessState) => void;
        const settled = new Promise<BackgroundProcessState>((resolve) => { resolveSettled = resolve; });
        const task: RuntimeTask = { state, settled, resolveSettled, persistTail: Promise.resolve() };
        this.tasks.set(state.taskId, task);
        resolveSettled(cloneState(state));
        await this.persist(task);
      } catch {
        // Ignore malformed local runtime state; it is not provider context.
      }
    }
  }

  private updateProgress(task: RuntimeTask, progress: ProcessExecutionProgress): void {
    if (task.state.status !== "running") return;
    Object.assign(task.state, {
      durationMs: progress.durationMs,
      stdoutTail: progress.stdoutTail,
      stderrTail: progress.stderrTail,
      stdoutBytes: progress.stdoutBytes,
      stderrBytes: progress.stderrBytes,
      stdoutTruncated: progress.stdoutTruncated,
      stderrTruncated: progress.stderrTruncated,
      updatedAt: new Date().toISOString(),
    });
    this.schedulePersist(task);
    this.emit(task.state);
  }

  private async finish(task: RuntimeTask, result: ProcessExecutionResult): Promise<void> {
    if (task.persistTimer) clearTimeout(task.persistTimer);
    const completedAt = new Date().toISOString();
    Object.assign(task.state, {
      status: result.timedOut ? "timed_out" : result.aborted ? "cancelled" : result.exitCode === 0 ? "completed" : "failed",
      completedAt,
      updatedAt: completedAt,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    });
    await this.persist(task);
    const state = cloneState(task.state);
    task.resolveSettled(state);
    this.emit(state);
  }

  private async interrupt(task: RuntimeTask, message: string): Promise<void> {
    if (task.persistTimer) clearTimeout(task.persistTimer);
    const completedAt = new Date().toISOString();
    Object.assign(task.state, {
      status: "interrupted" as const,
      completedAt,
      updatedAt: completedAt,
      stderrTail: message,
    });
    await this.persist(task);
    const state = cloneState(task.state);
    task.resolveSettled(state);
    this.emit(state);
  }

  private schedulePersist(task: RuntimeTask): void {
    if (task.persistTimer) return;
    task.persistTimer = setTimeout(() => {
      task.persistTimer = undefined;
      void this.persist(task);
    }, 250);
    task.persistTimer.unref?.();
  }

  private async persist(task: RuntimeTask): Promise<void> {
    task.persistTail = task.persistTail.then(async () => {
      await mkdir(this.storeDir(), { recursive: true });
      const path = join(this.storeDir(), `${task.state.taskId}.json`);
      const temporary = `${path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(task.state, null, 2)}\n`, "utf8");
      await rename(temporary, path);
    });
    return task.persistTail;
  }

  private emit(state: BackgroundProcessState): void {
    const event: BackgroundProcessEvent = { type: "background_process_updated", process: cloneState(state) };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observability subscribers must not affect process lifecycle.
      }
    }
  }

  private storeDir(): string {
    return join(this.rootDir, ".vesicle", "processes");
  }
}

function cloneState(state: BackgroundProcessState): BackgroundProcessState {
  return { ...state, plan: { ...state.plan } };
}
