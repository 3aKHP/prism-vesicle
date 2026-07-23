import { createRoot, createSignal } from "solid-js";
import { describe, expect, test } from "bun:test";
import { createAgentProcessController } from "../../../src/tui/agent-process-controller";
import type { AgentLoopEvent } from "../../../src/core/agent-loop/run";
import type { ActivityEntry, AgentCardState, Message } from "../../../src/tui/types";
import type { BackgroundProcessState } from "../../../src/core/process/manager";

type InstructionWarningEvent = Extract<AgentLoopEvent, { type: "instruction_warning" }>;
type InstructionDiagnostic = InstructionWarningEvent["diagnostics"][number];

function makeDiagnostic(logicalName = "VESICLE.md", kind: InstructionDiagnostic["kind"] = "invalid-utf8"): InstructionDiagnostic {
  return { scope: "user", engine: "all", logicalName, kind, message: `${logicalName} is not valid UTF-8.` };
}

function warningEvent(
  diagnostics: InstructionWarningEvent["diagnostics"],
  sessionId = "session-1",
): InstructionWarningEvent {
  return { type: "instruction_warning", sessionId, engine: "runtime", diagnostics };
}

function harness(sessionId = "session-1") {
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [activity, setActivity] = createSignal<ActivityEntry[]>([]);
  const [background, setBackground] = createSignal<BackgroundProcessState[]>([]);
  const [cards, setCards] = createSignal<AgentCardState[]>([]);
  const [status, setStatus] = createSignal("");
  const [streamingAssistant, setStreamingAssistant] = createSignal("");
  const [streamingReasoning, setStreamingReasoning] = createSignal("");
  const [lastToolContent, setLastToolContent] = createSignal<string | null>(null);
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
  return { controller, messages, activity, status, background, cards, streamingAssistant, streamingReasoning, lastToolContent };
}

describe("instruction warning notice", () => {
  test("dedups identical warnings across events and re-notifies when the diagnostic changes", () => createRoot((dispose) => {
    const { controller, messages } = harness();

    controller.handleAgentEvent(warningEvent([makeDiagnostic()]));
    expect(messages().filter((m) => m.role === "system" && m.content.includes("skipped")).length).toBe(1);

    // Same diagnostic again (e.g. next top-level turn): no duplicate notice.
    controller.handleAgentEvent(warningEvent([makeDiagnostic()]));
    expect(messages().filter((m) => m.role === "system" && m.content.includes("skipped")).length).toBe(1);

    // A different diagnostic set re-notifies.
    controller.handleAgentEvent(warningEvent([makeDiagnostic("VESICLE.runtime.md", "oversized")]));
    expect(messages().filter((m) => m.role === "system" && m.content.includes("skipped")).length).toBe(2);
    expect(messages().at(-1)?.content).toContain("VESICLE.runtime.md");

    dispose();
  }));

  test("an empty status resets dedupe so the same later failure re-notifies", () => createRoot((dispose) => {
    const { controller, messages } = harness();

    controller.handleAgentEvent(warningEvent([makeDiagnostic()]));
    controller.handleAgentEvent(warningEvent([]));
    controller.handleAgentEvent(warningEvent([makeDiagnostic()]));

    expect(messages().filter((m) => m.role === "system" && m.content.includes("skipped")).length).toBe(2);
    dispose();
  }));

  test("uses the event session id so identical failures in different sessions both notify", () => createRoot((dispose) => {
    const { controller, messages } = harness("");

    controller.handleAgentEvent(warningEvent([makeDiagnostic()], "new-session-1"));
    controller.handleAgentEvent(warningEvent([makeDiagnostic()], "new-session-2"));

    expect(messages().filter((m) => m.role === "system" && m.content.includes("skipped")).length).toBe(2);
    dispose();
  }));

  test("message and target Engine changes are part of the diagnostic fingerprint", () => createRoot((dispose) => {
    const { controller, messages } = harness();
    const diagnostic = makeDiagnostic();

    controller.handleAgentEvent(warningEvent([diagnostic]));
    controller.handleAgentEvent(warningEvent([{ ...diagnostic, message: "A different read failure." }]));
    controller.handleAgentEvent(warningEvent([{ ...diagnostic, engine: "etl" }]));

    expect(messages().filter((m) => m.role === "system" && m.content.includes("skipped")).length).toBe(3);
    dispose();
  }));
});
