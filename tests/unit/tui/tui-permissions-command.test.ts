import { describe, expect, test } from "bun:test";
import type { PermissionMode } from "../../../src/core/permissions";
import { createPermissionsCommands } from "../../../src/tui/commands/permissions";
import type { PermissionsCommandContext } from "../../../src/tui/commands/types";
import type { Message } from "../../../src/tui/types";

describe("/permissions command", () => {
  test("shows and changes the four coarse permission modes", async () => {
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
    } as unknown as PermissionsCommandContext;
    const command = createPermissionsCommands(ctx).find((entry) => entry.name === "permissions");
    if (!command) throw new Error("Missing /permissions command.");

    await command.run("", "/permissions");
    expect(messages.at(-1)?.content).toContain("MOMENTUM");
    await command.run("inertia", "/permissions inertia");
    expect(String(mode)).toBe("INERTIA");
    await command.run("yolo", "/permissions yolo");
    expect(String(mode)).toBe("YOLO");
  });

  test("rejects unknown modes before changing state", async () => {
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
    } as unknown as PermissionsCommandContext;
    const command = createPermissionsCommands(ctx).find((entry) => entry.name === "permissions")!;
    await command.run("turbo", "/permissions turbo");
    expect(changed).toBe(false);
    expect(messages.at(-1)?.content).toContain("Unknown permission mode");
  });
});
