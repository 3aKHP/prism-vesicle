import { describe, expect, test } from "bun:test";
import type { ArtifactEntry } from "../../../src/core/artifacts/workbench";
import { createBuiltinCommands } from "../../../src/tui/commands/builtin";
import { createWorkspaceCommands } from "../../../src/tui/commands/workspace";
import type { BuiltinCommandContexts, WorkspaceCommandContext } from "../../../src/tui/commands/types";
import type { Message } from "../../../src/tui/types";

const allCommands = createBuiltinCommands({} as unknown as BuiltinCommandContexts);

const entries: ArtifactEntry[] = [
  { path: "workspace/cards/mira.md", updatedAt: "2026-07-10T00:00:00.000Z" },
  { path: "reports/audit.md", updatedAt: "2026-07-09T00:00:00.000Z" },
];

describe("/artifact command (Workspace page bridge)", () => {
  test("is the only artifact listing command", () => {
    expect(allCommands.some((command) => command.name === "artifact")).toBe(true);
    expect(allCommands.some((command) => command.name === "artifacts")).toBe(false);
  });

  test("opens the latest artifact in the Workspace page without an argument", async () => {
    const harness = commandHarness();
    await harness.command.run("", "/artifact");

    expect(harness.refreshes()).toBe(1);
    expect(harness.openedTargets()).toEqual(["workspace/cards/mira.md"]);
    expect(harness.messages()[1]?.content).toContain("workspace/cards/mira.md");
  });

  test("reports when there are no artifacts yet", async () => {
    const harness = commandHarness("artifact", []);
    await harness.command.run("", "/artifact");

    expect(harness.openedTargets()).toEqual([undefined]);
    expect(harness.messages()[1]?.content).toContain("no artifacts");
  });

  test("opens a numbered artifact target in the Workspace page", async () => {
    const harness = commandHarness();
    await harness.command.run("2", "/artifact 2");

    expect(harness.openedTargets()).toEqual(["reports/audit.md"]);
    expect(harness.messages()[1]?.content).toContain("reports/audit.md");
  });

  test("refreshes artifacts before resolving a path target", async () => {
    const refreshed = [{ path: "workspace/new.md", updatedAt: "2026-07-21T00:00:00.000Z" }];
    const harness = commandHarness("artifact", refreshed);

    await harness.command.run("workspace/new.md", "/artifact workspace/new.md");

    expect(harness.refreshes()).toBe(1);
    expect(harness.openedTargets()).toEqual(["workspace/new.md"]);
  });

  test("keeps a not-found notice in the transcript without switching pages", async () => {
    const harness = commandHarness();
    await harness.command.run("missing.md", "/artifact missing.md");

    expect(harness.openedTargets()).toEqual([]);
    expect(harness.messages()[1]?.content).toContain("No artifact matches");
  });
});

function commandHarness(commandName = "artifact", refreshedEntries = entries) {
  let messages: Message[] = [];
  let refreshCount = 0;
  const openedTargets: (string | undefined)[] = [];

  const ctx = {
    setMessages(updater: (previous: Message[]) => Message[]) {
      messages = updater(messages);
    },
    async refreshArtifacts() {
      refreshCount += 1;
      return refreshedEntries;
    },
    async openWorkspaceTarget(relPath?: string) {
      openedTargets.push(relPath);
      return relPath ? "file" : null;
    },
  } as unknown as WorkspaceCommandContext;
  const command = createWorkspaceCommands(ctx).find((entry) => entry.name === commandName);
  if (!command) throw new Error(`Missing /${commandName} command.`);

  return {
    command,
    messages: () => messages,
    refreshes: () => refreshCount,
    openedTargets: () => openedTargets,
  };
}
