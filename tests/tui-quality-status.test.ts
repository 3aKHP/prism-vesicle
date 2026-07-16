import { createRoot, createSignal } from "solid-js";
import { describe, expect, test } from "bun:test";
import { createAgentProcessController } from "../src/tui/agent-process-controller";
import type { ActivityEntry, AgentCardState, Message } from "../src/tui/types";
import type { BackgroundProcessState } from "../src/core/process/manager";

describe("TUI quality status", () => {
  test("keeps observed style evidence visible without authorship claims", () => createRoot((dispose) => {
    const harness = controllerHarness();
    harness.controller.handleAgentEvent({
      type: "quality_status",
      phase: "observed",
      attempt: 0,
      findingCount: 1,
      findings: [{
        ruleId: "zh-f1-pov-leak",
        title: "POV leak",
        severity: "tier2",
        maturity: "stable",
        evidence: "她不知道",
        source: "judge",
        confidence: 0.95,
        targetPath: "workspace/scene.md",
      }],
      warningReasons: [],
    });
    expect(harness.status()).toBe("observed style issues · 1 finding");
    expect(harness.messages().at(-1)?.content).toContain("POV leak (workspace/scene.md): “她不知道”");
    expect(harness.messages().at(-1)?.content).not.toMatch(/written by AI|authorship/i);
    dispose();
  }));

  test("keeps inconclusive reasons visible", () => createRoot((dispose) => {
    const harness = controllerHarness();
    harness.controller.handleAgentEvent({
      type: "quality_status",
      phase: "inconclusive",
      attempt: 0,
      findingCount: 0,
      findings: [],
      warningReasons: ["judge-timeout"],
    });
    expect(harness.status()).toContain("style quality check incomplete");
    expect(harness.messages().at(-1)?.content).toContain("style review timed out");
    expect(harness.messages().at(-1)?.content).toContain("current version is unconfirmed");
    dispose();
  }));
});

function controllerHarness() {
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [activity, setActivity] = createSignal<ActivityEntry[]>([]);
  const [status, setStatus] = createSignal("");
  const [background, setBackground] = createSignal<BackgroundProcessState[]>([]);
  const [cards, setCards] = createSignal<AgentCardState[]>([]);
  const [streamingAssistant, setStreamingAssistant] = createSignal("");
  const [streamingReasoning, setStreamingReasoning] = createSignal("");
  const [lastToolContent, setLastToolContent] = createSignal<string | null>(null);
  const controller = createAgentProcessController({
    sessionId: () => undefined,
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
  return {
    controller,
    messages,
    activity,
    status,
    background,
    cards,
    streamingAssistant,
    streamingReasoning,
    lastToolContent,
  };
}
