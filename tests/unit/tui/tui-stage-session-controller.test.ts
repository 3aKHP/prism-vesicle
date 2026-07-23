import { expect, test } from "bun:test";
import type { StartedStageSession } from "../../../src/core/stage/bootstrap";
import type { VesicleMessage } from "../../../src/providers/shared/types";
import { createStageSessionController } from "../../../src/tui/stage-session-controller";
import type { ActivityEntry, Message } from "../../../src/tui/types";

test("Stage startup applies the durable bootstrap result to host session state", async () => {
  const started: StartedStageSession = {
    sessionId: "stage-session",
    sessionPath: "/tmp/stage-session.jsonl",
    systemPrompt: "system",
    opening: "Stage opening",
    openingRecordUuid: "opening-record",
    messages: [{ role: "assistant", content: "Stage opening", kind: "stage-bootstrap-opening" }],
    bootstrap: {} as StartedStageSession["bootstrap"],
    warnings: ["scenario warning"],
  };
  const state = {
    queueCleared: false,
    sessionId: "",
    sessionPath: "",
    engine: "etl",
    conversation: [] as VesicleMessage[],
    output: "old",
    lastTurnUsage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, contextInputTokens: 1 } as any,
    sessionUsage: undefined as any,
    nextParent: { uuid: "parent" } as { uuid: string } | null,
    pendingClears: 0,
    messages: [] as Message[],
    status: "",
    activity: [] as ActivityEntry[],
  };
  let bootstrapOptions: unknown;
  const controller = createStageSessionController({
    rootDir: "/project",
    activeProvider: () => "provider-a",
    activeModel: () => "model-a",
    permissionMode: () => "MOMENTUM",
    reasoningTier: () => "high",
    clearQueuedInputs: () => { state.queueCleared = true; },
    setSessionId: (value) => { state.sessionId = value; },
    setSessionPath: (value) => { state.sessionPath = value; },
    setActiveEngine: (value) => { state.engine = value; },
    setConversation: (value) => { state.conversation = value; },
    setOutput: (value) => { state.output = value; },
    setLastTurnUsage: (value) => { state.lastTurnUsage = value; },
    setSessionUsage: (value) => { state.sessionUsage = value; },
    setNextSessionParent: (value) => { state.nextParent = value; },
    setPendingGate: () => { state.pendingClears += 1; },
    setPendingEngineSwitch: () => { state.pendingClears += 1; },
    setPendingUserQuestion: () => { state.pendingClears += 1; },
    setPendingPermission: () => { state.pendingClears += 1; },
    setPendingQualityDecision: () => { state.pendingClears += 1; },
    setMessages: (value) => { state.messages = value; },
    setStatus: (value) => { state.status = value; },
    recordActivity: (value) => { state.activity.push(value); },
    startSession: async (options) => { bootstrapOptions = options; return started; },
  });

  await controller.start("workspace/character.md", "workspace/scenario.md", "/stage workspace/character.md workspace/scenario.md");

  expect(bootstrapOptions).toEqual({
    rootDir: "/project",
    characterPath: "workspace/character.md",
    scenarioPath: "workspace/scenario.md",
    provider: "provider-a",
    providerId: "provider-a",
    model: "model-a",
    permissionMode: "MOMENTUM",
    reasoningTier: "high",
  });
  expect(state.queueCleared).toBe(true);
  expect(state.sessionId).toBe("stage-session");
  expect(state.sessionPath).toBe("/tmp/stage-session.jsonl");
  expect(state.engine).toBe("stage");
  expect(state.conversation).toEqual(started.messages);
  expect(state.output).toBe("Stage opening");
  expect(state.lastTurnUsage).toBeUndefined();
  expect(state.sessionUsage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, contextInputTokens: 0 });
  expect(state.nextParent).toBeNull();
  expect(state.pendingClears).toBe(5);
  expect(state.messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "/stage workspace/character.md workspace/scenario.md"],
    ["system", "Stage card warning: scenario warning"],
    ["assistant", "Stage opening"],
  ]);
  expect(state.status).toBe("Stage session ready");
  expect(state.activity).toEqual([{ kind: "system", text: "started Stage session stage-session" }]);
});
