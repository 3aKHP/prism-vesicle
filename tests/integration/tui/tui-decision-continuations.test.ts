import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createSessionStore } from "../../../src/core/session/store";
import { createDecisionContinuations } from "../../../src/tui/decision-continuations";

test("gate interruption delegates queued-session recovery before releasing the modal", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-tui-gate-queue-"));
  try {
    const session = await createSessionStore(root, "parent");
    await session.append({ role: "user", content: "start" });
    const pending = {
      kind: "needs_user",
      sessionId: "parent",
      sessionPath: session.sessionPath,
      engine: "etl",
      gate: { gate: "blueprint-confirmation", summary: "Review", options: [{ label: "Confirm", decision: "confirm" }] },
      toolCallId: "gate-call-1",
      assistantContent: "Blueprint",
      messages: [],
    } as const;
    const pendingUpdates: unknown[] = [];
    let interrupted = 0;
    let queuedInterruptionHandled = 0;
    const continuations = createDecisionContinuations({
      rootDir: root,
      busy: () => false,
      queuedWork: {
        block: () => undefined,
        handleInterruption: async (sessionId: string) => {
          expect(sessionId).toBe("parent");
          queuedInterruptionHandled += 1;
          return true;
        },
        takePendingUserInputs: () => [],
        runToolBoundaryCommands: async () => undefined,
      },
      pendingGate: () => pending,
      setBusy: (value: boolean) => value,
      setPendingGate: (value: unknown) => { pendingUpdates.push(value); return value; },
      setGateFeedbackMode: (value: unknown) => value,
      clearGateFeedback: () => undefined,
      setStatus: (value: string) => value,
      setMessages: (value: unknown) => value,
      agentCards: () => [],
      beginUsageTurn: () => undefined,
      recordActivity: () => undefined,
      runCancellable: async () => ({ kind: "interrupted" as const }),
      handleInterruptedTurn: () => { interrupted += 1; },
      reportError: () => undefined,
    } as any);

    await continuations.submitGateResolution({ decision: "confirm" });

    expect(pendingUpdates).toEqual([null]);
    expect(queuedInterruptionHandled).toBe(1);
    expect(interrupted).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user-question interruption does not restore a resolved Harness retry decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-tui-delegation-recovery-"));
  try {
    const session = await createSessionStore(root, "parent");
    await session.append({ role: "system", content: "parent" });
    await session.append({
      role: "system",
      content: "",
      metadata: {
        kind: "delegation-retry-intent",
        retryIntent: {
          id: "retry-intent-1",
          interactionId: "weaver-orch.agent-failure",
          failedRunId: "run-failed",
          delegationId: "weaver-orch.scene-writer",
          attempt: 3,
          retryCallId: "retry-call-1",
        },
      },
    });
    await session.append({
      role: "tool",
      content: "retry authorized",
      metadata: {
        kind: "delegation-decision-resolution",
        toolCallId: "decision-call-1",
        optionId: "retry",
        retryIntentId: "retry-intent-1",
      },
    });

    const pending = {
      kind: "needs_user_question",
      sessionId: "parent",
      sessionPath: session.sessionPath,
      engine: "weaver-orch",
      question: {
        header: "Subtask failure",
        question: "Choose recovery.",
        options: [{ id: "retry", label: "Retry", description: "Retry once.", kind: "model" }],
      },
      toolCallId: "decision-call-1",
      assistantContent: "",
      messages: [],
    } as const;
    const busy: boolean[] = [];
    const pendingUpdates: unknown[] = [];
    const statuses: string[] = [];
    let interrupted = 0;
    const continuations = createDecisionContinuations({
      rootDir: root,
      busy: () => false,
      queuedWork: {
        block: () => undefined,
        handleInterruption: async () => false,
        takePendingUserInputs: () => [],
        runToolBoundaryCommands: async () => undefined,
      },
      pendingUserQuestion: () => pending,
      setBusy: (value: boolean) => { busy.push(value); return value; },
      setStatus: (value: string) => { statuses.push(value); return value; },
      setPendingUserQuestion: (value: unknown) => { pendingUpdates.push(value); return value; },
      setQuestionSelected: (value: number) => value,
      clearQuestionFreeform: () => undefined,
      setMessages: (value: unknown) => value,
      beginUsageTurn: () => undefined,
      recordActivity: () => undefined,
      runCancellable: async () => ({ kind: "interrupted" as const }),
      handleInterruptedTurn: () => { interrupted += 1; statuses.push("Interrupted"); },
      reportError: () => undefined,
    } as any);

    await continuations.submitUserQuestionAnswer(0);
    expect(pendingUpdates).toEqual([null, null]);
    expect(busy).toEqual([true, true]);
    expect(statuses.at(-1)).toContain("restart Vesicle and resume");
    expect(interrupted).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user-question recovery fails closed when the durable session cannot be loaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesicle-tui-delegation-recovery-"));
  try {
    const pending = {
      kind: "needs_user_question",
      sessionId: "missing-parent",
      sessionPath: join(root, ".vesicle", "sessions", "missing-parent.jsonl"),
      engine: "weaver-orch",
      question: {
        header: "Subtask failure",
        question: "Choose recovery.",
        options: [{ id: "retry", label: "Retry", description: "Retry once.", kind: "model" }],
      },
      toolCallId: "decision-call-1",
      assistantContent: "",
      messages: [],
    } as const;
    const busy: boolean[] = [];
    const pendingUpdates: unknown[] = [];
    const statuses: string[] = [];
    let reported = 0;
    const continuations = createDecisionContinuations({
      rootDir: root,
      busy: () => false,
      queuedWork: {
        block: () => undefined,
        handleInterruption: async () => false,
        takePendingUserInputs: () => [],
        runToolBoundaryCommands: async () => undefined,
      },
      pendingUserQuestion: () => pending,
      setBusy: (value: boolean) => { busy.push(value); return value; },
      setStatus: (value: string) => { statuses.push(value); return value; },
      setPendingUserQuestion: (value: unknown) => { pendingUpdates.push(value); return value; },
      setQuestionSelected: (value: number) => value,
      clearQuestionFreeform: () => undefined,
      setMessages: (value: unknown) => value,
      beginUsageTurn: () => undefined,
      recordActivity: () => undefined,
      runCancellable: async () => { throw new Error("provider failed after persistence"); },
      handleInterruptedTurn: () => undefined,
      reportError: () => { reported += 1; statuses.push("error"); },
    } as any);

    await continuations.submitUserQuestionAnswer(0);
    expect(pendingUpdates).toEqual([null, null]);
    expect(busy).toEqual([true, true]);
    expect(statuses.at(-1)).toContain("Unable to verify Harness delegation recovery");
    expect(reported).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
