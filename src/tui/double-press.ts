export const DOUBLE_PRESS_TIMEOUT_MS = 800;

export type DoublePressResult = "first" | "double";

export class DoublePressTracker {
  private lastPressAt = Number.NEGATIVE_INFINITY;
  private pending = false;

  constructor(private readonly timeoutMs = DOUBLE_PRESS_TIMEOUT_MS) {}

  press(now = Date.now()): DoublePressResult {
    const isDouble = this.pending && now - this.lastPressAt <= this.timeoutMs;
    this.lastPressAt = now;
    this.pending = !isDouble;
    return isDouble ? "double" : "first";
  }

  reset(): void {
    this.pending = false;
    this.lastPressAt = Number.NEGATIVE_INFINITY;
  }
}
