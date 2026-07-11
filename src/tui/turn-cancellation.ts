export type CancellableOutcome<T> =
  | { kind: "complete"; value: T }
  | { kind: "interrupted" };

/** Owns the single provider request that an interactive TUI may run at once. */
export class TurnCancellation {
  private controller: AbortController | null = null;

  abort(): boolean {
    if (!this.controller) return false;
    this.controller.abort("user-cancel");
    return true;
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<CancellableOutcome<T>> {
    if (this.controller) throw new Error("A provider request is already in flight.");
    const controller = new AbortController();
    this.controller = controller;
    try {
      return { kind: "complete", value: await operation(controller.signal) };
    } catch (error) {
      if (controller.signal.aborted) return { kind: "interrupted" };
      throw error;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
