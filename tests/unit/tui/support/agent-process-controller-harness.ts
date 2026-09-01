import { createSignal } from "solid-js";
import { createAgentProcessController } from "../../../../src/tui/agent-process-controller";
import type { ActivityEntry, AgentCardState, Message } from "../../../../src/tui/types";
import type { BackgroundProcessState } from "../../../../src/core/process/manager";

/**
 * Shared signal-backed harness for agent-process-controller notice tests
 * (instruction_warning, project_roots_warning, …). Wrap calls in createRoot —
 * controller reads track signals only inside a reactive owner.
 */
export function agentProcessControllerHarness(sessionId = "session-1") {
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
