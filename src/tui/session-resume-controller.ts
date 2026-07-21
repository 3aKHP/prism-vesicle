import type { Accessor, Setter } from "solid-js";
import type { ProviderSelection } from "../config/providers";
import type { EngineId } from "../core/engine/profile";
import { inspectEngineAssetDrift } from "../core/runtime/engine-assets";
import { stageSourceDrift } from "../core/stage/bootstrap";
import { loadSessionSnapshot } from "../core/session/store";
import { createSessionStore } from "../core/session/store";
import type { ReasoningDisplayMode, SessionSnapshot, SessionSummary } from "../core/session/store";
import type { QualityWarning } from "../core/quality";
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
  PendingQualityDecisionState,
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
import { refreshQualityDecisionArtifacts } from "../core/agent-loop/run";
import {
  assertSessionHarnessIdentity,
  requireProjectHarnessRuntime,
  resolveProjectHarnessRuntime,
} from "../core/harness";
import { pendingQualityDecisionFromSnapshot } from "./quality-decision-state";

type InteractionState = {
  setPendingGate: Setter<PendingGateState | null>;
  setPendingEngineSwitch: Setter<PendingEngineSwitchState | null>;
  setPendingUserQuestion: Setter<PendingUserQuestionState | null>;
  setPendingPermission: Setter<PendingPermissionState | null>;
  setPendingQualityDecision: Setter<PendingQualityDecisionState | null>;
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
  resolveHarnessRuntime?: typeof resolveProjectHarnessRuntime;
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
  sessionId: Accessor<string | undefined>;
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
  setQualityWarnings: Setter<QualityWarning[]>;
  setQualitySelected: Setter<number>;
  setAssetDriftKey: (key: string) => void;
  refreshArtifacts: () => Promise<unknown>;
  reportError: (error: unknown) => void;
  clearQueuedInputs: () => void;
};

export function createSessionResumeController(options: SessionResumeControllerOptions) {
  async function resumeSession(target: SessionSummary, commandEcho?: string): Promise<void> {
    options.setRestoringSession(true);
    try {
      if (!options.permissionSettingsReady()) await options.loadPermissionSettings();
      let snapshot = await loadSessionSnapshot(options.rootDir, target.sessionId, {
        synthesizeDanglingToolResults: false,
      });
      let qualityBlockedReason: string | undefined;
      let projectHarness: ReturnType<typeof requireProjectHarnessRuntime> | undefined;
      try {
        projectHarness = requireProjectHarnessRuntime(await (
          options.resolveHarnessRuntime ?? resolveProjectHarnessRuntime
        )(options.rootDir));
      } catch (error) {
        if (!snapshot.pendingQualityDecision && !snapshot.pendingQualityRewrite) throw error;
        qualityBlockedReason = qualityUnavailableMessage(snapshot, error);
      }
      if (projectHarness) {
        try {
          assertSessionHarnessIdentity(snapshot.harness, projectHarness.harness.identity);
        } catch (error) {
          if (!snapshot.pendingQualityDecision && !snapshot.pendingQualityRewrite) throw error;
          qualityBlockedReason = qualityIdentityMessage(snapshot);
        }
        qualityBlockedReason ??= qualityRuleIdentityMessage(snapshot, projectHarness.harness.quality);
        if (!qualityBlockedReason && snapshot.pendingQualityDecision && projectHarness.harness.quality) {
          snapshot = await refreshQualityDecisionArtifacts(
            options.rootDir,
            target.sessionId,
            projectHarness.harness.quality,
          );
        }
      }
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
      await hydrateLiveProcessEvents(snapshot, target.sessionId);
      const resumedMessages = vesicleMessagesFromResumed(snapshot.messages);
      const restoredCards = await restoreAgentCards(target.sessionId);
      if (options.sessionId() !== target.sessionId) options.clearQueuedInputs();
      applyBaseSnapshot(target, snapshot, resumedMessages);
      const hostMessages = await buildHostMessages(target, snapshot, commandEcho, !projectHarness);
      restorePendingInteraction(target, snapshot, resumedMessages, hostMessages, qualityBlockedReason);
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
    options.setOutput(snapshot.pendingQualityDecision?.candidate.content
      ?? snapshot.pendingQualityRewrite?.candidate?.content
      ?? snapshot.pendingGate?.assistantContent
      ?? snapshot.pendingEngineSwitch?.assistantContent
      ?? snapshot.pendingUserQuestion?.assistantContent
      ?? "");
    options.setQualityWarnings(snapshot.qualityWarnings);
    options.setSessionPicker(null);
  }

  async function buildHostMessages(
    target: SessionSummary,
    snapshot: SessionSnapshot,
    commandEcho?: string,
    skipAssetDrift = false,
  ): Promise<Message[]> {
    const restoredEngine = snapshot.engine ?? "etl";
    const hostMessages: Message[] = [];
    if (commandEcho) hostMessages.push({ role: "user", content: commandEcho });
    hostMessages.push({ role: "system", content: `Restored engine ${restoredEngine} from session.` });
    if (snapshot.qualityWarnings.length > 0) {
      const targets = snapshot.qualityWarnings.reduce((count, warning) => count + warning.targets.length, 0);
      hostMessages.push({
        role: "system",
        content: `${targets} quality warning target${targets === 1 ? " remains" : "s remain"}; the current version is not confirmed clean.`,
      });
    }
    restorePermissionMode(snapshot, hostMessages);
    if (!skipAssetDrift) await reportAssetDrift(target.sessionId, snapshot, restoredEngine, hostMessages);
    if (restoredEngine === "stage" && snapshot.stageBootstrap) {
      const changed = await stageSourceDrift(options.rootDir, snapshot.stageBootstrap);
      if (changed.length > 0) {
        hostMessages.push({
          role: "system",
          content: `Stage card source changed since this session began: ${changed.join(", ")}. The saved character and scene context remains active.`,
        });
      }
    }
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
    qualityBlockedReason?: string,
  ): void {
    const engine = snapshot.engine ?? "etl";
    resetInteractionDrafts();
    if (snapshot.pendingPermission) {
      restorePendingPermission(target, snapshot, messages, engine, hostMessages);
    } else if (snapshot.pendingQualityDecision || snapshot.pendingQualityRewrite) {
      const pending = pendingQualityDecisionFromSnapshot(snapshot, qualityBlockedReason);
      if (!pending) throw new Error("Pending Output Quality Guard state could not be restored.");
      options.setPendingQualityDecision(pending);
      options.setQualitySelected(pending.decision.canRetry ? 0 : 1);
      options.setStatus(pending.decision.canRetry
        ? `quality decision pending: ${pending.decision.findingCount} finding${pending.decision.findingCount === 1 ? "" : "s"}`
        : "quality retry blocked by Harness identity drift");
      hostMessages.push({
        role: "system",
        content: pending.decision.canRetry
          ? "Resumed an interrupted Output Quality Guard revision. Choose whether to revise again, use the current version, or stop."
          : pending.decision.blockedReason!,
      });
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
      options.setStatus(snapshot.qualityWarnings.length > 0
        ? `gate pending: ${snapshot.pendingGate.gate.gate} · quality warning`
        : `gate pending: ${snapshot.pendingGate.gate.gate}`);
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
    options.setPendingQualityDecision(null);
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

function qualityIdentityMessage(snapshot: SessionSnapshot): string {
  const pending = snapshot.pendingQualityDecision?.qualityState ?? snapshot.pendingQualityRewrite;
  return pending
    ? `Quality retry requires Harness ${pending.packId}@${pending.packVersion} and Rule Pack ${pending.ruleVersion}. The active verified Harness identity differs; use the current version or stop, or restore the required Harness before retrying.`
    : "Quality retry is blocked because the active verified Harness identity differs.";
}

function qualityUnavailableMessage(snapshot: SessionSnapshot, error: unknown): string {
  const pending = snapshot.pendingQualityDecision?.qualityState ?? snapshot.pendingQualityRewrite;
  const detail = error instanceof Error ? error.message : String(error);
  return pending
    ? `Quality retry requires Harness ${pending.packId}@${pending.packVersion} and Rule Pack ${pending.ruleVersion}, but that verified Harness cannot be loaded (${detail}). Use the current version or stop, or restore the required Harness before retrying.`
    : `Quality retry is unavailable because the recorded verified Harness cannot be loaded (${detail}).`;
}

function qualityRuleIdentityMessage(
  snapshot: SessionSnapshot,
  quality: import("../core/quality").QualityRuntimeContext | undefined,
): string | undefined {
  const pending = snapshot.pendingQualityDecision?.qualityState ?? snapshot.pendingQualityRewrite;
  if (!pending) return undefined;
  if (quality
    && quality.packId === pending.packId
    && quality.packVersion === pending.packVersion
    && quality.manifestSha256 === pending.manifestSha256
    && quality.ruleManifest.version === pending.ruleVersion
    && quality.ruleManifest.sourceHash === pending.ruleSourceHash) return undefined;
  return qualityIdentityMessage(snapshot);
}
