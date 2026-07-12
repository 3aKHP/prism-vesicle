import { describe, expect, test } from "bun:test";
import type { PermissionMode } from "../src/core/permissions";
import { builtinCommands } from "../src/tui/commands/builtin";
import type { CommandContext } from "../src/tui/commands/types";
import type { Message } from "../src/tui/types";

describe("/permissions command", () => {
  test("shows and changes the four coarse permission modes", async () => {
    const command = builtinCommands.find((entry) => entry.name === "permissions");
    if (!command) throw new Error("Missing /permissions command.");
    let mode: PermissionMode = "MOMENTUM";
    let messages: Message[] = [];
    const ctx = {
      setMessages(updater: (previous: Message[]) => Message[]) {
        messages = updater(messages);
      },
      permissionMode: () => mode,
      async changePermissionMode(next: PermissionMode) {
        mode = next;
      },
    } as unknown as CommandContext;

    await command.run(ctx, "", "/permissions");
    expect(messages.at(-1)?.content).toContain("MOMENTUM");
    await command.run(ctx, "inertia", "/permissions inertia");
    expect(String(mode)).toBe("INERTIA");
    await command.run(ctx, "yolo", "/permissions yolo");
    expect(String(mode)).toBe("YOLO");
  });

  test("rejects unknown modes before changing state", async () => {
    const command = builtinCommands.find((entry) => entry.name === "permissions")!;
    let changed = false;
    let messages: Message[] = [];
    const ctx = {
      setMessages(updater: (previous: Message[]) => Message[]) {
        messages = updater(messages);
      },
      permissionMode: () => "MOMENTUM" as const,
      async changePermissionMode() {
        changed = true;
      },
    } as unknown as CommandContext;
    await command.run(ctx, "turbo", "/permissions turbo");
    expect(changed).toBe(false);
    expect(messages.at(-1)?.content).toContain("Unknown permission mode");
  });
});
