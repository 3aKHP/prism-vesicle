import { describe, expect, test } from "bun:test";
import { planToolRound } from "../../../src/core/agent-loop/tool-round-planner";
import { recordToolResult } from "../../../src/core/agent-loop/tool-result-recorder";
import type { AgentLoopEvent } from "../../../src/core/agent-loop/types";
import type { SessionStore } from "../../../src/core/session/store";
import type { ToolCall, ToolDefinition } from "../../../src/core/tools";
import type { VesicleMessage } from "../../../src/providers/shared/types";

describe("agent loop tool round", () => {
  test("plans interaction, capability, permission, and malformed shell paths independently", () => {
    const calls: ToolCall[] = [
      { id: "read", name: "read_file", arguments: '{"path":"assets/README.md"}' },
      { id: "missing", name: "hallucinated_tool", arguments: "{}" },
      { id: "shell", name: "shell_exec", arguments: "{" },
      { id: "question", name: "ask_user_question", arguments: "{}" },
    ];
    const plan = planToolRound(calls, [definition("read_file"), definition("shell_exec"), definition("ask_user_question")], {
      mode: "MANUAL",
      shellExecEnabled: true,
    });

    expect(plan.interactiveCalls.map((call) => call.id)).toEqual(["question"]);
    expect(plan.permissionRequiredCalls.map((call) => call.id)).toEqual(["read"]);
    expect(plan.executableHostToolCalls.map((call) => call.id)).toEqual(["missing", "shell"]);
    expect([...plan.unavailableHostCallIds]).toEqual(["missing"]);
  });

  test("records one tool result in message, session, then event order", async () => {
    const messages: VesicleMessage[] = [];
    const order: string[] = [];
    const session = {
      sessionId: "session",
      sessionPath: "/tmp/session.jsonl",
      headUuid: () => null,
      append: async (record) => {
        expect(messages).toHaveLength(1);
        order.push("session");
        return {
          uuid: "record",
          parentUuid: null,
          ts: "2026-07-13T00:00:00.000Z",
          sessionId: "session",
          ...record,
        };
      },
      appendMany: async () => { throw new Error("unexpected batch append"); },
    } satisfies SessionStore;

    await recordToolResult({
      result: { callId: "call", name: "read_file", ok: true, content: "contents" },
      messages,
      session,
      metadata: { permissionMode: "INERTIA", decisionSource: "policy" },
      onEvent: (event: AgentLoopEvent) => {
        expect(event.type).toBe("tool_result");
        order.push("event");
      },
    });

    expect(messages).toEqual([{
      role: "tool",
      toolCallId: "call",
      content: JSON.stringify({ ok: true, result: "contents" }),
    }]);
    expect(order).toEqual(["session", "event"]);
  });
});

function definition(name: string): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    },
  };
}
