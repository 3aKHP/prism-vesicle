import { describe, expect, test } from "bun:test";
import { createBuiltinCommands } from "../../../src/tui/commands/builtin";
import { createSessionCommands } from "../../../src/tui/commands/session";
import type { BuiltinCommandContexts, SessionCommandContext } from "../../../src/tui/commands/types";
import { rewindPointLine, rewindRestoreOptions } from "../../../src/tui/RewindPicker";

const allCommands = createBuiltinCommands({} as unknown as BuiltinCommandContexts);

describe("/rewind command", () => {
  test("opens the rewind selector without echoing a transcript message", async () => {
    let opened = 0;
    let transcriptTouched = false;
    const ctx = {
      async openRewindPicker() {
        opened += 1;
      },
      setMessages() {
        transcriptTouched = true;
      },
    } as unknown as SessionCommandContext;
    const command = createSessionCommands(ctx).find((entry) => entry.name === "rewind");
    expect(command?.aliases).toEqual(["checkpoint"]);
    expect(allCommands.some((entry) => entry.name === "checkpoint")).toBe(false);

    await command!.run("", "/rewind");
    expect(opened).toBe(1);
    expect(transcriptTouched).toBe(false);
  });

  test("matches Claude Code restore options to checkpoint availability", () => {
    const point = {
      uuid: "u",
      parentUuid: null,
      content: "change the card",
      timestamp: "2026-01-01T00:00:00.000Z",
      branchHeadUuid: "head",
      diffStats: { filesChanged: ["workspace/card.md"], insertions: 3, deletions: 1 },
    };
    expect(rewindRestoreOptions(point).map((option) => option.value)).toEqual([
      "both",
      "conversation",
      "code",
      "summarize",
      "nevermind",
    ]);
    expect(rewindPointLine(point, 80)).toContain("1 file +3 -1");
    expect(rewindRestoreOptions({ ...point, diffStats: undefined }).map((option) => option.value)).toEqual([
      "conversation",
      "summarize",
      "nevermind",
    ]);
  });
});
