import { describe, expect, test } from "bun:test";
import {
  evaluatePermissionPolicy,
  permissionClassForTool,
  ToolPermissionBroker,
  type PermissionClass,
  type PermissionMode,
} from "../src/core/permissions";
import { parseCliInvocation } from "../src/cli/args";

describe("permission modes", () => {
  const expected: Record<PermissionMode, Record<PermissionClass, "allow" | "ask">> = {
    MANUAL: { observe: "ask", mutate: "ask", arbitrary_exec: "ask", interaction: "allow" },
    INERTIA: { observe: "allow", mutate: "ask", arbitrary_exec: "ask", interaction: "allow" },
    MOMENTUM: { observe: "allow", mutate: "allow", arbitrary_exec: "ask", interaction: "allow" },
    YOLO: { observe: "allow", mutate: "allow", arbitrary_exec: "allow", interaction: "allow" },
  };

  for (const [mode, classes] of Object.entries(expected) as Array<[PermissionMode, Record<PermissionClass, "allow" | "ask">]>) {
    test(`${mode} follows the approval matrix`, () => {
      for (const [permissionClass, decision] of Object.entries(classes) as Array<[PermissionClass, "allow" | "ask"]>) {
        expect(evaluatePermissionPolicy(mode, permissionClass)).toBe(decision);
      }
    });
  }

  test("classifies built-in, interaction, shell, and unknown MCP tools", () => {
    expect(permissionClassForTool("read_file")).toBe("observe");
    expect(permissionClassForTool("write_file")).toBe("mutate");
    expect(permissionClassForTool("request_confirmation")).toBe("interaction");
    expect(permissionClassForTool("shell_exec")).toBe("arbitrary_exec");
    expect(permissionClassForTool("mcp_remote_claimed_readonly")).toBe("mutate");
  });
});

describe("parent-owned permission broker", () => {
  test("serializes concurrent child requests", async () => {
    const broker = new ToolPermissionBroker();
    const shown: Array<string | undefined> = [];
    broker.subscribe((request) => shown.push(request?.id));
    const base = {
      sessionId: "child",
      toolCallId: "call",
      toolName: "read_file",
      arguments: "{}",
      permissionClass: "observe" as const,
      mode: "MANUAL" as const,
      createdAt: new Date().toISOString(),
    };
    const first = broker.request({ ...base, id: "first" });
    const second = broker.request({ ...base, id: "second" });
    expect(broker.active()?.id).toBe("first");
    expect(broker.resolve("first", { decision: "allow_once", resolvedAt: new Date().toISOString() })).toBe(true);
    expect((await first).decision).toBe("allow_once");
    expect(broker.active()?.id).toBe("second");
    broker.resolve("second", { decision: "reject", resolvedAt: new Date().toISOString() });
    expect((await second).decision).toBe("reject");
    expect(shown).toEqual([undefined, "first", "second", undefined]);
  });

  test("removes a cancelled child request from the parent queue", async () => {
    const broker = new ToolPermissionBroker();
    const controller = new AbortController();
    const result = broker.request({
      id: "cancelled",
      sessionId: "child",
      toolCallId: "call",
      toolName: "write_file",
      arguments: "{}",
      permissionClass: "mutate",
      mode: "INERTIA",
      createdAt: new Date().toISOString(),
    }, controller.signal);
    controller.abort();
    expect((await result).decision).toBe("reject");
    expect(broker.active()).toBeUndefined();
  });
});

describe("dangerous CLI override", () => {
  test("removes the flag regardless of position", () => {
    expect(parseCliInvocation(["--dangerously-skip-permissions", "dev"])).toEqual({
      args: ["dev"],
      dangerouslySkipPermissions: true,
    });
    expect(parseCliInvocation(["once", "hello", "--dangerously-skip-permissions"])).toEqual({
      args: ["once", "hello"],
      dangerouslySkipPermissions: true,
    });
  });

  test("defaults to the ordinary permission path", () => {
    expect(parseCliInvocation(["doctor"])).toEqual({
      args: ["doctor"],
      dangerouslySkipPermissions: false,
    });
  });
});
