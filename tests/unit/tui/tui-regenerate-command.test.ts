import { describe, expect, test } from "bun:test";
import { createSessionCommands } from "../../../src/tui/commands/session";
import { afterAgentLoop } from "../../../src/tui/commands/dispatch";
import type { SessionCommandContext } from "../../../src/tui/commands/types";

describe("/regenerate command", () => {
  test("dispatches to regenerateTurn after echoing the transcript, queued at the agent-loop boundary", async () => {
    let regenerated = 0;
    const transcript: Array<{ content?: string }> = [];
    const ctx = {
      async regenerateTurn() {
        regenerated += 1;
      },
      setMessages(updater: (prev: Array<{ content?: string }>) => Array<{ content?: string }>) {
        transcript.push(...updater([]));
      },
    } as unknown as SessionCommandContext;

    const command = createSessionCommands(ctx).find((entry) => entry.name === "regenerate");
    expect(command).toBeDefined();
    expect(command!.description).toContain("candidate");
    // busyBehavior is the scheduling contract: regenerate is a full turn, so it
    // queues at the agent-loop boundary rather than racing the active turn.
    expect(command!.busyBehavior).toBe(afterAgentLoop);

    await command!.run("", "/regenerate");
    expect(regenerated).toBe(1);
    // The raw command is echoed into the transcript as the user turn.
    expect(transcript.some((entry) => entry.content === "/regenerate")).toBe(true);
  });
});
