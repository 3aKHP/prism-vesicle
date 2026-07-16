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

  test("projects an exhausted quality result into a dedicated decision without delivering the candidate", () => {
    const harness = createHarness();
    harness.handle(qualityDecisionResult());
    expect(harness.pendingQuality()).toMatchObject({
      engine: "runtime",
      decision: { reason: "exhausted", findingCount: 1 },
    });
    expect(harness.messages()).toEqual([
      { role: "system", content: "Automatic quality revision is exhausted. The current version still has 1 blocking finding." },
    ]);
  });

  test("keeps clean, advisory, and inconclusive completion statuses distinct", () => {
    const expected = [
      ["clean", 0, "complete; no blocking quality rules matched"],
      ["findings", 2, "complete with 2 observed style issues"],
      ["inconclusive", 0, "complete; quality check incomplete"],
    ] as const;
    for (const [outcome, findingCount, status] of expected) {
      const harness = createHarness();
      harness.handle(completeQualityResult(outcome, findingCount));
      expect(harness.status()).toBe(status);
    }
  });
});

function createHarness(lastDisplayedContent: string | null = null) {
  let messages: Message[] = [];
  let pendingQuality: unknown;
  let status = "";
  const noop = () => undefined;
  const controller = createTurnResultController({
    activeEngine: () => "etl",
    activeModel: () => "test-model",
    clearGateFeedback: noop,
    clearQuestionFreeform: noop,
    lastDisplayedToolAssistantContent: () => lastDisplayedContent,
    publishTurnUsage: noop,
    refreshArtifacts: async () => [],
    refreshQualityWarnings: async () => [],
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
    setPendingQualityDecision: (value) => { pendingQuality = value; return value; },
    setPendingUserQuestion: noop,
    setQuestionSelected: noop,
    setQualitySelected: noop,
    setSessionId: noop,
    setSessionPath: noop,
    setSessionPicker: noop,
    setStatus: (value) => {
      status = typeof value === "function" ? value(status) : value;
      return status;
    },
  });
  return {
    handle: controller.handleResult,
    messages: () => messages,
    pendingQuality: () => pendingQuality,
    status: () => status,
  };
}

function completeQualityResult(
  outcome: "clean" | "findings" | "inconclusive",
  findingCount: number,
): RunPromptResult {
  return {
    kind: "complete",
    sessionId: "session-quality",
    sessionPath: ".vesicle/sessions/session-quality.jsonl",
    profile: permissionResult("").profile,
    response: { id: "quality-complete", content: "done" },
    quality: { outcome, findingCount },
    messages: [],
  };
}

function qualityDecisionResult(): RunPromptResult {
  return {
    kind: "needs_quality_decision",
    sessionId: "session-quality",
    sessionPath: ".vesicle/sessions/session-quality.jsonl",
    profile: { ...permissionResult("").profile, id: "runtime", displayName: "Runtime" },
    decision: {
      id: "quality-warning-1",
      reason: "exhausted",
      producer: "runtime",
      findingCount: 1,
      targets: [{ id: "artifact:workspace/a.md", path: "workspace/a.md", findingIds: ["zh-f0"] }],
      canRetry: true,
    },
    assistantContent: "not delivered",
    messages: [],
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
