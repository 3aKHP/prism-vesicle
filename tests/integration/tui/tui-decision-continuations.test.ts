import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createSessionStore } from "../../../src/core/session/store";
import { createDecisionContinuations } from "../../../src/tui/decision-continuations";

import { makeContinuationBundle, recordSetter } from "../../../tests/support/tui/continuation-bundle";
import type { PendingGateState, PendingUserQuestionState } from "../../../src/tui/decision-interaction";

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
    const pendingUpdates: Array<PendingGateState | null> = [];
    let interrupted = 0;
    let queuedInterruptionHandled = 0;
    const continuations = createDecisionContinuations(makeContinuationBundle({
      session: { rootDir: root },
      decision: {
        pendingGate: () => pending as unknown as PendingGateState,
        setPendingGate: recordSetter(pendingUpdates),
        setGateFeedbackMode: (() => undefined) as never,
        clearGateFeedback: () => undefined,
      },
      transcript: {
        setStatus: (() => undefined) as never,
        setMessages: (() => undefined) as never,
        recordActivity: () => undefined,
      },
      queuedWork: {
        handleInterruption: async (sessionId: string | undefined) => {
          expect(sessionId).toBe("parent");
          queuedInterruptionHandled += 1;
          return true;
        },
      },
      handleInterruptedTurn: () => { interrupted += 1; },
    }));

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
    const pendingUpdates: Array<PendingUserQuestionState | null> = [];
    const statuses: string[] = [];
    let interrupted = 0;
    const continuations = createDecisionContinuations(makeContinuationBundle({
      session: { rootDir: root },
      runtime: {
        busy: () => false,
        setBusy: recordSetter(busy),
      },
      decision: {
        pendingUserQuestion: () => pending as unknown as PendingUserQuestionState,
        setPendingUserQuestion: recordSetter(pendingUpdates),
        setQuestionSelected: (() => undefined) as never,
        clearQuestionFreeform: () => undefined,
      },
      transcript: {
        setStatus: recordSetter(statuses),
        setMessages: (() => undefined) as never,
        recordActivity: () => undefined,
      },
      agent: {
        agentCards: () => [],
      },
      handleInterruptedTurn: () => { interrupted += 1; statuses.push("Interrupted"); },
    }));

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
    const pendingUpdates: Array<PendingUserQuestionState | null> = [];
    const statuses: string[] = [];
    let reported = 0;
    const continuations = createDecisionContinuations(makeContinuationBundle({
      session: { rootDir: root },
      runtime: {
        busy: () => false,
        setBusy: recordSetter(busy),
      },
      decision: {
        pendingUserQuestion: () => pending as unknown as PendingUserQuestionState,
        setPendingUserQuestion: recordSetter(pendingUpdates),
        setQuestionSelected: (() => undefined) as never,
        clearQuestionFreeform: () => undefined,
      },
      transcript: {
        setStatus: recordSetter(statuses),
        setMessages: (() => undefined) as never,
        recordActivity: () => undefined,
      },
      agent: {
        agentCards: () => [],
      },
      runCancellable: async () => { throw new Error("provider failed after persistence"); },
      handleInterruptedTurn: () => undefined,
      reportError: () => { reported += 1; statuses.push("error"); },
    }));

    await continuations.submitUserQuestionAnswer(0);
    expect(pendingUpdates).toEqual([null, null]);
    expect(busy).toEqual([true, true]);
    expect(statuses.at(-1)).toContain("Unable to verify Harness delegation recovery");
    expect(reported).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
