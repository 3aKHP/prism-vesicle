import { runPrompt } from "../core/agent-loop/run";
import { AgentDeliveryDeferred } from "../core/agents/scheduler";
import type { AgentInboxEntry } from "../core/agents/types";
import { createSessionStore, loadSessionSnapshot, FAILED_TURN_KIND } from "../core/session/store";
import { listRewindPoints, rewindConversation } from "../core/rewind/service";
import type { VesicleImageAttachment, VesicleMessage } from "../providers/shared/types";
import type { ComposerElement } from "./composer";
import { sameInboxIds } from "./agent-delivery";
import { setAgentDeliveryState } from "./agent-view";
import { combineIndependentUsage } from "./telemetry";
import { createTurnResultController } from "./turn-result-controller";
import { createDecisionContinuations } from "./decision-continuations";
import { ProviderError, cleanProviderMessage, providerFailureCategoryLabel, summarizeProviderFailure } from "../providers/shared/errors";

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
    options.queuedWork.prepareTurn();
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
        onProviderContextSnapshot: options.onProviderContextSnapshot,
        agentManager: options.agentManager(),
        permissionBroker: options.permissionBroker,
        takePendingUserInputs: options.queuedWork.takePendingUserInputs,
        runToolBoundaryCommands: options.queuedWork.runToolBoundaryCommands,
        onSessionReady: (sessionId, sessionPath) => {
          options.setSessionId(sessionId);
          options.setSessionPath(sessionPath);
        },
      }));
      if (outcome.kind === "interrupted") {
        const queuedInterruption = await options.queuedWork.handleInterruption(options.sessionId());
        if (!queuedInterruption && !activeTurnSawResponse) await restoreInterruptedPrompt(originalValue, images, elements);
        handleInterruptedTurn();
      } else {
        handleResult(outcome.value);
      }
    } catch (error) {
      // A retryable provider failure leaves the user message in the transcript
      // (issue #98) but restores the composer draft + images so the "resend"
      // hint is actionable. Terminal failures keep the message in place; the
      // user starts the next turn fresh.
      if (error instanceof ProviderError && summarizeProviderFailure(error).retryable) {
        options.applyComposerState({ value: originalValue, cursor: originalValue.length, elements: elements.map((element) => ({ ...element })) });
        if (images.length) options.setInputImages(images.map((image) => ({ ...image })));
      }
      // Mark the failed turn so a resume or resend never re-sends the dangling
      // user prompt as a consecutive same-role message (#102). Best-effort: a
      // marking failure must not mask the original error. Read the session id
      // fresh: a new session is only assigned during runPrompt (onSessionReady),
      // so the `id` captured at the top of this function is still undefined for
      // a first-turn failure on a new session.
      const currentSessionId = options.sessionId();
      if (currentSessionId) await markFailedUserTurn(currentSessionId);
      reportError(error);
    } finally {
      options.setBusy(false);
    }
  }

  async function deliverAgentResults(parentSessionId: string, entries: AgentInboxEntry[], packet: string): Promise<void> {
    if (options.sessionId() !== parentSessionId || options.busy() || hasPendingInteraction()) throw new AgentDeliveryDeferred();
    options.queuedWork.prepareTurn();
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
        onProviderContextSnapshot: options.onProviderContextSnapshot,
        agentManager: options.agentManager(),
        permissionBroker: options.permissionBroker,
        takePendingUserInputs: options.queuedWork.takePendingUserInputs,
        runToolBoundaryCommands: options.queuedWork.runToolBoundaryCommands,
      }));
      if (outcome.kind === "interrupted") {
        await options.queuedWork.handleInterruption(parentSessionId);
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
    options.setStreamingAssistant("");
    options.setStreamingReasoning("");
    options.queuedWork.block();
    if (!(error instanceof ProviderError)) {
      const message = cleanProviderMessage(error instanceof Error ? error.message : String(error));
      options.setStatus("error");
      options.recordActivity({ kind: "system", text: `error: ${message}` });
      options.setMessages((previous) => [...previous, { role: "system", kind: "host-error", content: message }]);
      return;
    }
    const failure = summarizeProviderFailure(error);
    const title = providerFailureCategoryLabel(failure.category).title;
    const statusParts = ["error"];
    if (failure.providerId) statusParts.push(failure.providerId);
    if (failure.status !== undefined) statusParts.push(String(failure.status));
    statusParts.push(title);
    options.setStatus(statusParts.join(" · "));
    options.recordActivity({ kind: "system", text: `error: ${title}: ${failure.message}` });
    options.setMessages((previous) => [...previous, {
      role: "system",
      kind: "provider-failure",
      content: failure.message,
      failure: {
        category: failure.category,
        ...(failure.status !== undefined ? { status: failure.status } : {}),
        ...(failure.providerId ? { providerId: failure.providerId } : {}),
        retryable: failure.retryable,
      },
    }]);
  }

  function handleInterruptedTurn(): void {
    options.setStatus("Interrupted");
    options.setStreamingAssistant("");
    options.setStreamingReasoning("");
    options.setLastDisplayedToolAssistantContent(null);
    options.recordActivity({ kind: "system", text: "request interrupted" });
  }

  /**
   * Append a host-only `failed-turn` marker when a fresh user turn ends without
   * an assistant reply. `projectSessionHistory` reads the marker to drop the
   * failed prompt from provider-visible history, so resuming or resending does
   * not produce consecutive same-role user messages. Only marks when the
   * trailing session record is a user (the first provider round failed before
   * any assistant/tool reply); a mid-loop failure already leaves a valid
   * alternation tail and is left alone.
   */
  async function markFailedUserTurn(sessionId: string): Promise<void> {
    try {
      const snapshot = await loadSessionSnapshot(options.rootDir, sessionId, { synthesizeDanglingToolResults: false });
      if (snapshot.records.at(-1)?.role !== "user") return;
      const store = await createSessionStore(options.rootDir, sessionId);
      await store.append({ role: "system", content: "", metadata: { kind: FAILED_TURN_KIND } });
    } catch {
      // Best-effort: never mask the original turn error.
    }
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

  function permissionContext() {
    return {
      mode: options.permissionMode(),
      ...(options.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true as const } : {}),
      shellExecEnabled: options.shellExecEnabled(),
      shellInterpreter: options.shellInterpreter(),
    };
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
