import { createSignal } from "solid-js";
import { regenerateTurn as coreRegenerateTurn } from "../core/agent-loop/run";
import { runPrompt } from "../core/agent-loop/run";
import { switchCandidateFileState, type CandidateFileStateOutcome } from "../core/checkpoints/candidate-files";
import { AutoCompactBlockedError } from "../core/compact/auto-compact";
import { AgentDeliveryDeferred } from "../core/agents/scheduler";
import type { AgentInboxEntry } from "../core/agents/types";
import { createSessionStore, loadSessionRecords, loadSessionSnapshot, FAILED_TURN_KIND } from "../core/session/store";
import { appendCandidateSelection, contentLeafAtOrAbove, enumerateCandidateLeaves, findLatestSelection, ownerForkOfLeaf } from "../core/session/selection";
import { listRewindPoints, rewindConversation } from "../core/rewind/service";
import type { VesicleImageAttachment, VesicleMessage } from "../providers/shared/types";
import type { ComposerElement } from "./composer";
import { sameInboxIds } from "./agent-delivery";
import { setAgentDeliveryState } from "./agent-view";
import { combineIndependentUsage } from "./telemetry";
import { createTurnResultController } from "./turn-result-controller";
import { createDecisionContinuations } from "./decision-continuations";
import { ProviderError, cleanProviderMessage, providerFailureCategoryLabel, summarizeProviderFailure } from "../providers/shared/errors";
import { displayTranscriptFromSnapshot, vesicleMessagesFromResumed } from "./session-presenter";

type CandidateSwitcherState = {
  /** The shared user record the current turn's candidates hang off. */
  forkPointUuid: string;
  /** Content-leaf uuids of each candidate, ordered oldest-first. */
  leaves: string[];
  /** Index of the active candidate within `leaves`. */
  index: number;
  total: number;
};

export type { TurnControllerOptions, TurnRuntimePort, TurnSessionPort, TurnTranscriptPort, TurnDecisionPort, TurnAgentPort, TurnUsagePort, TurnComposerPort, TurnHostActionPort } from "./turn-controller-options";
import type { TurnAgentPort, TurnComposerPort, TurnDecisionPort, TurnHostActionPort, TurnRuntimePort, TurnSessionPort, TurnTranscriptPort, TurnUsagePort, TurnControllerOptions } from "./turn-controller-options";
export function createTurnController(options: TurnControllerOptions) {
  let activeTurnSawResponse = false;
  // Synchronous latch for candidate actions (regenerate/switch): both await
  // JSONL reads before runtime.setBusy lands, so a key-repeat inside that
  // window could otherwise run two file-restoring actions concurrently.
  let candidateActionInFlight = false;
  const [candidateSwitcher, setCandidateSwitcher] = createSignal<CandidateSwitcherState | null>(null);

  // Named turn-domain ports (plan §4.3): the composition root hands each
  // downstream owner only the ports — and only the port slices — it consumes.
  const runtime: TurnRuntimePort = {
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
    permissionMode: options.permissionMode,
    shellExecEnabled: options.shellExecEnabled,
    shellInterpreter: options.shellInterpreter,
    providerConfigReady: options.providerConfigReady,
    setProviderConfigReady: options.setProviderConfigReady,
    loadProviderConfig: options.loadProviderConfig,
    permissionSettingsReady: options.permissionSettingsReady,
    loadPermissionSettings: options.loadPermissionSettings,
    activeModelCapabilities: options.activeModelCapabilities,
    activeEngine: options.activeEngine,
    setActiveEngine: options.setActiveEngine,
    activeModel: options.activeModel,
    activeProviderSelection: options.activeProviderSelection,
    activeGeneration: options.activeGeneration,
    permissionBroker: options.permissionBroker,
    busy: options.busy,
    setBusy: options.setBusy,
  };
  const session: TurnSessionPort = {
    rootDir: options.rootDir,
    sessionId: options.sessionId,
    setSessionId: options.setSessionId,
    setSessionPath: options.setSessionPath,
    conversation: options.conversation,
    setConversation: options.setConversation,
    nextSessionParent: options.nextSessionParent,
    setNextSessionParent: options.setNextSessionParent,
    setSessionPicker: options.setSessionPicker,
  };
  const transcript: TurnTranscriptPort = {
    setMessages: options.setMessages,
    setStatus: options.setStatus,
    setOutput: options.setOutput,
    setStreamingAssistant: options.setStreamingAssistant,
    setStreamingReasoning: options.setStreamingReasoning,
    lastDisplayedToolAssistantContent: options.lastDisplayedToolAssistantContent,
    setLastDisplayedToolAssistantContent: options.setLastDisplayedToolAssistantContent,
    recordActivity: options.recordActivity,
  };
  const decision: TurnDecisionPort = {
    pendingGate: options.pendingGate,
    setPendingGate: options.setPendingGate,
    pendingEngineSwitch: options.pendingEngineSwitch,
    setPendingEngineSwitch: options.setPendingEngineSwitch,
    pendingUserQuestion: options.pendingUserQuestion,
    setPendingUserQuestion: options.setPendingUserQuestion,
    pendingPermission: options.pendingPermission,
    setPendingPermission: options.setPendingPermission,
    pendingQualityDecision: options.pendingQualityDecision,
    setPendingQualityDecision: options.setPendingQualityDecision,
    pendingChildPermission: options.pendingChildPermission,
    questionSelected: options.questionSelected,
    setQuestionSelected: options.setQuestionSelected,
    setQualitySelected: options.setQualitySelected,
    questionFreeformText: options.questionFreeformText,
    clearQuestionFreeform: options.clearQuestionFreeform,
    setGateFocus: options.setGateFocus,
    setGateFeedbackMode: options.setGateFeedbackMode,
    clearGateFeedback: options.clearGateFeedback,
  };
  const agent: TurnAgentPort = {
    agentCards: options.agentCards,
    setAgentCards: options.setAgentCards,
    pausedAgentDeliveries: options.pausedAgentDeliveries,
    agentManager: options.agentManager,
    handleAgentEvent: options.handleAgentEvent,
    onProviderContextSnapshot: options.onProviderContextSnapshot,
  };
  const usage: TurnUsagePort = {
    beginUsageTurn: options.beginUsageTurn,
    publishTurnUsage: options.publishTurnUsage,
    recordIndependentAgentUsage: options.recordIndependentAgentUsage,
  };
  const composer: TurnComposerPort = {
    recordPromptHistory: options.recordPromptHistory,
    applyComposerState: options.applyComposerState,
    composerValue: options.composerValue,
    setInputImages: options.setInputImages,
    setHistoryIndex: options.setHistoryIndex,
    setPromptHistory: options.setPromptHistory,
    applyConversationRewind: options.applyConversationRewind,
  };
  const hostAction: TurnHostActionPort = {
    refreshArtifacts: options.refreshArtifacts,
    refreshQualityWarnings: options.refreshQualityWarnings,
    resumeQualitySession: options.resumeQualitySession,
    compactSession: options.compactSession,
    executeLocalCommand: options.executeLocalCommand,
  };

  const { handleResult } = createTurnResultController({ runtime, session, transcript, decision, usage, hostAction, queuedWork: options.queuedWork });
  const decisionContinuations = createDecisionContinuations({
    runtime,
    session,
    transcript,
    decision,
    agent,
    usage,
    hostAction,
    queuedWork: options.queuedWork,
    runCancellable: options.runCancellable,
    handleResult,
    handleInterruptedTurn,
    reportError,
    permissionContext,
    refreshCandidateSwitcher,
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
    if (!prompt || runtime.busy()) return;
    if (prompt.startsWith("/") && images.length === 0) {
      try {
        await hostAction.executeLocalCommand(prompt);
      } catch (error) {
        reportError(error);
      }
      return;
    }
    if (!await ensureRuntimeReady()) return;
    // Keep the turn boundary safe for non-composer callers and capabilities
    // that become available only after provider configuration loads.
    if (images.length > 0 && runtime.activeModelCapabilities()?.vision !== true) {
      composer.applyComposerState({ value, cursor: value.length, elements: elements.map((element) => ({ ...element })) });
      composer.setInputImages(images.map((image) => ({ ...image })));
      transcript.setStatus("current model does not declare vision support; draft restored");
      return;
    }
    await runUserPrompt(prompt, value, images, elements);
  }

  async function ensureRuntimeReady(): Promise<boolean> {
    if (!runtime.providerConfigReady()) {
      transcript.setStatus("loading provider config");
      try {
        await runtime.loadProviderConfig();
      } catch (error) {
        runtime.setProviderConfigReady(true);
        reportError(error);
        return false;
      }
    }
    if (!runtime.permissionSettingsReady()) {
      transcript.setStatus("loading permission settings");
      try {
        await runtime.loadPermissionSettings();
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
    composer.recordPromptHistory(originalValue, elements, images);
    setCandidateSwitcher(null);
    const id = session.sessionId();
    if (id) agent.pausedAgentDeliveries.delete(id);
    composer.setHistoryIndex(null);
    session.setSessionPicker(null);
    transcript.setLastDisplayedToolAssistantContent(null);
    options.queuedWork.prepareTurn();
    runtime.setBusy(true);
    transcript.setStatus("sending request");
    transcript.recordActivity({ kind: "provider", text: "sending provider request" });
    const requestMessages: VesicleMessage[] = [...session.conversation(), { role: "user", content: prompt, ...(images.length ? { images } : {}) }];
    transcript.setMessages((previous) => [...previous, { role: "user", content: prompt, ...(images.length ? { images } : {}) }]);
    const branchParent = session.nextSessionParent();
    session.setNextSessionParent(null);
    activeTurnSawResponse = false;
    usage.beginUsageTurn();
    try {
      const outcome = await options.runCancellable((signal) => runPrompt({
        input: prompt,
        engine: runtime.activeEngine(),
        sessionId: session.sessionId(),
        ...(branchParent ? { sessionParentUuid: branchParent.uuid } : {}),
        messages: requestMessages,
        ...(images.length ? { images } : {}),
        providerSelection: runtime.activeProviderSelection(),
        generation: runtime.activeGeneration(),
        permission: permissionContext(),
        signal,
        onEvent: agent.handleAgentEvent,
        onProviderContextSnapshot: agent.onProviderContextSnapshot,
        onSessionTitleChanged: options.onSessionTitleChanged,
        agentManager: agent.agentManager(),
        permissionBroker: runtime.permissionBroker,
        takePendingUserInputs: options.queuedWork.takePendingUserInputs,
        runToolBoundaryCommands: options.queuedWork.runToolBoundaryCommands,
        onSessionReady: (sessionId, sessionPath) => {
          session.setSessionId(sessionId);
          session.setSessionPath(sessionPath);
        },
      }));
      if (outcome.kind === "interrupted") {
        const queuedInterruption = await options.queuedWork.handleInterruption(session.sessionId());
        if (!queuedInterruption && !activeTurnSawResponse) await restoreInterruptedPrompt(originalValue, images, elements);
        handleInterruptedTurn();
      } else {
        handleResult(outcome.value);
      }
    } catch (error) {
      // A hard-ceiling auto-compaction block is raised before the new user
      // record is persisted, so the session is not mutated. Restore the draft so
      // the user can retry, manually compact, or switch model, and drop the
      // trailing UI user message that was optimistically added before the send
      // (it was never persisted, so it must not linger as a ghost turn).
      if (error instanceof AutoCompactBlockedError) {
        if (!error.inputPersisted) {
          composer.applyComposerState({ value: originalValue, cursor: originalValue.length, elements: elements.map((element) => ({ ...element })) });
          if (images.length) composer.setInputImages(images.map((image) => ({ ...image })));
          transcript.setMessages((previous) => (previous.length > 0 && previous[previous.length - 1]!.role === "user" ? previous.slice(0, -1) : previous));
        }
        reportError(error);
        return;
      }
      // A retryable provider failure leaves the user message in the transcript
      // (issue #98) but restores the composer draft + images so the "resend"
      // hint is actionable. Terminal failures keep the message in place; the
      // user starts the next turn fresh.
      if (error instanceof ProviderError && summarizeProviderFailure(error).retryable) {
        composer.applyComposerState({ value: originalValue, cursor: originalValue.length, elements: elements.map((element) => ({ ...element })) });
        if (images.length) composer.setInputImages(images.map((image) => ({ ...image })));
      }
      // Mark the failed turn so a resume or resend never re-sends the dangling
      // user prompt as a consecutive same-role message (#102). Best-effort: a
      // marking failure must not mask the original error. Read the session id
      // fresh: a new session is only assigned during runPrompt (onSessionReady),
      // so the `id` captured at the top of this function is still undefined for
      // a first-turn failure on a new session.
      const currentSessionId = session.sessionId();
      if (currentSessionId) {
        await markFailedUserTurn(currentSessionId);
        await refreshConversationFromSession(currentSessionId);
      }
      reportError(error);
    } finally {
      runtime.setBusy(false);
    }
  }

  async function deliverAgentResults(parentSessionId: string, entries: AgentInboxEntry[], packet: string): Promise<void> {
    if (session.sessionId() !== parentSessionId || runtime.busy() || hasPendingInteraction()) throw new AgentDeliveryDeferred();
    options.queuedWork.prepareTurn();
    runtime.setBusy(true);
    try {
      beginAgentDelivery(entries);
      const requestMessages: VesicleMessage[] = [...session.conversation(), { role: "user", content: packet }];
      activeTurnSawResponse = false;
      usage.beginUsageTurn();
      for (const entry of entries) if (entry.usage) usage.recordIndependentAgentUsage(entry.usage);
      const inboxIds = entries.map((entry) => entry.inboxId).sort();
      const persistedDelivery = await findPersistedAgentDelivery(parentSessionId, inboxIds);
      const childUsage = combineIndependentUsage(entries.map((entry) => entry.usage));
      const outcome = await options.runCancellable((signal) => runPrompt({
        input: packet,
        engine: runtime.activeEngine(),
        sessionId: parentSessionId,
        messages: requestMessages,
        inputMetadata: { kind: "subagent-results", inboxIds, ...(childUsage ? { usage: childUsage } : {}) },
        ...(persistedDelivery ? { prePersistedInputUuid: persistedDelivery.uuid } : {}),
        providerSelection: runtime.activeProviderSelection(),
        generation: runtime.activeGeneration(),
        permission: permissionContext(),
        signal,
        onEvent: agent.handleAgentEvent,
        onProviderContextSnapshot: agent.onProviderContextSnapshot,
        onSessionTitleChanged: options.onSessionTitleChanged,
        agentManager: agent.agentManager(),
        permissionBroker: runtime.permissionBroker,
        takePendingUserInputs: options.queuedWork.takePendingUserInputs,
        runToolBoundaryCommands: options.queuedWork.runToolBoundaryCommands,
      }));
      if (outcome.kind === "interrupted") {
        await options.queuedWork.handleInterruption(parentSessionId);
        handleInterruptedTurn();
        throw new AgentDeliveryDeferred();
      }
      handleResult(outcome.value);
      agent.setAgentCards((cards) => setAgentDeliveryState(cards, entries.map((entry) => entry.runId), "integrated", "result integrated"));
    } catch (error) {
      agent.setAgentCards((cards) => setAgentDeliveryState(cards, entries.map((entry) => entry.runId), "pending", "integration paused; use /agents retry or send input"));
      agent.pausedAgentDeliveries.add(parentSessionId);
      throw error;
    } finally {
      runtime.setBusy(false);
    }
  }

  function beginAgentDelivery(entries: AgentInboxEntry[]): void {
    agent.setAgentCards((cards) => setAgentDeliveryState(cards, entries.map((entry) => entry.runId), "integrating", "integrating result into parent"));
    transcript.setStatus(`integrating ${entries.length} SubAgent result${entries.length === 1 ? "" : "s"}`);
    transcript.recordActivity({ kind: "agent", text: `delivering ${entries.length} background result${entries.length === 1 ? "" : "s"}` });
    transcript.setMessages((current) => [...current, {
      role: "system",
      content: `Background SubAgent${entries.length === 1 ? "" : "s"} completed: ${entries.map((entry) => `${entry.description} (${entry.status})`).join(", ")}.`,
    }]);
  }

  async function findPersistedAgentDelivery(parentSessionId: string, inboxIds: string[]) {
    const snapshot = await loadSessionSnapshot(session.rootDir, parentSessionId, { synthesizeDanglingToolResults: false });
    return snapshot.records.find((record) => record.role === "user"
      && record.metadata?.kind === "subagent-results"
      && sameInboxIds(record.metadata?.inboxIds, inboxIds));
  }

  function reportError(error: unknown): void {
    transcript.setStreamingAssistant("");
    transcript.setStreamingReasoning("");
    options.queuedWork.block();
    if (!(error instanceof ProviderError)) {
      const message = cleanProviderMessage(error instanceof Error ? error.message : String(error));
      transcript.setStatus("error");
      transcript.recordActivity({ kind: "system", text: `error: ${message}` });
      transcript.setMessages((previous) => [...previous, { role: "system", kind: "host-error", content: message }]);
      return;
    }
    const failure = summarizeProviderFailure(error);
    const title = providerFailureCategoryLabel(failure.category).title;
    const statusParts = ["error"];
    if (failure.providerId) statusParts.push(failure.providerId);
    if (failure.status !== undefined) statusParts.push(String(failure.status));
    statusParts.push(title);
    transcript.setStatus(statusParts.join(" · "));
    transcript.recordActivity({ kind: "system", text: `error: ${title}: ${failure.message}` });
    transcript.setMessages((previous) => [...previous, {
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
    transcript.setStatus("Interrupted");
    transcript.setStreamingAssistant("");
    transcript.setStreamingReasoning("");
    transcript.setLastDisplayedToolAssistantContent(null);
    transcript.recordActivity({ kind: "system", text: "request interrupted" });
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
      const snapshot = await loadSessionSnapshot(session.rootDir, sessionId, { synthesizeDanglingToolResults: false });
      if (snapshot.records.at(-1)?.role !== "user") return;
      const store = await createSessionStore(session.rootDir, sessionId);
      await store.append({ role: "system", content: "", metadata: { kind: FAILED_TURN_KIND } });
    } catch {
      // Best-effort: never mask the original turn error.
    }
  }

  async function refreshConversationFromSession(sessionId: string): Promise<void> {
    try {
      const snapshot = await loadSessionSnapshot(session.rootDir, sessionId, { synthesizeDanglingToolResults: true });
      session.setConversation(vesicleMessagesFromResumed(snapshot.messages));
    } catch {
      // Best-effort: preserve the original error when durable reload also fails.
    }
  }

  async function restoreInterruptedPrompt(
    prompt: string,
    images: VesicleImageAttachment[] = [],
    elements: ComposerElement[] = [],
  ): Promise<void> {
    const id = session.sessionId();
    if (!id) return;
    const points = await listRewindPoints(session.rootDir, id);
    const point = [...points].reverse().find((entry) => entry.content.trim() === prompt.trim());
    if (!point) return;
    await composer.applyConversationRewind(await rewindConversation(session.rootDir, id, point));
    composer.setPromptHistory((previous) => previous.at(-1)?.value === prompt ? previous.slice(0, -1) : previous);
    if (composer.composerValue().length === 0) {
      composer.applyComposerState({ value: prompt, cursor: prompt.length, elements: elements.map((element) => ({ ...element })) });
      composer.setInputImages(images.map((image) => ({ ...image })));
    }
  }

  function permissionContext() {
    return {
      mode: runtime.permissionMode(),
      ...(runtime.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true as const } : {}),
      shellExecEnabled: runtime.shellExecEnabled(),
      shellInterpreter: runtime.shellInterpreter(),
    };
  }

  function hasPendingInteraction(): boolean {
    return Boolean(decision.pendingGate() || decision.pendingEngineSwitch() || decision.pendingUserQuestion() || decision.pendingPermission() || decision.pendingQualityDecision() || decision.pendingChildPermission());
  }

  /**
   * Re-run a turn as a new candidate (#88). Defaults to the last turn; the
   * candidate-tree panel passes `targetUuid` to regenerate an arbitrary turn
   * of the active branch. Forks a sibling subtree off the shared user record,
   * updates the display via the normal turn-result path, and arms the inline
   * `<n/m>` switcher. Refuses while busy, while a pending interaction is
   * unresolved, or while a background SubAgent is still running (its eventual
   * delivery could land on the wrong branch). The old candidate's post-state
   * is bundled and the disk is restored to the fork baseline before the new
   * candidate runs (per-candidate file coexistence).
   */
  async function regenerateTurn(targetUuid?: string): Promise<void> {
    const id = session.sessionId();
    if (!id) { transcript.setStatus("no session to regenerate"); return; }
    if (runtime.busy() || candidateActionInFlight) { transcript.setStatus("wait for the current turn"); return; }
    if (hasPendingInteraction()) { transcript.setStatus("resolve the pending interaction before regenerating"); return; }
    if (agent.agentCards().some((card) => card.status === "running" || card.status === "queued")) {
      transcript.setStatus("wait for active SubAgents before regenerating");
      return;
    }
    // Latch spans the awaits before runtime.setBusy lands; no await sits
    // between the release and setBusy(true), so no key-repeat can interleave.
    let target: Awaited<ReturnType<typeof listRewindPoints>>[number] | undefined;
    candidateActionInFlight = true;
    try {
      if (!await ensureRuntimeReady()) return;
      const points = await listRewindPoints(session.rootDir, id);
      target = targetUuid ? points.find((point) => point.uuid === targetUuid) : points.at(-1);
    } finally {
      candidateActionInFlight = false;
    }
    if (!target) { transcript.setStatus("no turn to regenerate"); return; }
    runtime.setBusy(true);
    transcript.setStatus("regenerating turn");
    transcript.recordActivity({ kind: "provider", text: targetUuid ? "regenerating selected turn" : "regenerating last turn" });
    // Regenerate replaces the old candidate on screen: scope the display and
    // provider-facing conversation to the fork point (the same branch core
    // regenerate runs against) so the previous reply disappears and the new
    // candidate streams in its place.
    setCandidateSwitcher(null);
    try {
      const forkSnapshot = await loadSessionSnapshot(session.rootDir, id, { headUuid: target.uuid, synthesizeDanglingToolResults: false });
      session.setConversation(vesicleMessagesFromResumed(forkSnapshot.messages));
      transcript.setMessages(displayTranscriptFromSnapshot(forkSnapshot.messages, agent.agentCards()));
      transcript.setOutput("");
    } catch (error) {
      runtime.setBusy(false);
      reportError(error);
      return;
    }
    usage.beginUsageTurn();
    try {
      const outcome = await options.runCancellable((signal) => coreRegenerateTurn({
        rootDir: session.rootDir,
        sessionId: id,
        userRecordUuid: target.uuid,
        engine: runtime.activeEngine(),
        providerSelection: runtime.activeProviderSelection(),
        generation: runtime.activeGeneration(),
        permission: permissionContext(),
        signal,
        onEvent: agent.handleAgentEvent,
        onProviderContextSnapshot: agent.onProviderContextSnapshot,
        agentManager: agent.agentManager(),
        permissionBroker: runtime.permissionBroker,
        takePendingUserInputs: options.queuedWork.takePendingUserInputs,
        runToolBoundaryCommands: options.queuedWork.runToolBoundaryCommands,
      }));
      if (outcome.kind === "interrupted") {
        await reloadActiveBranchDisplay(id);
        handleInterruptedTurn();
      } else {
        handleResult(outcome.value);
      }
      await refreshCandidateSwitcher(id);
    } catch (error) {
      // coreRegenerateTurn re-points the selection marker at the previous
      // candidate before rethrowing, so the default branch is authoritative
      // again — restore it on screen.
      await reloadActiveBranchDisplay(id);
      reportError(error);
    } finally {
      runtime.setBusy(false);
    }
  }

  async function reloadActiveBranchDisplay(sessionId: string): Promise<void> {
    try {
      const snapshot = await loadSessionSnapshot(session.rootDir, sessionId, { synthesizeDanglingToolResults: false });
      session.setConversation(vesicleMessagesFromResumed(snapshot.messages));
      transcript.setMessages(displayTranscriptFromSnapshot(snapshot.messages, agent.agentCards()));
      transcript.setOutput("");
    } catch {
      // Best-effort: keep whatever the transcript currently shows.
    }
  }

  function clearPendingInteractions(): void {
    decision.setPendingGate(null);
    decision.setPendingEngineSwitch(null);
    decision.setPendingUserQuestion(null);
    decision.setPendingPermission(null);
    decision.setPendingQualityDecision(null);
  }

  // Whether `forkPointUuid` is still the active branch's last turn. Once a later
  // user turn has been appended after a candidate marker, the fork point is
  // stale and switching would re-point the active branch backward, orphaning the
  // later turns (Bot Review blocking finding).
  async function forkPointIsLastTurn(forkPointUuid: string): Promise<boolean> {
    const points = await listRewindPoints(session.rootDir, session.sessionId() ?? "");
    return points.at(-1)?.uuid === forkPointUuid;
  }

  /**
   * Switch the active candidate of the current turn by one step (#88 horizontal
   * branch). Restores the target candidate's on-disk post-state first, then
   * appends a selection marker and reloads the selected candidate's branch into
   * both the provider context and the display transcript. Files move before the
   * marker because the restore is idempotent-convergent (retryable) while the
   * marker is a one-shot pointer flip: on restore failure the switch aborts and
   * conversation and disk still point at the same candidate. Refuses (and
   * disarms) if the conversation has moved past the fork point since the
   * switcher was armed, or while a background SubAgent is still running (its
   * writes would race the restore). Pending interactions are cleared so a
   * switched-away gate does not linger; switching to a paused candidate is a
   * known MVP limitation.
   */
  async function switchCandidate(direction: -1 | 1): Promise<void> {
    const id = session.sessionId();
    const current = candidateSwitcher();
    if (!id || !current || current.total < 2 || runtime.busy() || candidateActionInFlight) return;
    if (agent.agentCards().some((card) => card.status === "running" || card.status === "queued")) {
      transcript.setStatus("wait for active SubAgents before switching candidates");
      return;
    }
    candidateActionInFlight = true;
    try {
      // Re-verify: a turn may have landed (e.g. a background SubAgent delivery)
      // since the switcher was armed, making the fork point stale. The check
      // stats tracked paths and can throw on a hostile filesystem; report and
      // abort rather than leaving an unhandled rejection in the key handler.
      try {
        if (!await forkPointIsLastTurn(current.forkPointUuid)) {
          setCandidateSwitcher(null);
          transcript.setStatus("the conversation moved past the switched turn");
          return;
        }
      } catch (error) {
        reportError(error);
        return;
      }
      await applyCandidateSwitch(id, current, direction);
    } finally {
      candidateActionInFlight = false;
    }
  }

  async function applyCandidateSwitch(id: string, current: CandidateSwitcherState, direction: -1 | 1): Promise<void> {
    const nextIndex = (current.index + direction + current.total) % current.total;
    const nextLeaf = current.leaves[nextIndex];
    const fromLeaf = current.leaves[current.index];
    if (!nextLeaf || !fromLeaf) return;
    await applyCandidateSwitchCore({
      id,
      fromLeaf,
      toLeaf: nextLeaf,
      forkPointForFiles: current.forkPointUuid,
      statusLabel: `switching to candidate ${nextIndex + 1}/${current.total}`,
      successStatus: (fileOutcome) => {
        if (fileOutcome.tainted) return `candidate ${nextIndex + 1}/${current.total}: ran a host process; some file changes may not have switched`;
        if (!fileOutcome.restored && fileOutcome.reason === "missing") return `candidate ${nextIndex + 1}/${current.total}: no saved file state, files not switched`;
        return `candidate ${nextIndex + 1}/${current.total}`;
      },
    });
  }

  /**
   * Switch the active branch to `toLeaf` at any depth of the session tree.
   * Shares the inline-switch kernel: files move before the marker, and the
   * marker keys its fork point on the target leaf's owning turn so the inline
   * `<n/m>` switcher re-arms at the target depth. Refuses under the same
   * guards as inline switching (busy, latch, running/queued SubAgents).
   */
  async function switchToCandidate(toLeaf: string): Promise<boolean> {
    const id = session.sessionId();
    if (!id || runtime.busy() || candidateActionInFlight) return false;
    if (agent.agentCards().some((card) => card.status === "running" || card.status === "queued")) {
      transcript.setStatus("wait for active SubAgents before switching candidates");
      return false;
    }
    candidateActionInFlight = true;
    try {
      const records = await loadSessionRecords(session.rootDir, id);
      const snapshot = await loadSessionSnapshot(session.rootDir, id, { synthesizeDanglingToolResults: false });
      const tail = snapshot.records.at(-1);
      const fromLeaf = contentLeafAtOrAbove(records, tail?.uuid) ?? tail?.uuid;
      if (!fromLeaf || fromLeaf === toLeaf) return false;
      const forkForFiles = ownerForkOfLeaf(records, fromLeaf) ?? "";
      return await applyCandidateSwitchCore({
        id,
        fromLeaf,
        toLeaf,
        forkPointForFiles: forkForFiles,
        statusLabel: "switching candidate branch",
        successStatus: (fileOutcome) => {
          if (fileOutcome.tainted) return "switched: ran a host process; some file changes may not have switched";
          if (!fileOutcome.restored && fileOutcome.reason === "missing") return "switched conversation only: no saved file state for this candidate";
          return "switched candidate branch";
        },
      });
    } finally {
      candidateActionInFlight = false;
    }
  }

  /**
   * The shared candidate-switch kernel. Files move before the marker because
   * the restore is idempotent-convergent (retryable) while the marker is a
   * one-shot pointer flip: on restore failure the switch aborts and
   * conversation and disk still point at the same candidate. The selection
   * marker keys its forkPointUuid on the target leaf's owning turn, so after
   * any-depth switches the inline switcher re-arms at the new depth. Pending
   * interactions are cleared so a switched-away gate does not linger;
   * switching to a paused candidate is a known MVP limitation.
   */
  async function applyCandidateSwitchCore(params: {
    id: string;
    fromLeaf: string;
    toLeaf: string;
    forkPointForFiles: string;
    statusLabel: string;
    successStatus: (fileOutcome: CandidateFileStateOutcome) => string;
  }): Promise<boolean> {
    runtime.setBusy(true);
    transcript.setStatus(params.statusLabel);
    try {
      const fileOutcome = await switchCandidateFileState(session.rootDir, params.id, {
        forkPointUuid: params.forkPointForFiles,
        fromLeaf: params.fromLeaf,
        toLeaf: params.toLeaf,
      });
      const markerRecords = await loadSessionRecords(session.rootDir, params.id);
      const markerFork = ownerForkOfLeaf(markerRecords, params.toLeaf) ?? params.forkPointForFiles;
      await appendCandidateSelection(session.rootDir, params.id, { forkPointUuid: markerFork, selectedLeafUuid: params.toLeaf });
      const snapshot = await loadSessionSnapshot(session.rootDir, params.id, { synthesizeDanglingToolResults: false });
      session.setConversation(vesicleMessagesFromResumed(snapshot.messages));
      transcript.setMessages(displayTranscriptFromSnapshot(snapshot.messages, agent.agentCards()));
      clearPendingInteractions();
      transcript.setOutput("");
      await hostAction.refreshArtifacts();
      transcript.setStatus(params.successStatus(fileOutcome));
      await refreshCandidateSwitcher(params.id);
      return true;
    } catch (error) {
      // A failed restore aborts before the marker, so conversation and disk
      // still point at the same candidate; even when a later step fails,
      // retrying the same switch converges (restore is idempotent, bundles
      // are captured once).
      reportError(error);
      return false;
    } finally {
      runtime.setBusy(false);
    }
  }

  async function refreshCandidateSwitcher(id: string): Promise<void> {
    try {
      const records = await loadSessionRecords(session.rootDir, id);
      const selection = findLatestSelection(records);
      if (!selection) { setCandidateSwitcher(null); return; }
      // Only arm when the fork point is still the active branch's last turn —
      // otherwise switching would orphan the turns that came after it.
      if (!await forkPointIsLastTurn(selection.forkPointUuid)) { setCandidateSwitcher(null); return; }
      const leaves = enumerateCandidateLeaves(records, selection.forkPointUuid).map((record) => record.uuid);
      if (leaves.length < 2) { setCandidateSwitcher(null); return; }
      const snapshot = await loadSessionSnapshot(session.rootDir, id, { synthesizeDanglingToolResults: false });
      const activeUuids = new Set(snapshot.records.map((record) => record.uuid));
      const activeIndex = leaves.findIndex((leaf) => activeUuids.has(leaf));
      const index = activeIndex >= 0 ? activeIndex : Math.max(0, leaves.indexOf(selection.selectedLeafUuid));
      setCandidateSwitcher({ forkPointUuid: selection.forkPointUuid, leaves, index, total: leaves.length });
    } catch {
      setCandidateSwitcher(null);
    }
  }

  return {
    ...decisionContinuations,
    deliverAgentResults,
    markTurnSawResponse,
    reportError,
    submitPrompt,
    regenerateTurn,
    switchCandidate,
    switchToCandidate,
    candidateSwitcher,
    refreshCandidateSwitcher,
  };
}
