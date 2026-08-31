import { describe, expect, test } from "bun:test";
import type { RunPromptResult } from "../../../src/core/agent-loop/run";
import type { EngineProfile } from "../../../src/core/engine/profile";
import type { PermissionRequest } from "../../../src/core/permissions";
import { createTurnResultController } from "../../../src/tui/turn-result-controller";
import type { Message } from "../../../src/tui/types";

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

  test("carries a bounded command summary on the pending shell_exec notice (#268)", () => {
    const harness = createHarness();

    harness.handle(shellPermissionResult({ command: "bun run build" }));

    expect(harness.messages()).toEqual([
      { role: "system", content: "Permission pending: shell_exec · bun run build." },
    ]);
  });

  test("truncates an oversized pending command summary to one bounded line (#268)", () => {
    const harness = createHarness();
    const longCommand = `echo ${"x".repeat(400)}`;

    harness.handle(shellPermissionResult({ command: longCommand }));

    const notice = harness.messages().at(-1)?.content ?? "";
    expect(notice.startsWith("Permission pending: shell_exec · echo ")).toBe(true);
    expect(notice.endsWith("...")).toBe(true);
    expect(notice.length).toBeLessThan(longCommand.length);
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

  test("opens queued-input delivery only after a complete turn", () => {
    const pending = createHarness();
    pending.handle(permissionResult(""));
    expect(pending.queuedInputReady()).toBe(false);

    const complete = createHarness();
    complete.handle(completeQualityResult("clean", 0));
    expect(complete.queuedInputReady()).toBe(true);
  });

  test("a clean auto-validation pass adds no message-stream card (issue #111)", () => {
    const harness = createHarness();
    harness.handle(completeValidationResult(0, 0));
    // The assistant reply stands alone; the passing runtime-packet check stays
    // in the activity log instead of interrupting the stream every turn.
    expect(harness.messages()).toEqual([
      { role: "assistant", content: "done", engine: "etl", model: "test-model" },
    ]);
    expect(harness.status()).toBe("complete");
  });

  test("auto-validation warnings keep a message-stream card and a distinct status", () => {
    const harness = createHarness();
    harness.handle(completeValidationResult(0, 1));
    expect(harness.messages().some((message) => message.role === "system" && message.content.includes("runtime-packet"))).toBe(true);
    expect(harness.status()).toBe("complete with validation warnings");
  });

  test("auto-validation errors keep a message-stream card and the findings status", () => {
    const harness = createHarness();
    harness.handle(completeValidationResult(1, 0));
    expect(harness.messages().some((message) => message.role === "system" && message.content.includes("runtime-packet"))).toBe(true);
    expect(harness.status()).toBe("complete with validation findings");
  });
});

function createHarness(lastDisplayedContent: string | null = null) {
  let messages: Message[] = [];
  let pendingQuality: unknown;
  let status = "";
  let queuedInputReady = false;
  const noop = () => undefined;
  const controller = createTurnResultController({
    runtime: {
      activeEngine: () => "etl",
      activeModel: () => "test-model",
    },
    session: {
      setConversation: noop,
      setSessionId: noop,
      setSessionPath: noop,
      setSessionPicker: noop,
    },
    transcript: {
      setMessages: (next) => {
        messages = typeof next === "function" ? next(messages) : next;
        return messages;
      },
      setOutput: noop,
      setStatus: (value) => {
        status = typeof value === "function" ? value(status) : value;
        return status;
      },
      lastDisplayedToolAssistantContent: () => lastDisplayedContent,
      setLastDisplayedToolAssistantContent: noop,
    },
    decision: {
      setPendingGate: noop,
      setPendingEngineSwitch: noop,
      setPendingUserQuestion: noop,
      setPendingPermission: noop,
      setPendingQualityDecision: (value) => { pendingQuality = value; return value; },
      clearQuestionFreeform: noop,
      setGateFocus: noop,
      setGateFeedbackMode: noop,
      clearGateFeedback: noop,
      setQuestionSelected: noop,
      setQualitySelected: noop,
    },
    usage: {
      publishTurnUsage: noop,
    },
    hostAction: {
      refreshArtifacts: async () => [],
      refreshQualityWarnings: async () => [],
    },
    queuedWork: {
      block: () => { queuedInputReady = false; },
      release: () => { queuedInputReady = true; },
    } as any,
  });
  return {
    handle: controller.handleResult,
    messages: () => messages,
    pendingQuality: () => pendingQuality,
    status: () => status,
    queuedInputReady: () => queuedInputReady,
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

// A complete turn whose `runtime-packet` validator matched. `ok` follows the
// registry rule (errors flip it; warnings never do), so the warnings-only case
// is `ok: true` with a finding.
function completeValidationResult(errors: number, warnings: number): RunPromptResult {
  const errorList = Array.from({ length: errors }, (_, index) => `error ${index + 1}`);
  const warningList = Array.from({ length: warnings }, (_, index) => `warning ${index + 1}`);
  return {
    kind: "complete",
    sessionId: "session-validation",
    sessionPath: ".vesicle/sessions/session-validation.jsonl",
    profile: permissionResult("").profile,
    response: { id: "validation-complete", content: "done" },
    validation: {
      ok: errors === 0,
      results: [{ name: "runtime-packet", result: { ok: errors === 0, errors: errorList, warnings: warningList } }],
    },
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
  return withRequest(shellPermissionResult({}, assistantContent), {
    id: "permission-test",
    toolCallId: "call-test",
    toolName: "read_file",
    arguments: "{}",
    permissionClass: "observe",
    mode: "MANUAL",
  });
}

function shellPermissionResult(
  shell: Record<string, unknown>,
  assistantContent = "",
): RunPromptResult {
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
    id: "permission-shell",
    sessionId: "session-test",
    toolCallId: "call-shell",
    toolName: "shell_exec",
    arguments: JSON.stringify(shell),
    permissionClass: "arbitrary_exec",
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

function withRequest(result: RunPromptResult, overrides: Partial<PermissionRequest>): RunPromptResult {
  return result.kind === "needs_permission" ? { ...result, request: { ...result.request, ...overrides } } : result;
}
