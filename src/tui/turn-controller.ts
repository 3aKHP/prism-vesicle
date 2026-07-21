import { runPrompt } from "../core/agent-loop/run";
import { AgentDeliveryDeferred } from "../core/agents/scheduler";
import type { AgentInboxEntry } from "../core/agents/types";
import { loadSessionSnapshot } from "../core/session/store";
import { listRewindPoints, rewindConversation } from "../core/rewind/service";
import type { VesicleImageAttachment, VesicleMessage } from "../providers/shared/types";
import type { ComposerElement } from "./composer";
import { sameInboxIds } from "./agent-delivery";
import { setAgentDeliveryState } from "./agent-view";
import { combineIndependentUsage } from "./telemetry";
import { createTurnResultController } from "./turn-result-controller";
import { createDecisionContinuations } from "./decision-continuations";
import { displayTranscriptFromSnapshot, vesicleMessagesFromResumed } from "./session-presenter";
import { executeQueuedCommands } from "./command-scheduler";

export type { TurnControllerOptions } from "./turn-controller-options";
import type { TurnControllerOptions } from "./turn-controller-options";
export function createTurnController(options: TurnControllerOptions) {
  let activeTurnSawResponse = false;
  const { handleResult } = createTurnResultController(options);
  const decisionContinuations = createDecisionContinuations({
    ...options,
    handleResult,
    handleInterruptedTurn,
    permissionContext,
    reportError,
    takePendingUserInputs,
    runToolBoundaryCommands,
  });

  function markTurnSawResponse(): void {
    activeTurnSawResponse = true;
  }

  async function submitPrompt(
    value: string,
    images: VesicleImageAttachment[] = [],
    elements: ComposerElement[] = [],
  ): Promise<void> {
    const prompt = value.trim();
    if (!prompt || options.busy()) return;
    if (prompt.startsWith("/") && images.length === 0) {
      try {
        await options.executeLocalCommand(prompt);
      } catch (error) {
        reportError(error);
      }
      return;
    }
    if (!await ensureRuntimeReady()) return;
    // Keep the turn boundary safe for non-composer callers and capabilities
    // that become available only after provider configuration loads.
    if (images.length > 0 && options.activeModelCapabilities()?.vision !== true) {
      options.applyComposerState({ value, cursor: value.length, elements: elements.map((element) => ({ ...element })) });
      options.setInputImages(images.map((image) => ({ ...image })));
      options.setStatus("current model does not declare vision support; draft restored");
      return;
    }
    await runUserPrompt(prompt, value, images, elements);
  }

  async function ensureRuntimeReady(): Promise<boolean> {
    if (!options.providerConfigReady()) {
      options.setStatus("loading provider config");
      try {
        await options.loadProviderConfig();
      } catch (error) {
        options.setProviderConfigReady(true);
        reportError(error);
        return false;
      }
    }
    if (!options.permissionSettingsReady()) {
      options.setStatus("loading permission settings");
      try {
        await options.loadPermissionSettings();
      } catch (error) {
        reportError(error);
        return false;
      }
    }
    return true;
  }

  async function runUserPrompt(
    prompt: string,
    originalValue: string,
    images: VesicleImageAttachment[],
    elements: ComposerElement[],
  ): Promise<void> {
    options.recordPromptHistory(originalValue, elements, images);
    const id = options.sessionId();
    if (id) options.pausedAgentDeliveries.delete(id);
    options.setHistoryIndex(null);
    options.setSessionPicker(null);
    options.setLastDisplayedToolAssistantContent(null);
    options.setQueuedInputReady(false);
    options.setQueuedSendAfterInterrupt(false);
    options.setBusy(true);
    options.setStatus("sending request");
    options.recordActivity({ kind: "provider", text: "sending provider request" });
    const requestMessages: VesicleMessage[] = [...options.conversation(), { role: "user", content: prompt, ...(images.length ? { images } : {}) }];
    options.setMessages((previous) => [...previous, { role: "user", content: prompt, ...(images.length ? { images } : {}) }]);
    const branchParent = options.nextSessionParent();
    options.setNextSessionParent(null);
    activeTurnSawResponse = false;
    options.beginUsageTurn();
    try {
      const outcome = await options.runCancellable((signal) => runPrompt({
        input: prompt,
        engine: options.activeEngine(),
        sessionId: options.sessionId(),
        ...(branchParent ? { sessionParentUuid: branchParent.uuid } : {}),
        messages: requestMessages,
        ...(images.length ? { images } : {}),
        providerSelection: options.activeProviderSelection(),
        generation: options.activeGeneration(),
        permission: permissionContext(),
        signal,
        onEvent: options.handleAgentEvent,
        agentManager: options.agentManager(),
        permissionBroker: options.permissionBroker,
        takePendingUserInputs,
        runToolBoundaryCommands,
        onSessionReady: (sessionId, sessionPath) => {
          options.setSessionId(sessionId);
          options.setSessionPath(sessionPath);
        },
      }));
      if (outcome.kind === "interrupted") {
        if (options.queuedSendAfterInterrupt()) await reconcileInterruptedSession();
        else if (!activeTurnSawResponse) await restoreInterruptedPrompt(originalValue, images, elements);
        handleInterruptedTurn();
      } else {
        handleResult(outcome.value);
      }
    } catch (error) {
      if (!activeTurnSawResponse) await restoreInterruptedPrompt(originalValue, images, elements).catch(() => undefined);
      reportError(error);
    } finally {
      options.setBusy(false);
    }
  }

  async function deliverAgentResults(parentSessionId: string, entries: AgentInboxEntry[], packet: string): Promise<void> {
    if (options.sessionId() !== parentSessionId || options.busy() || hasPendingInteraction()) throw new AgentDeliveryDeferred();
    options.setQueuedInputReady(false);
    options.setQueuedSendAfterInterrupt(false);
    options.setBusy(true);
    try {
      beginAgentDelivery(entries);
      const requestMessages: VesicleMessage[] = [...options.conversation(), { role: "user", content: packet }];
      activeTurnSawResponse = false;
      options.beginUsageTurn();
      for (const entry of entries) if (entry.usage) options.recordIndependentAgentUsage(entry.usage);
      const inboxIds = entries.map((entry) => entry.inboxId).sort();
      const persistedDelivery = await findPersistedAgentDelivery(parentSessionId, inboxIds);
      const childUsage = combineIndependentUsage(entries.map((entry) => entry.usage));
      const outcome = await options.runCancellable((signal) => runPrompt({
        input: packet,
        engine: options.activeEngine(),
        sessionId: parentSessionId,
        messages: requestMessages,
        inputMetadata: { kind: "subagent-results", inboxIds, ...(childUsage ? { usage: childUsage } : {}) },
        ...(persistedDelivery ? { prePersistedInputUuid: persistedDelivery.uuid } : {}),
        providerSelection: options.activeProviderSelection(),
        generation: options.activeGeneration(),
        permission: permissionContext(),
        signal,
        onEvent: options.handleAgentEvent,
        agentManager: options.agentManager(),
        permissionBroker: options.permissionBroker,
        takePendingUserInputs,
        runToolBoundaryCommands,
      }));
      if (outcome.kind === "interrupted") {
        if (options.queuedSendAfterInterrupt()) await reconcileInterruptedSession();
        handleInterruptedTurn();
        throw new AgentDeliveryDeferred();
      }
      handleResult(outcome.value);
      options.setAgentCards((cards) => setAgentDeliveryState(cards, entries.map((entry) => entry.runId), "integrated", "result integrated"));
    } catch (error) {
      options.setAgentCards((cards) => setAgentDeliveryState(cards, entries.map((entry) => entry.runId), "pending", "integration paused; use /agents retry or send input"));
      options.pausedAgentDeliveries.add(parentSessionId);
      throw error;
    } finally {
      options.setBusy(false);
    }
  }

  function beginAgentDelivery(entries: AgentInboxEntry[]): void {
    options.setAgentCards((cards) => setAgentDeliveryState(cards, entries.map((entry) => entry.runId), "integrating", "integrating result into parent"));
    options.setStatus(`integrating ${entries.length} SubAgent result${entries.length === 1 ? "" : "s"}`);
    options.recordActivity({ kind: "agent", text: `delivering ${entries.length} background result${entries.length === 1 ? "" : "s"}` });
    options.setMessages((current) => [...current, {
      role: "system",
      content: `Background SubAgent${entries.length === 1 ? "" : "s"} completed: ${entries.map((entry) => `${entry.description} (${entry.status})`).join(", ")}.`,
    }]);
  }

  async function findPersistedAgentDelivery(parentSessionId: string, inboxIds: string[]) {
    const snapshot = await loadSessionSnapshot(options.rootDir, parentSessionId, { synthesizeDanglingToolResults: false });
    return snapshot.records.find((record) => record.role === "user"
      && record.metadata?.kind === "subagent-results"
      && sameInboxIds(record.metadata?.inboxIds, inboxIds));
  }

  function reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    options.setStatus("error");
    options.setOutput(message);
    options.setStreamingAssistant("");
    options.setStreamingReasoning("");
    options.setQueuedInputReady(false);
    options.recordActivity({ kind: "system", text: `error: ${message}` });
    options.setMessages((previous) => [...previous, { role: "assistant", content: `Error: ${message}` }]);
  }

  function handleInterruptedTurn(): void {
    options.setStatus("Interrupted");
    options.setStreamingAssistant("");
    options.setStreamingReasoning("");
    options.setLastDisplayedToolAssistantContent(null);
    options.setQueuedInputReady(options.queuedSendAfterInterrupt());
    options.setQueuedSendAfterInterrupt(false);
    options.recordActivity({ kind: "system", text: "request interrupted" });
  }

  async function restoreInterruptedPrompt(
    prompt: string,
    images: VesicleImageAttachment[] = [],
    elements: ComposerElement[] = [],
  ): Promise<void> {
    const id = options.sessionId();
    if (!id) return;
    const points = await listRewindPoints(options.rootDir, id);
    const point = [...points].reverse().find((entry) => entry.content.trim() === prompt.trim());
    if (!point) return;
    await options.applyConversationRewind(await rewindConversation(options.rootDir, id, point));
    options.setPromptHistory((previous) => previous.at(-1)?.value === prompt ? previous.slice(0, -1) : previous);
    if (options.composerValue().length === 0) {
      options.applyComposerState({ value: prompt, cursor: prompt.length, elements: elements.map((element) => ({ ...element })) });
      options.setInputImages(images.map((image) => ({ ...image })));
    }
  }

  async function reconcileInterruptedSession(): Promise<void> {
    const id = options.sessionId();
    if (!id) return;
    const snapshot = await loadSessionSnapshot(options.rootDir, id, { synthesizeDanglingToolResults: true });
    options.setConversation(vesicleMessagesFromResumed(snapshot.messages));
    options.setMessages(displayTranscriptFromSnapshot(snapshot.messages, options.agentCards()));
  }

  function permissionContext() {
    return {
      mode: options.permissionMode(),
      ...(options.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true as const } : {}),
      shellExecEnabled: options.shellExecEnabled(),
      shellInterpreter: options.shellInterpreter(),
    };
  }

  function takePendingUserInputs() {
    const queued = options.takeQueuedMessages();
    if (queued.length === 0) return [];
    for (const message of queued) {
      options.recordPromptHistory(message.value, message.elements, message.images);
    }
    options.setMessages((previous) => [
      ...previous,
      ...queued.map((message) => ({
        role: "user" as const,
        content: message.value.trim(),
        ...(message.images.length ? { images: message.images } : {}),
      })),
    ]);
    options.setStatus(`sending ${queued.length} queued message${queued.length === 1 ? "" : "s"}`);
    options.recordActivity({ kind: "provider", text: `injecting ${queued.length} queued user message${queued.length === 1 ? "" : "s"}` });
    return queued.map((message) => ({
      content: message.value,
      ...(message.images.length ? { images: message.images } : {}),
    }));
  }

  async function runToolBoundaryCommands(): Promise<void> {
    await executeQueuedCommands(options.takeToolBoundaryCommands(), {
      beforeExecute: (command) => options.setStatus(`running queued command /${command.commandName}`),
      execute: options.executeLocalCommand,
      restoreNext: options.restoreNextQueuedInput,
      reportError,
    });
  }

  function hasPendingInteraction(): boolean {
    return Boolean(options.pendingGate() || options.pendingEngineSwitch() || options.pendingUserQuestion() || options.pendingPermission() || options.pendingQualityDecision() || options.pendingChildPermission());
  }

  return {
    ...decisionContinuations,
    deliverAgentResults,
    markTurnSawResponse,
    reportError,
    submitPrompt,
  };
}
