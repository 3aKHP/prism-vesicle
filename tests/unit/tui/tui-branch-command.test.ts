import { describe, expect, test } from "bun:test";
import { createBuiltinCommands } from "../../../src/tui/commands/builtin";
import { createSessionCommands } from "../../../src/tui/commands/session";
import type { BuiltinCommandContexts, SessionCommandContext } from "../../../src/tui/commands/types";

const allCommands = createBuiltinCommands({} as unknown as BuiltinCommandContexts);

describe("/branch command", () => {
  test("opens the candidate-tree picker without echoing a transcript message", async () => {
    let opened = 0;
    let transcriptTouched = false;
    const ctx = {
      async openBranchPicker() {
        opened += 1;
      },
      setMessages() {
        transcriptTouched = true;
      },
    } as unknown as SessionCommandContext;
    const command = createSessionCommands(ctx).find((entry) => entry.name === "branch");
    expect(command).toBeDefined();
    expect(allCommands.some((entry) => entry.name === "branch")).toBe(true);

    await command!.run("", "/branch");
    expect(opened).toBe(1);
    expect(transcriptTouched).toBe(false);
  });
});
