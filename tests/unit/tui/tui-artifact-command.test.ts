import { describe, expect, test } from "bun:test";
import type { ArtifactEntry, ArtifactPreview } from "../../../src/core/artifacts/workbench";
import { builtinCommands } from "../../../src/tui/commands/builtin";
import type { CommandContext } from "../../../src/tui/commands/types";
import type { Message } from "../../../src/tui/types";

const entries: ArtifactEntry[] = [
  { path: "workspace/cards/mira.md", updatedAt: "2026-07-10T00:00:00.000Z" },
  { path: "reports/audit.md", updatedAt: "2026-07-09T00:00:00.000Z" },
];

describe("/artifact command", () => {
  test("is the only artifact listing command", () => {
    expect(builtinCommands.some((command) => command.name === "artifact")).toBe(true);
    expect(builtinCommands.some((command) => command.name === "artifacts")).toBe(false);
  });

  test("lists artifacts when invoked without an argument", async () => {
    const harness = commandHarness();
    await harness.command.run(harness.ctx, "", "/artifact");

    expect(harness.refreshes()).toBe(1);
    expect(harness.messages()[1]?.content).toContain("1. workspace/cards/mira.md");
    expect(harness.messages()[1]?.content).toContain("/artifact <n|path> to preview");
  });

  test("adds a structured artifact preview to the message stream", async () => {
    const harness = commandHarness();
    await harness.command.run(harness.ctx, "1", "/artifact 1");

    const preview = harness.messages()[1];
    expect(preview).toMatchObject({
      role: "system",
      kind: "artifact",
      artifactPath: "workspace/cards/mira.md",
      content: "## Mira\n\nPreview body.",
    });
    expect(harness.selected()?.path).toBe("workspace/cards/mira.md");
    expect(harness.refreshes()).toBe(1);
  });

  test("refreshes artifacts before resolving a target", async () => {
    const refreshed = [{ path: "workspace/new.md", updatedAt: "2026-07-21T00:00:00.000Z" }];
    const harness = commandHarness("artifact", refreshed);

    await harness.command.run(harness.ctx, "workspace/new.md", "/artifact workspace/new.md");

    expect(harness.refreshes()).toBe(1);
    expect(harness.selected()?.path).toBe("workspace/new.md");
  });
});

function commandHarness(commandName = "artifact", refreshedEntries = entries) {
  const command = builtinCommands.find((entry) => entry.name === commandName);
  if (!command) throw new Error("Missing /artifact command.");
  let messages: Message[] = [];
  let refreshCount = 0;
  let selected: ArtifactPreview | null = null;

  const ctx = {
    setMessages(updater: (previous: Message[]) => Message[]) {
      messages = updater(messages);
    },
    artifacts: () => entries,
    async refreshArtifacts() {
      refreshCount += 1;
      return refreshedEntries;
    },
    async loadArtifactPreview(artifact: ArtifactEntry): Promise<ArtifactPreview> {
      return {
        ...artifact,
        preview: "## Mira\n\nPreview body.",
        truncated: false,
      };
    },
    setSelectedArtifact(artifact: ArtifactPreview) {
      selected = artifact;
    },
  } as unknown as CommandContext;

  return {
    command,
    ctx,
    messages: () => messages,
    refreshes: () => refreshCount,
    selected: () => selected,
  };
}
