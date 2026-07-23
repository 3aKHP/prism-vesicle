import { describe, expect, test } from "bun:test";
import { TurnCancellation } from "../../../src/tui/turn-cancellation";

describe("TUI turn cancellation", () => {
  test("turns an aborted provider operation into an interrupted outcome", async () => {
    const cancellation = new TurnCancellation();
    const running = cancellation.run((signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    expect(cancellation.abort()).toBe(true);
    expect(await running).toEqual({ kind: "interrupted" });
    expect(await cancellation.run(async () => "next")).toEqual({ kind: "complete", value: "next" });
  });
});
