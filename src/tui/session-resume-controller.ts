import type { Accessor, Setter } from "solid-js";
import type { ProviderSelection } from "../config/providers";
import type { EngineId } from "../core/engine/profile";
import { inspectEngineAssetDrift } from "../core/runtime/engine-assets";
import { loadSessionSnapshot } from "../core/session/store";
import { createSessionStore } from "../core/session/store";
import type { ReasoningDisplayMode, SessionSnapshot, SessionSummary } from "../core/session/store";
import type { AgentStore } from "../core/agents/store";
import type { ProcessManager } from "../core/process/manager";
import { processEventFromTask } from "../core/tools/shell";
import type { PermissionMode } from "../core/permissions";
import type { ReasoningTier, VesicleMessage } from "../providers/shared/types";
import { agentCardFromMetadata, mergeRestoredAgentCards } from "./agent-view";
import type { GateFocusTarget } from "./GatePrompt";
import type {
  PendingEngineSwitchState,
  PendingGateState,
  PendingPermissionState,
  PendingUserQuestionState,
} from "./decision-interaction";
import {
  displayTranscriptFromSnapshot,
  joinSessionPath,
  unresolvedToolCalls,
  vesicleMessagesFromResumed,
} from "./session-presenter";
import { latestTurnUsage, sumSessionUsage, type TokenUsageSummary } from "./telemetry";
import type { AgentCardState, Message, SessionPickerState } from "./types";
import { appendHarnessDelegationDecision } from "../core/agent-loop/delegation-decision";

type InteractionState = {
  setPendingGate: Setter<PendingGateState | null>;
  setPendingEngineSwitch: Setter<PendingEngineSwitchState | null>;
  setPendingUserQuestion: Setter<PendingUserQuestionState | null>;
  setPendingPermission: Setter<PendingPermissionState | null>;
  setGateFocus: Setter<GateFocusTarget>;
  setGateFeedbackMode: Setter<GateFocusTarget | null>;
  setGateFeedback: Setter<string>;
  setGateFeedbackCursor: Setter<number>;
  setGateFeedbackKillBuffer: Setter<string | undefined>;
  setQuestionSelected: Setter<number>;
  setQuestionFreeformText: Setter<string>;
  setQuestionFreeformCursor: Setter<number>;
  setQuestionFreeformKillBuffer: Setter<string | undefined>;
};

export type SessionResumeControllerOptions = InteractionState & {
  rootDir: string;
  dangerouslySkipPermissions: boolean;
  permissionSettingsReady: Accessor<boolean>;
  loadPermissionSettings: () => Promise<void>;
  processManager: ProcessManager;
  agentStore: AgentStore;
  agentCards: Accessor<AgentCardState[]>;
  setAgentCards: Setter<AgentCardState[]>;
  permissionMode: Accessor<PermissionMode>;
  setPermissionMode: Setter<PermissionMode>;
  applyProviderSelection: (selection: Partial<ProviderSelection>) => Promise<ProviderSelection>;
  setRestoringSession: Setter<boolean>;
  setSessionId: Setter<string | undefined>;
  setNextSessionParent: Setter<{ uuid: string | null } | null>;
  setSessionPath: Setter<string>;
  setActiveEngine: Setter<EngineId>;
  setConversation: Setter<VesicleMessage[]>;
  setLastTurnUsage: Setter<TokenUsageSummary | undefined>;
  setSessionUsage: Setter<TokenUsageSummary>;
  setOutput: Setter<string>;
  setSessionPicker: Setter<SessionPickerState | null>;
  setThinkingTier: Setter<ReasoningTier | undefined>;
  setReasoningDisplayMode: Setter<ReasoningDisplayMode>;
  setStatus: Setter<string>;
  setMessages: Setter<Message[]>;
  setAssetDriftKey: (key: string) => void;
  refreshArtifacts: () => Promise<unknown>;
  reportError: (error: unknown) => void;
};

export function createSessionResumeController(options: SessionResumeControllerOptions) {
  async function resumeSession(target: SessionSummary, commandEcho?: string): Promise<void> {
    options.setRestoringSession(true);
    try {
      if (!options.permissionSettingsReady()) await options.loadPermissionSettings();
      let snapshot = await loadSessionSnapshot(options.rootDir, target.sessionId, {
        synthesizeDanglingToolResults: false,
      });
      if (snapshot.pendingDelegationDecisionRecovery) {
        await appendHarnessDelegationDecision({
          decision: snapshot.pendingDelegationDecisionRecovery,
          messages: [],
          session: await createSessionStore(options.rootDir, target.sessionId),
          engine: snapshot.pendingDelegationDecisionRecovery.failed.delegation.parentEngine,
        });
        snapshot = await loadSessionSnapshot(options.rootDir, target.sessionId, {
          synthesizeDanglingToolResults: false,
        });
      }
      if (snapshot.pendingDelegationRetry) {
        throw new Error(
          `Session has an authorized Harness retry pending for ${snapshot.pendingDelegationRetry.delegationId}. `
          + "Resume is blocked until the verified managed Harness context can restore that retry.",
        );
      }
      if (snapshot.pendingQualityRewrite && !snapshot.pendingPermission) {
        throw new Error(
          `Session has an Output Quality Guard continuation pending for ${snapshot.pendingQualityRewrite.producer}. `
          + "Resume is blocked until the same verified managed Harness context continues that rewrite.",
        );
      }
      await hydrateLiveProcessEvents(snapshot, target.sessionId);
      const resumedMessages = vesicleMessagesFromResumed(snapshot.messages);
      const restoredCards = await restoreAgentCards(target.sessionId);
      applyBaseSnapshot(target, snapshot, resumedMessages);
      const hostMessages = await buildHostMessages(target, snapshot, commandEcho);
      restorePendingInteraction(target, snapshot, resumedMessages, hostMessages);
      options.setMessages([...displayTranscriptFromSnapshot(snapshot.messages, restoredCards), ...hostMessages]);
      await options.refreshArtifacts();
    } catch (error) {
      options.reportError(error);
    } finally {
      options.setRestoringSession(false);
    }
  }

  async function hydrateLiveProcessEvents(snapshot: SessionSnapshot, sessionId: string): Promise<void> {
    const liveProcesses = await options.processManager.list(sessionId);
    const liveByTaskId = new Map(liveProcesses.map((process) => [process.taskId, process]));
    for (const message of snapshot.messages) {
      const taskId = message.toolProcessEvent?.taskId;
      const live = taskId ? liveByTaskId.get(taskId) : undefined;
      if (live) message.toolProcessEvent = processEventFromTask(live);
    }
  }

  async function restoreAgentCards(sessionId: string): Promise<AgentCardState[]> {
    const [storedAgents, storedInbox] = await Promise.all([
      options.agentStore.listByParent(sessionId),
      options.agentStore.listInbox(sessionId),
    ]);
    const restored = storedAgents.map((agent) => agentCardFromMetadata(agent, storedInbox));
    options.setAgentCards((current) => mergeRestoredAgentCards(current, sessionId, restored));
    return restored;
  }

  function applyBaseSnapshot(target: SessionSummary, snapshot: SessionSnapshot, messages: VesicleMessage[]): void {
    const restoredEngine = snapshot.engine ?? "etl";
    options.setSessionId(target.sessionId);
    options.setNextSessionParent(null);
    options.setSessionPath(joinSessionPath(target.sessionId));
    options.setActiveEngine(restoredEngine);
    options.setConversation(messages);
    options.setLastTurnUsage(latestTurnUsage(snapshot.messages));
    options.setSessionUsage(sumSessionUsage(snapshot.messages));
    options.setOutput(snapshot.pendingGate?.assistantContent ?? snapshot.pendingEngineSwitch?.assistantContent ?? snapshot.pendingUserQuestion?.assistantContent ?? "");
    options.setSessionPicker(null);
  }

  async function buildHostMessages(
    target: SessionSummary,
    snapshot: SessionSnapshot,
    commandEcho?: string,
  ): Promise<Message[]> {
    const restoredEngine = snapshot.engine ?? "etl";
    const hostMessages: Message[] = [];
    if (commandEcho) hostMessages.push({ role: "user", content: commandEcho });
    hostMessages.push({ role: "system", content: `Restored engine ${restoredEngine} from session.` });
    restorePermissionMode(snapshot, hostMessages);
    await reportAssetDrift(target.sessionId, snapshot, restoredEngine, hostMessages);
    await restoreProvider(snapshot, hostMessages);
    if (snapshot.reasoningTier) {
      options.setThinkingTier(snapshot.reasoningTier);
      hostMessages.push({ role: "system", content: `Restored thinking effort ${snapshot.reasoningTier} from session.` });
    }
    if (snapshot.reasoningDisplayMode) {
      options.setReasoningDisplayMode(snapshot.reasoningDisplayMode);
      hostMessages.push({ role: "system", content: `Restored reasoning display ${snapshot.reasoningDisplayMode} from session.` });
    }
    return hostMessages;
  }

  function restorePermissionMode(snapshot: SessionSnapshot, hostMessages: Message[]): void {
    const restored = options.dangerouslySkipPermissions
      ? "YOLO"
      : snapshot.permissionMode === "YOLO"
        ? "MOMENTUM"
        : snapshot.permissionMode ?? options.permissionMode();
    options.setPermissionMode(restored);
    hostMessages.push({
      role: "system",
      content: snapshot.permissionMode === "YOLO" && !options.dangerouslySkipPermissions
        ? "Previous YOLO permission mode was downgraded to MOMENTUM on resume. Re-enable YOLO explicitly if needed."
        : `Restored permission mode ${restored}.`,
    });
  }

  async function reportAssetDrift(
    sessionId: string,
    snapshot: SessionSnapshot,
    engine: EngineId,
    hostMessages: Message[],
  ): Promise<void> {
    const drift = await inspectEngineAssetDrift(snapshot.assets, engine, options.rootDir);
    if (!drift) return;
    options.setAssetDriftKey(`${sessionId}:${drift.current.sha256}`);
    const changed = drift.changedPaths.length > 0 ? drift.changedPaths.join(", ") : "effective profile/prompt assets";
    hostMessages.push({
      role: "system",
      content: `Asset drift detected since this session began: ${changed}. Continued turns use the current effective assets.`,
    });
  }

  async function restoreProvider(snapshot: SessionSnapshot, hostMessages: Message[]): Promise<void> {
    if (!snapshot.providerSelection) return;
    try {
      const selection = await options.applyProviderSelection(snapshot.providerSelection);
      hostMessages.push({ role: "system", content: `Restored provider ${selection.provider}/${selection.model} from session.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hostMessages.push({ role: "system", content: `Session provider was not restored: ${message}` });
    }
  }

  function restorePendingInteraction(
    target: SessionSummary,
    snapshot: SessionSnapshot,
    messages: VesicleMessage[],
    hostMessages: Message[],
  ): void {
    const engine = snapshot.engine ?? "etl";
    resetInteractionDrafts();
    if (snapshot.pendingPermission) {
      restorePendingPermission(target, snapshot, messages, engine, hostMessages);
    } else if (snapshot.pendingGate) {
      options.setPendingGate({
        kind: "needs_user",
        sessionId: target.sessionId,
        sessionPath: joinSessionPath(target.sessionId),
        engine,
        gate: snapshot.pendingGate.gate,
        toolCallId: snapshot.pendingGate.toolCallId,
        assistantContent: snapshot.pendingGate.assistantContent,
        messages,
      });
      options.setGateFocus("confirm");
      options.setStatus(`gate pending: ${snapshot.pendingGate.gate.gate}`);
      hostMessages.push({ role: "system", content: `Resumed pending gate ${snapshot.pendingGate.gate.gate}. Use the gate controls below to continue.` });
    } else if (snapshot.pendingEngineSwitch) {
      options.setPendingEngineSwitch({
        kind: "needs_engine_switch",
        sessionId: target.sessionId,
        sessionPath: joinSessionPath(target.sessionId),
        request: snapshot.pendingEngineSwitch.request,
        toolCallId: snapshot.pendingEngineSwitch.toolCallId,
        assistantContent: snapshot.pendingEngineSwitch.assistantContent,
        messages,
      });
      options.setGateFocus("confirm");
      options.setStatus(`engine switch pending: ${snapshot.pendingEngineSwitch.request.targetEngine}`);
      hostMessages.push({ role: "system", content: `Resumed pending engine switch to ${snapshot.pendingEngineSwitch.request.targetEngine}. Use the gate controls below to continue.` });
    } else if (snapshot.pendingUserQuestion) {
      options.setPendingUserQuestion({
        kind: "needs_user_question",
        sessionId: target.sessionId,
        sessionPath: joinSessionPath(target.sessionId),
        engine,
        question: snapshot.pendingUserQuestion.question,
        ...(snapshot.pendingUserQuestion.delegationDecision
          ? { delegationDecision: snapshot.pendingUserQuestion.delegationDecision }
          : {}),
        toolCallId: snapshot.pendingUserQuestion.toolCallId,
        assistantContent: snapshot.pendingUserQuestion.assistantContent,
        messages,
      });
      options.setStatus(`question pending: ${snapshot.pendingUserQuestion.question.header}`);
      hostMessages.push({ role: "system", content: `Resumed pending question ${snapshot.pendingUserQuestion.question.header}. Choose an option below to continue.` });
    } else {
      options.setStatus(`resumed ${target.sessionId.slice(11)}`);
      hostMessages.push({ role: "system", content: `Resumed session ${target.sessionId} with ${snapshot.messages.length} prior turns. Continue below.` });
    }
  }

  function restorePendingPermission(
    target: SessionSummary,
    snapshot: SessionSnapshot,
    messages: VesicleMessage[],
    engine: EngineId,
    hostMessages: Message[],
  ): void {
    const request = snapshot.pendingPermission!;
    options.setPendingPermission({
      kind: "needs_permission",
      sessionId: target.sessionId,
      sessionPath: joinSessionPath(target.sessionId),
      engine,
      request,
      remainingToolCalls: unresolvedToolCalls(snapshot.messages, request.toolCallId),
      assistantContent: "",
      messages,
    });
    options.setGateFocus("confirm");
    options.setStatus(`permission pending: ${request.toolName}`);
    hostMessages.push({ role: "system", content: `Resumed pending permission for ${request.toolName}.` });
  }

  function resetInteractionDrafts(): void {
    options.setPendingGate(null);
    options.setPendingEngineSwitch(null);
    options.setPendingUserQuestion(null);
    options.setPendingPermission(null);
    options.setQuestionSelected(0);
    options.setQuestionFreeformText("");
    options.setQuestionFreeformCursor(0);
    options.setQuestionFreeformKillBuffer(undefined);
    options.setGateFeedbackMode(null);
    options.setGateFeedback("");
    options.setGateFeedbackCursor(0);
    options.setGateFeedbackKillBuffer(undefined);
  }

  return { resumeSession };
}
