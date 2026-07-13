import { describe, expect, test } from "bun:test";
import type { RunPromptResult } from "../src/core/agent-loop/run";
import type { EngineProfile } from "../src/core/engine/profile";
import type { PermissionRequest } from "../src/core/permissions";
import { createTurnResultController } from "../src/tui/turn-result-controller";
import type { Message } from "../src/tui/types";

describe("TUI turn result controller", () => {
  test("does not render an empty assistant message for a pending permission", () => {
    const harness = createHarness();

    harness.handle(permissionResult(""));

    expect(harness.messages()).toEqual([
      { role: "system", content: "Permission pending: read_file." },
    ]);
  });

  test("renders non-empty pending permission content before the host notice", () => {
    const harness = createHarness();

    harness.handle(permissionResult("I need permission to inspect the file."));

    expect(harness.messages()).toEqual([
      { role: "assistant", content: "I need permission to inspect the file." },
      { role: "system", content: "Permission pending: read_file." },
    ]);
  });

  test("does not render pending assistant content already shown by a tool response", () => {
    const content = "I need permission to inspect the file.";
    const harness = createHarness(content);

    harness.handle(permissionResult(content));

    expect(harness.messages()).toEqual([
      { role: "system", content: "Permission pending: read_file." },
    ]);
  });
});

function createHarness(lastDisplayedContent: string | null = null) {
  let messages: Message[] = [];
  const noop = () => undefined;
  const controller = createTurnResultController({
    activeEngine: () => "etl",
    activeModel: () => "test-model",
    clearGateFeedback: noop,
    clearQuestionFreeform: noop,
    lastDisplayedToolAssistantContent: () => lastDisplayedContent,
    publishTurnUsage: noop,
    refreshArtifacts: async () => [],
    setConversation: noop,
    setGateFeedbackMode: noop,
    setGateFocus: noop,
    setLastDisplayedToolAssistantContent: noop,
    setMessages: (next) => {
      messages = typeof next === "function" ? next(messages) : next;
      return messages;
    },
    setOutput: noop,
    setPendingEngineSwitch: noop,
    setPendingGate: noop,
    setPendingPermission: noop,
    setPendingUserQuestion: noop,
    setQuestionSelected: noop,
    setSessionId: noop,
    setSessionPath: noop,
    setSessionPicker: noop,
    setStatus: noop,
  });
  return {
    handle: controller.handleResult,
    messages: () => messages,
  };
}

function permissionResult(assistantContent: string): RunPromptResult {
  const profile: EngineProfile = {
    id: "etl",
    displayName: "ETL",
    protocolVersion: "test",
    systemPrompt: ["assets/prompts/base.md"],
    defaultTools: [],
    validators: [],
    stopGates: [],
    stateRoots: [],
    asset: { path: "assets/engines/etl.profile.yaml", source: "project" },
  };
  const request: PermissionRequest = {
    id: "permission-test",
    sessionId: "session-test",
    toolCallId: "call-test",
    toolName: "read_file",
    arguments: "{}",
    permissionClass: "observe",
    mode: "MANUAL",
    createdAt: "2026-07-13T00:00:00.000Z",
  };
  return {
    kind: "needs_permission",
    sessionId: "session-test",
    sessionPath: ".vesicle/sessions/session-test.jsonl",
    profile,
    request,
    remainingToolCalls: [],
    messages: [],
    assistantContent,
  };
}
