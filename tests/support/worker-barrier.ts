import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Cross-process readiness barrier for burst-contention tests: each worker
 * signals readiness with a per-index file, blocks until the shared "go" file
 * appears, then runs its payload. The barrier owns the ready directory, the
 * worker-script prelude, and the release/collect/shutdown contract; the test
 * owns the worker count, payload, and domain assertions. Shutdown only kills
 * workers that are still running and never masks the test's own failure.
 */
export type BarrierWorker = {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly stderr: ReadableStream;
  kill(signal?: string | number): void;
};

export type WorkerBarrier = {
  readonly barrierPath: string;
  workerEnv(index: number): Record<string, string>;
  workerScript(options: { imports?: string[]; payload: string[] }): string;
  releaseWhenReady(workerCount: number): Promise<void>;
  collect(workers: readonly BarrierWorker[]): Promise<{ exitCode: number; stderr: string }[]>;
  shutdown(workers: readonly BarrierWorker[]): Promise<void>;
};

export async function startWorkerBarrier(dir: string): Promise<WorkerBarrier> {
  const readyRoot = join(dir, "workers-ready");
  const barrierPath = join(dir, "workers-go");
  await mkdir(readyRoot, { recursive: true });

  const readyPath = (index: number) => join(readyRoot, `${index}.ready`);

  return {
    barrierPath,
    workerEnv(index) {
      return { BARRIER_PATH: barrierPath, READY_PATH: readyPath(index) };
    },
    workerScript({ imports = [], payload }) {
      return [
        'import { lstat, writeFile } from "node:fs/promises";',
        ...imports,
        'await writeFile(process.env.READY_PATH!, "ready");',
        "while (true) {",
        "  try { await lstat(process.env.BARRIER_PATH!); break; } catch (error) {",
        // A missing barrier file is the normal pre-release state; any other
        // lstat error is a real filesystem problem and must fail the worker.
        '    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;',
        "    await Bun.sleep(5);",
        "  }",
        "}",
        ...payload,
      ].join("\n");
    },
    async releaseWhenReady(workerCount) {
      let readyCount = 0;
      for (let attempt = 0; attempt < 1_000; attempt++) {
        const ready = await Promise.all(
          Array.from({ length: workerCount }, (_, index) => readyPath(index))
            .map((path) => lstat(path).then(() => true, () => false)),
        );
        readyCount = ready.filter(Boolean).length;
        if (readyCount === workerCount) break;
        await Bun.sleep(10);
      }
      if (readyCount !== workerCount) {
        throw new Error(`worker barrier: ${readyCount}/${workerCount} workers ready`);
      }
      await writeFile(barrierPath, "go");
    },
    async collect(workers) {
      return Promise.all(workers.map(async (worker) => ({
        exitCode: await worker.exited,
        stderr: await new Response(worker.stderr).text(),
      })));
    },
    async shutdown(workers) {
      for (const worker of workers) {
        if (worker.exitCode === null) worker.kill("SIGKILL");
      }
      await Promise.all(workers.map((worker) => worker.exited.catch(() => undefined)));
    },
  };
}
