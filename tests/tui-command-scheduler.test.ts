import { describe, expect, test } from "bun:test";
import { executeQueuedCommands, routeCommandSubmission } from "../src/tui/command-scheduler";
import type { QueuedCommand } from "../src/tui/input-queue";
import { builtinCommands } from "../src/tui/commands/builtin";
import { resolveCommandBusyBehavior, resolveCommandInvocation } from "../src/tui/commands/dispatch";

describe("TUI command scheduler", () => {
  test("maps built-in command invocations to their declared busy behavior", () => {
    const expected = [
      ["/stage workspace/a.md workspace/b.md", { kind: "queue", boundary: "agent-loop" }],
      ["/help", { kind: "immediate" }],
      ["/quality", { kind: "queue", boundary: "agent-loop" }],
      ["/permissions", { kind: "immediate" }],
      ["/permissions MOMENTUM", { kind: "queue", boundary: "agent-loop" }],
      ["/quality status", { kind: "immediate" }],
      ["/quality off", { kind: "queue", boundary: "agent-loop" }],
      ["/agents", { kind: "immediate" }],
      ["/agents stop explore-1", { kind: "immediate" }],
      ["/agents retry", { kind: "queue", boundary: "agent-loop" }],
      ["/engine", { kind: "immediate" }],
      ["/engine runtime", { kind: "queue", boundary: "agent-loop" }],
      ["/compact", { kind: "queue", boundary: "agent-loop" }],
      ["/context", { kind: "immediate" }],
      ["/model alpha", { kind: "queue", boundary: "agent-loop" }],
      ["/effort", { kind: "immediate" }],
      ["/effort high", { kind: "queue", boundary: "agent-loop" }],
      ["/reasoning expanded", { kind: "immediate" }],
      ["/artifact 1", { kind: "queue", boundary: "tool-round" }],
      ["/validate 1", { kind: "queue", boundary: "tool-round" }],
      ["/rewind", { kind: "queue", boundary: "agent-loop" }],
      ["/new", { kind: "queue", boundary: "agent-loop" }],
      ["/resume", { kind: "queue", boundary: "agent-loop" }],
    ] as const;

    for (const [raw, behavior] of expected) {
      const invocation = resolveCommandInvocation(raw, builtinCommands);
      expect(invocation.command).not.toBeNull();
      expect(resolveCommandBusyBehavior(invocation.command!, invocation.args)).toEqual(behavior);
    }
  });

  test("executes immediate and unknown commands, queues deferred commands, and preserves rejected drafts", () => {
    const executed: string[] = [];
    const queued: string[] = [];
    const rejected: string[] = [];
    const handlers = {
      execute: (raw: string) => { executed.push(raw); },
      enqueue: (command: { raw: string }) => { queued.push(command.raw); return queued.length; },
      reject: (reason: string) => { rejected.push(reason); },
    };

    expect(routeCommandSubmission("/help", true, builtinCommands, handlers)).toBe(true);
    expect(routeCommandSubmission("/model alpha", true, builtinCommands, handlers)).toBe(true);
    expect(routeCommandSubmission("/unknown", true, builtinCommands, handlers)).toBe(true);
    expect(executed).toEqual(["/help", "/unknown"]);
    expect(queued).toEqual(["/model alpha"]);

    const rejectCommand = [{
      name: "publish",
      description: "Publish",
      busyBehavior: { kind: "reject" as const, reason: "publish requires an idle session" },
      run: async () => undefined,
    }];
    expect(routeCommandSubmission("/publish", true, rejectCommand, handlers)).toBe(false);
    expect(rejected).toEqual(["publish requires an idle session"]);
  });

  test("executes a tool-boundary batch in order and restores only the unattempted suffix", async () => {
    const commands: QueuedCommand[] = [
      { id: 1, kind: "command", raw: "/artifact", commandName: "artifact", args: "", boundary: "tool-round" },
      { id: 2, kind: "command", raw: "/validate 1", commandName: "validate", args: "1", boundary: "tool-round" },
      { id: 3, kind: "command", raw: "/artifact 2", commandName: "artifact", args: "2", boundary: "tool-round" },
    ];
    const executed: string[] = [];
    const restored: string[] = [];
    const errors: unknown[] = [];

    await executeQueuedCommands(commands, {
      execute: async (raw) => {
        executed.push(raw);
        if (raw === "/validate 1") throw new Error("validation read failed");
      },
      restoreNext: (command) => { restored.unshift(command.raw); },
      reportError: (error) => { errors.push(error); },
    });

    expect(executed).toEqual(["/artifact", "/validate 1"]);
    expect(restored).toEqual(["/artifact 2"]);
    expect(errors).toHaveLength(1);
  });
});
