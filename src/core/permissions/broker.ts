import type { PermissionRequest, PermissionResolution } from "./types";

type Pending = {
  request: PermissionRequest;
  resolve: (resolution: PermissionResolution) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
};

/** Serializes child permission requests through the parent-owned TUI. */
export class ToolPermissionBroker {
  private readonly queue: Pending[] = [];
  private listener?: (request: PermissionRequest | undefined) => void;

  subscribe(listener: (request: PermissionRequest | undefined) => void): () => void {
    this.listener = listener;
    listener(this.queue[0]?.request);
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  request(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionResolution> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({
          decision: "reject",
          resolvedAt: new Date().toISOString(),
          feedback: "The requesting SubAgent was already cancelled.",
        });
        return;
      }
      const pending: Pending = { request, resolve, signal };
      const abortListener = () => {
        const index = this.queue.indexOf(pending);
        if (index < 0) return;
        const wasActive = index === 0;
        this.queue.splice(index, 1);
        resolve({
          decision: "reject",
          resolvedAt: new Date().toISOString(),
          feedback: "The requesting SubAgent was cancelled before permission was resolved.",
        });
        if (wasActive) this.listener?.(this.queue[0]?.request);
      };
      pending.abortListener = abortListener;
      signal?.addEventListener("abort", abortListener, { once: true });
      this.queue.push(pending);
      if (this.queue.length === 1) this.listener?.(request);
    });
  }

  resolve(requestId: string, resolution: PermissionResolution): boolean {
    const active = this.queue[0];
    if (!active || active.request.id !== requestId) return false;
    this.queue.shift();
    active.signal?.removeEventListener("abort", active.abortListener!);
    active.resolve(resolution);
    this.listener?.(this.queue[0]?.request);
    return true;
  }

  active(): PermissionRequest | undefined {
    return this.queue[0]?.request;
  }
}
