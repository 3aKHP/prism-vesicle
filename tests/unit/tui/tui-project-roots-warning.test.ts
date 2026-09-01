import { createRoot, createSignal } from "solid-js";
import { describe, expect, test } from "bun:test";
import { createAgentProcessController } from "../../../src/tui/agent-process-controller";
import type { AgentLoopEvent } from "../../../src/core/agent-loop/run";
import type { ActivityEntry, AgentCardState, Message } from "../../../src/tui/types";
import type { BackgroundProcessState } from "../../../src/core/process/manager";

type RootsWarningEvent = Extract<AgentLoopEvent, { type: "project_roots_warning" }>;

function rootsWarningEvent(failures: RootsWarningEvent["failures"], sessionId = "session-1"): RootsWarningEvent {
  return { type: "project_roots_warning", sessionId, failures };
}

function harness(sessionId = "session-1") {
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [activity, setActivity] = createSignal<ActivityEntry[]>([]);
  const [background, setBackground] = createSignal<BackgroundProcessState[]>([]);
  const [, setCards] = createSignal<AgentCardState[]>([]);
  const [, setStatus] = createSignal("");
  const [, setStreamingAssistant] = createSignal("");
  const [, setStreamingReasoning] = createSignal("");
  const [, setLastToolContent] = createSignal<string | null>(null);
  const controller = createAgentProcessController({
    sessionId: () => sessionId,
    busy: () => false,
    activeEngine: () => "runtime",
    activeModel: () => "test-model",
    backgroundProcesses: background,
    setBackgroundProcesses: setBackground,
    setAgentCards: setCards,
    setMessages,
    setActivity,
    setStatus,
    setStreamingAssistant,
    setStreamingReasoning,
    setLastDisplayedToolAssistantContent: setLastToolContent,
    markTurnSawResponse: () => undefined,
    recordResponseUsage: () => undefined,
    recordIndependentAgentUsage: () => undefined,
    assetDriftKey: () => undefined,
    setAssetDriftKey: () => undefined,
  });
  return { controller, messages, activity };
}

describe("project roots warning notice", () => {
  test("appends one combined system message naming each failed root and records activity", () => createRoot((dispose) => {
    const { controller, messages, activity } = harness();

    controller.handleAgentEvent(rootsWarningEvent([
      { root: "workspace", message: "EEXIST: file exists" },
      { root: "tmp", message: "EACCES: permission denied" },
    ]));

    const system = messages().filter((message) => message.role === "system");
    expect(system.length).toBe(1);
    expect(system[0]!.content).toContain('"workspace"');
    expect(system[0]!.content).toContain('"tmp"');
    expect(activity().some((entry) => entry.kind === "system" && entry.text.includes("2 project roots"))).toBe(true);
    dispose();
  }));

  test("ignores an empty failure list", () => createRoot((dispose) => {
    const { controller, messages, activity } = harness();

    controller.handleAgentEvent(rootsWarningEvent([]));

    expect(messages().length).toBe(0);
    expect(activity().length).toBe(0);
    dispose();
  }));
});
