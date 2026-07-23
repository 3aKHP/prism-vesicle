import { createEffect, createMemo, createSignal, Show, onCleanup, onMount } from "solid-js";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import type { EngineId } from "../core/engine/profile";
import type { VesicleMessage } from "../providers/shared/types";
import type { ReasoningTier } from "../providers/shared/types";
import { engineAccent, palette } from "./theme";
import { listSessions, loadSessionSnapshot } from "../core/session/store";
import type { ReasoningDisplayMode, SessionSummary } from "../core/session/store";
import { loadArtifactPreview, scanArtifacts } from "../core/artifacts/workbench";
import type { ArtifactEntry } from "../core/artifacts/workbench";
import type { QualityWarning } from "../core/quality";
import { resolveTuiLayout } from "./layout";
import { Sidebar } from "./views/Sidebar";
import { MessageStream } from "./views/MessageStream";
import { rewindPickerPanelHeight } from "./RewindPicker";
import { yoloPanelHeight } from "./YoloPrompt";
import { builtinCommands } from "./commands/builtin";
import { executeCommand } from "./commands/dispatch";
import type { CommandContext } from "./commands/types";
import type { ActivityEntry, AgentCardState, Message, SelectedArtifact, SessionPickerState } from "./types";
import { createRewindController } from "./rewind/controller";
import { initDebugLogging } from "./debug-log";
import { TurnCancellation } from "./turn-cancellation";
import { AgentManager } from "../core/agents/manager";
import { AgentStore } from "../core/agents/store";
import { runChildAgent } from "../core/agents/child-runner";
import { AgentContinuationScheduler } from "../core/agents/scheduler";
import { agentActivitySummary } from "./agent-view";
import { ToolPermissionBroker } from "../core/permissions";
import { getProcessManager, type BackgroundProcessState } from "../core/process/manager";
import {
  backgroundProcessActivitySummary,
  contextUsageTelemetryLine,
  createUsageController,
  footerLine,
  headerLine,
  latestTurnUsage,
  sessionUsageTelemetryLine,
  sumSessionUsage,
  turnUsageTelemetryLine,
  type TokenUsageSummary,
} from "./telemetry";
import { displayTranscriptFromSnapshot } from "./session-presenter";
import { BottomSurface } from "./views/BottomSurface";
import { createAgentProcessController } from "./agent-process-controller";
import { createSessionResumeController } from "./session-resume-controller";
import { createComposerController } from "./composer-controller";
import { createDecisionController } from "./decision-controller";
import { createTurnController } from "./turn-controller";
import { createProviderConfigController, createProviderState } from "./provider-config-controller";
import { createSessionActionsController } from "./session-actions-controller";
import { createSessionPreferencesController } from "./session-preferences-controller";
import { createAgentCommand } from "./agent-command";
import { useInputRouting } from "./input-routing";
import { createQualityPickerController } from "./quality-picker-controller";
import { startStageSession } from "../core/stage/bootstrap";
import { artifactFocusAction, artifactFocusPath, initialArtifactFocusPath } from "./artifact-focus";
import { ArtifactFocusPreview } from "./widgets/ArtifactFocusPreview";
import { createInputQueue } from "./input-queue";
import { routeCommandSubmission } from "./command-scheduler";
import { createSideQuestionController } from "./side-question-controller";
import { SideQuestionOverlay } from "./views/SideQuestionOverlay";
import { copyTextToClipboard } from "./clipboard";

export type AppProps = {
  dangerouslySkipPermissions?: boolean;
  initialResume?: boolean;
};

export {
  backgroundProcessActivitySummary,
  contextUsageTelemetryLine,
  displayTranscriptFromSnapshot,
  footerLine,
  headerLine,
  latestTurnUsage,
  sessionUsageTelemetryLine,
  sumSessionUsage,
  turnUsageTelemetryLine,
};
export type { TokenUsageSummary };

export function App(props: AppProps = {}) {
  initDebugLogging();
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const providerState = createProviderState(props.dangerouslySkipPermissions === true);
  const {
    activeModel,
    activeModelCapabilities,
    activeModelLimits,
    activeProvider,
    mcpStatus,
    permissionMode,
    permissionSettingsReady,
    providerConfigReady,
    providerHasApiKey,
    providerRegistry,
    setActiveModel,
    setActiveModelCapabilities,
    setActiveModelLimits,
    setActiveProvider,
    setMcpStatus,
    setPermissionMode,
    setPermissionSettingsReady,
    setProviderConfigReady,
    setProviderHasApiKey,
    setProviderRegistry,
    setShellExecEnabled,
    setShellInterpreter,
    shellExecEnabled,
    shellInterpreter,
  } = providerState;
  const [activeEngine, setActiveEngine] = createSignal<EngineId>("etl");
  const [thinkingTier, setThinkingTier] = createSignal<ReasoningTier | undefined>();
  const [reasoningDisplayMode, setReasoningDisplayMode] = createSignal<ReasoningDisplayMode>("collapsed");
  const [messages, setMessages] = createSignal<Message[]>([
    {
      role: "system",
      content: "Ready. Enter one Prism prompt and press Enter.",
    },
    ...(props.dangerouslySkipPermissions ? [{
      role: "system" as const,
      content: "DANGER: --dangerously-skip-permissions enabled YOLO for this process. Tool approvals are bypassed; runtime hard guards remain active.",
    }] : []),
  ]);
  const [status, setStatus] = createSignal("loading provider config");
  const [sessionPath, setSessionPath] = createSignal("no session yet");
  const [sessionId, setSessionId] = createSignal<string | undefined>();
  const [conversation, setConversation] = createSignal<VesicleMessage[]>([]);
  const [, setOutput] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [queuedInputReady, setQueuedInputReady] = createSignal(false);
  const [queuedSendAfterInterrupt, setQueuedSendAfterInterrupt] = createSignal(false);
  const inputQueue = createInputQueue();
  const [restoringSession, setRestoringSession] = createSignal(false);
  const [, setResumableSessions] = createSignal<SessionSummary[]>([]);
  const [sessionPicker, setSessionPicker] = createSignal<SessionPickerState | null>(null);
  const [nextSessionParent, setNextSessionParent] = createSignal<{ uuid: string | null } | null>(null);
  const [artifacts, setArtifacts] = createSignal<ArtifactEntry[]>([]);
  const [qualityWarnings, setQualityWarnings] = createSignal<QualityWarning[]>([]);
  const [selectedArtifact, setSelectedArtifact] = createSignal<SelectedArtifact | null>(null);
  const [focusedArtifactPath, setFocusedArtifactPath] = createSignal<string | null>(null);
  const [, setActivity] = createSignal<ActivityEntry[]>([
    { kind: "system", text: "Activity will show provider requests, tool calls, gates, and validation." },
  ]);
  const [agentCards, setAgentCards] = createSignal<AgentCardState[]>([]);
  const [backgroundProcesses, setBackgroundProcesses] = createSignal<BackgroundProcessState[]>([]);
  const [streamingAssistant, setStreamingAssistant] = createSignal("");
  const [streamingReasoning, setStreamingReasoning] = createSignal("");
  const usageController = createUsageController();
  const {
    beginTurn: beginUsageTurn,
    lastTurnUsage,
    publishTurn: publishTurnUsage,
    recordIndependent: recordIndependentAgentUsage,
    recordResponse: recordResponseUsage,
    sessionUsage,
    setLastTurnUsage,
    setSessionUsage,
  } = usageController;
  const [lastDisplayedToolAssistantContent, setLastDisplayedToolAssistantContent] = createSignal<string | null>(null);
  const turnCancellation = new TurnCancellation();
  let handleStageMessageKey: ((key: import("./decision-interaction").TuiKeyEvent) => boolean) | undefined;

  let turnController!: ReturnType<typeof createTurnController>;
  let resumeSession!: ReturnType<typeof createSessionResumeController>["resumeSession"];
  let sessionPreferences!: ReturnType<typeof createSessionPreferencesController>;
  const decisionController = createDecisionController({
    busy,
    activeEngine,
    permissionMode,
    setStatus,
    submitPermission: (resolution) => { void turnController.submitPermissionResolution(resolution); },
    submitChildPermission: (resolution) => turnController.submitChildPermissionResolution(resolution),
    submitEngineSwitch: (resolution, submitOptions) => { void turnController.submitEngineSwitchResolution(resolution, submitOptions); },
    submitGate: (resolution) => { void turnController.submitGateResolution(resolution); },
    submitQuestionOption: (selectedIndex) => { void turnController.submitUserQuestionAnswer(selectedIndex); },
    submitQuestionFreeform: (value) => turnController.submitUserQuestionFreeform(value),
    submitQualityDecision: (resolution) => { void turnController.submitQualityDecision(resolution); },
    applyPermissionMode: (mode) => sessionPreferences.applyPermissionMode(mode),
  });
  const {
    activeGateRequest,
    activePermissionRequest,
    clearGateFeedback,
    clearQuestionFreeform,
    decisionPanelMinHeight,
    gateFeedback,
    gateFeedbackCursor,
    gateFeedbackMode,
    gateFocus,
    handleGateKey,
    handlePaste: handleDecisionPaste,
    handleQuestionKey,
    handleQualityKey,
    handleYoloKey,
    pendingChildPermission,
    pendingEngineSwitch,
    pendingGate,
    pendingPermission,
    pendingQualityDecision,
    pendingUserQuestion,
    questionFreeformCursor,
    questionFreeformText,
    questionSelected,
    qualitySelected,
    setGateFeedback,
    setGateFeedbackCursor,
    setGateFeedbackKillBuffer,
    setGateFeedbackMode,
    setGateFocus,
    setPendingChildPermission,
    setPendingEngineSwitch,
    setPendingGate,
    setPendingPermission,
    setPendingQualityDecision,
    setPendingUserQuestion,
    setQuestionFreeformCursor,
    setQuestionFreeformKillBuffer,
    setQuestionFreeformText,
    setQuestionSelected,
    setQualitySelected,
    setYoloConfirmStage,
    yoloConfirmStage,
  } = decisionController;
  sessionPreferences = createSessionPreferencesController({
    rootDir: process.cwd(),
    dangerouslySkipPermissions: props.dangerouslySkipPermissions === true,
    sessionId,
    nextSessionParent,
    setNextSessionParent,
    permissionMode,
    setPermissionMode,
    setGateFocus,
    setYoloConfirmStage,
    setStatus,
    setMessages,
    setConversation,
  });
  const {
    changePermissionMode,
    persistEngineSwitch,
    persistProviderSwitch,
    persistReasoningSwitch,
    persistThinkingSwitch,
  } = sessionPreferences;
  let lastReportedAssetDriftKey: string | undefined;
  const agentStore = new AgentStore(process.cwd());
  const processManager = getProcessManager(process.cwd());
  const agentProcessController = createAgentProcessController({
    sessionId,
    busy,
    activeEngine,
    activeModel,
    backgroundProcesses,
    setBackgroundProcesses,
    setAgentCards,
    setMessages,
    setActivity,
    setStatus,
    setStreamingAssistant,
    setStreamingReasoning,
    setLastDisplayedToolAssistantContent,
    markTurnSawResponse: () => turnController.markTurnSawResponse(),
    recordResponseUsage,
    recordIndependentAgentUsage,
    assetDriftKey: () => lastReportedAssetDriftKey,
    setAssetDriftKey: (key) => { lastReportedAssetDriftKey = key; },
  });
  const {
    handleAgentEvent,
    handleBackgroundProcessEvent,
    recordActivity,
  } = agentProcessController;
  const providerConfigController = createProviderConfigController({
    dangerouslySkipPermissions: props.dangerouslySkipPermissions === true,
    providerRegistry,
    setProviderRegistry,
    setActiveProvider,
    setActiveModel,
    setActiveModelLimits,
    setActiveModelCapabilities,
    setProviderHasApiKey,
    setProviderConfigReady,
    setMcpStatus,
    setPermissionMode,
    setShellExecEnabled,
    setShellInterpreter,
    setPermissionSettingsReady,
    thinkingTier,
    activeProvider,
    activeModel,
    setStatus,
    recordActivity,
  });
  const {
    activeGeneration,
    activeProviderSelection,
    applyProviderSelection,
    ensureProviderRegistry,
    loadPermissionSettingsOnce,
    loadProviderConfigOnce,
    refreshMcpStatus,
  } = providerConfigController;
  let sessionActions!: ReturnType<typeof createSessionActionsController>;
  const rewindController = createRewindController({
    rootDir: process.cwd(),
    sessionId,
    branchHead: nextSessionParent,
    busy,
    engine: activeEngine,
    providerSelection: activeProviderSelection,
    generation: activeGeneration,
    setStatus,
    setBusy,
    runCancellable: (operation) => turnCancellation.run(operation),
    refreshArtifacts,
    applyConversation: (result) => sessionActions.applyConversationRewind(result),
  });
  const rewindPicker = rewindController.state;
  function submitCommand(raw: string): boolean {
    return routeCommandSubmission(raw, busy(), builtinCommands, {
      execute: (value) => {
        void executeCommand(value, commandContext, builtinCommands).catch((error) => turnController.reportError(error));
      },
      enqueue: (command) => {
        const count = inputQueue.enqueueCommand(command);
        setStatus(`command queued (${count})`);
        recordActivity({ kind: "system", text: `queued command ${command.commandName} (${count})` });
        return count;
      },
      reject: setStatus,
    });
  }
  const composerController = createComposerController({
    rootDir: process.cwd(),
    terminalWidth: () => dimensions().width,
    providerRegistry,
    activeProvider,
    ensureProviderRegistry,
    applyProviderSelection,
    persistProviderSwitch,
    agentCards,
    sessionId,
    refreshArtifacts,
    listSessions,
    busy,
    activeModelCapabilities,
    status,
    setStatus,
    setMessages,
    recordActivity,
    reportError: (error) => turnController.reportError(error),
    inputQueue,
    submitCommand,
    submitPrompt: (value, images, elements) => turnController.submitPrompt(value, images, elements),
    abortTurn: () => {
      const aborted = turnCancellation.abort();
      if (aborted) setQueuedSendAfterInterrupt(inputQueue.items().length > 0);
      return aborted;
    },
    openRewind: rewindController.open,
  });
  const {
    applyState: applyComposerState,
    clear: clearComposer,
    commandArgumentItems,
    commandArgumentDraft,
    commandArgumentMenuOpen,
    commandArgumentSelected,
    commandMenuItems,
    commandMenuOpen,
    commandMenuSelected,
    composerInputWidth,
    composerPopupOpen,
    handleEscape: handleEscapeAtPrompt,
    handleKey: handleComposerKey,
    handleModelPickerKey,
    inputCursor,
    inputNeedsExpandedBottom,
    inputValue,
    insertPastedText: insertComposerPaste,
    modelPicker,
    modelPickerItems,
    modelPickerTitle,
    openModelPicker,
    pasteClipboardImage,
    queuedInputs,
    recordHistory: recordPromptHistory,
    clearQueuedInputs,
    restoreNextQueuedInput,
    setHistoryIndex,
    setInputImages,
    setPromptHistory,
    takeQueuedMessages,
    takeNextQueuedInput,
    takeToolBoundaryCommands,
  } = composerController;
  const qualityPickerController = createQualityPickerController({
    providerRegistry,
    ensureProviderRegistry,
    setStatus,
    setMessages,
    reportError: (error) => turnController.reportError(error),
  });
  const {
    qualityPicker,
    qualityPickerItems,
    qualityPickerTitle,
    handleQualityPickerKey,
    openQualityPicker,
  } = qualityPickerController;
  const unsubscribeProcesses = processManager.subscribe(handleBackgroundProcessEvent);
  onCleanup(() => {
    unsubscribeProcesses();
    void processManager.shutdown();
    sideQuestionController.dispose();
  });
  const permissionBroker = new ToolPermissionBroker();
  permissionBroker.subscribe((request) => setPendingChildPermission(request ?? null));
  const pausedAgentDeliveries = new Set<string>();
  let agentManager!: AgentManager;
  const mainActive = () => busy()
    || Boolean(pendingGate() || pendingEngineSwitch() || pendingUserQuestion()
      || pendingPermission() || pendingQualityDecision() || pendingChildPermission());
  const sideQuestionController = createSideQuestionController({
    rootDir: process.cwd(),
    sessionId,
    conversation,
    activeEngine,
    activeProviderSelection,
    activeReasoningTier: thinkingTier,
    mainStatus: status,
    mainActive,
    setStatus,
    copyText: (text) => copyTextToClipboard(renderer, text),
  });
  turnController = createTurnController({
    rootDir: process.cwd(),
    dangerouslySkipPermissions: props.dangerouslySkipPermissions === true,
    busy,
    setBusy,
    setQueuedInputReady,
    queuedSendAfterInterrupt,
    setQueuedSendAfterInterrupt,
    providerConfigReady,
    setProviderConfigReady,
    loadProviderConfig: loadProviderConfigOnce,
    permissionSettingsReady,
    loadPermissionSettings: loadPermissionSettingsOnce,
    activeModelCapabilities,
    activeEngine,
    setActiveEngine,
    activeModel,
    activeProviderSelection,
    activeGeneration,
    permissionMode,
    shellExecEnabled,
    shellInterpreter,
    sessionId,
    setSessionId,
    sessionPath,
    setSessionPath,
    conversation,
    setConversation,
    nextSessionParent,
    setNextSessionParent,
    setOutput,
    setStatus,
    messages,
    setMessages,
    agentCards,
    setAgentCards,
    setStreamingAssistant,
    setStreamingReasoning,
    lastDisplayedToolAssistantContent,
    setLastDisplayedToolAssistantContent,
    pendingGate,
    setPendingGate,
    pendingEngineSwitch,
    setPendingEngineSwitch,
    pendingUserQuestion,
    setPendingUserQuestion,
    pendingPermission,
    setPendingPermission,
    pendingQualityDecision,
    setPendingQualityDecision,
    pendingChildPermission,
    setQuestionSelected,
    questionSelected,
    setQualitySelected,
    questionFreeformText,
    clearQuestionFreeform,
    setGateFocus,
    setGateFeedbackMode,
    clearGateFeedback,
    setSessionPicker,
    pausedAgentDeliveries,
    agentManager: () => agentManager,
    permissionBroker,
    runCancellable: (operation) => turnCancellation.run(operation),
    handleAgentEvent,
    onProviderContextSnapshot: sideQuestionController.captureSnapshot,
    beginUsageTurn,
    publishTurnUsage,
    recordIndependentAgentUsage,
    recordActivity,
    refreshArtifacts,
    refreshQualityWarnings,
    resumeQualitySession: async (targetSessionId) => {
      const target = (await listSessions(process.cwd())).find((session) => session.sessionId === targetSessionId);
      if (!target) throw new Error(`Session not found: ${targetSessionId}`);
      await resumeSession(target);
    },
    compactSession: (instructions) => sessionActions.compactSession(instructions),
    initProject: (notes) => sessionActions.initProject(notes),
    executeLocalCommand: (prompt) => executeCommand(prompt, commandContext, builtinCommands),
    recordPromptHistory,
    applyComposerState,
    composerValue: inputValue,
    setInputImages,
    setHistoryIndex,
    setPromptHistory,
    takeQueuedMessages,
    takeToolBoundaryCommands,
    restoreNextQueuedInput,
    applyConversationRewind: (result) => sessionActions.applyConversationRewind(result),
  });
  const { reportError } = turnController;
  const continuationScheduler = new AgentContinuationScheduler(agentStore, turnController.deliverAgentResults, {
    isParentIdle: (parentSessionId) => sessionId() === parentSessionId
      && !pausedAgentDeliveries.has(parentSessionId)
      && !restoringSession()
      && !busy()
      && !pendingGate()
      && !pendingEngineSwitch()
      && !pendingUserQuestion()
      && !pendingPermission()
      && !pendingQualityDecision()
      && !pendingChildPermission(),
  });
  agentManager = new AgentManager(agentStore, runChildAgent, {
    onEvent: (event) => {
      handleAgentEvent(event);
      if (event.type === "agent_completed"
        && event.result.mode === "background"
        && event.result.status !== "cancelled") {
        void continuationScheduler.notify(event.result.parentSessionId).catch(turnController.reportError);
      }
    },
  });
  const agentCommand = createAgentCommand({
    rootDir: process.cwd(),
    sessionId,
    agentCards,
    agentManager,
    agentStore,
    pausedDeliveries: pausedAgentDeliveries,
    scheduler: continuationScheduler,
    reportError,
  });
  ({ resumeSession } = createSessionResumeController({
    rootDir: process.cwd(),
    dangerouslySkipPermissions: props.dangerouslySkipPermissions === true,
    permissionSettingsReady,
    loadPermissionSettings: loadPermissionSettingsOnce,
    processManager,
    agentStore,
    agentCards,
    setAgentCards,
    permissionMode,
    setPermissionMode,
    applyProviderSelection,
    setRestoringSession,
    sessionId,
    setSessionId,
    setNextSessionParent,
    setSessionPath,
    setActiveEngine,
    setConversation,
    setLastTurnUsage,
    setSessionUsage,
    setOutput,
    setSessionPicker,
    setThinkingTier,
    setReasoningDisplayMode,
    setStatus,
    setMessages,
    setAssetDriftKey: (key) => { lastReportedAssetDriftKey = key; },
    refreshArtifacts,
    reportError: turnController.reportError,
    setPendingGate,
    setPendingEngineSwitch,
    setPendingUserQuestion,
    setPendingPermission,
    setPendingQualityDecision,
    setQualitySelected,
    setQualityWarnings,
    setGateFocus,
    setGateFeedbackMode,
    setGateFeedback,
    setGateFeedbackCursor,
    setGateFeedbackKillBuffer,
    setQuestionSelected,
    setQuestionFreeformText,
    setQuestionFreeformCursor,
    setQuestionFreeformKillBuffer,
    clearQueuedInputs,
    onSessionActive: (id) => { void sideQuestionController.rebuildForResume(id).catch(reportError); },
  }));
  sessionActions = createSessionActionsController({
    rootDir: process.cwd(),
    sessionId,
    activeEngine,
    setActiveEngine,
    activeProviderSelection,
    activeGeneration,
    providerConfigReady,
    loadProviderConfig: loadProviderConfigOnce,
    pendingGate,
    setPendingGate,
    pendingEngineSwitch,
    setPendingEngineSwitch,
    pendingUserQuestion,
    setPendingUserQuestion,
    pendingPermission,
    setPendingPermission,
    pendingQualityDecision,
    setPendingQualityDecision,
    pendingChildPermission,
    agentCards,
    setConversation,
    setMessages,
    setThinkingTier,
    setReasoningDisplayMode,
    applyProviderSelection,
    setOutput,
    setNextSessionParent,
    applyComposerState,
    clearComposer,
    setInputImages,
    setHistoryIndex,
    setLastTurnUsage,
    setSessionUsage,
    sessionPicker,
    setSessionPicker,
    setBusy,
    setStatus,
    recordActivity,
    runCancellable: (operation) => turnCancellation.run(operation),
    rewindReset: rewindController.reset,
    refreshArtifacts,
    resumeSession,
  });
  const {
    compactSession,
    initProject,
    handleSessionPickerKey,
    resetRewindState,
  } = sessionActions;
  createEffect(() => {
    const ready = queuedInputReady()
      && !restoringSession()
      && !busy()
      && !pendingGate()
      && !pendingEngineSwitch()
      && !pendingUserQuestion()
      && !pendingPermission()
      && !pendingQualityDecision()
      && !pendingChildPermission()
      && !rewindPicker()
      && !sessionPicker()
      && !modelPicker()
      && !qualityPicker()
      && !yoloConfirmStage();
    if (!ready || queuedInputs().length === 0) return;
    const next = takeNextQueuedInput();
    if (!next) return;
    setQueuedInputReady(false);
    if (next.kind === "message") {
      void turnController.submitPrompt(next.value, next.images, next.elements).catch((error) => {
        restoreNextQueuedInput(next);
        reportError(error);
      });
      return;
    }
    void executeCommand(next.raw, commandContext, builtinCommands).then(
      () => setQueuedInputReady(true),
      (error) => {
        reportError(error);
        setQueuedInputReady(true);
      },
    );
  });
  createEffect(() => {
    const id = sessionId();
    const ready = !restoringSession() && !busy() && !pendingGate() && !pendingEngineSwitch() && !pendingUserQuestion() && !pendingPermission() && !pendingQualityDecision() && !pendingChildPermission();
    if (id && ready) void continuationScheduler.notify(id).catch(reportError);
  });

  const layout = createMemo(() => resolveTuiLayout(
    dimensions().width,
    dimensions().height,
    Boolean(pendingGate()) || Boolean(pendingEngineSwitch()) || Boolean(pendingUserQuestion()) || Boolean(pendingPermission()) || Boolean(pendingQualityDecision()) || Boolean(pendingChildPermission()) || Boolean(yoloConfirmStage()),
    Boolean(sessionPicker()) || Boolean(rewindPicker()) || Boolean(modelPicker()) || Boolean(qualityPicker()) || inputNeedsExpandedBottom(),
    yoloConfirmStage()
      ? Math.max(decisionPanelMinHeight(), yoloPanelHeight(yoloConfirmStage()!, dimensions().width))
      : decisionPanelMinHeight(),
    rewindPicker() ? rewindPickerPanelHeight(rewindPicker()!) : 8,
    rewindPicker() ? rewindPickerPanelHeight(rewindPicker()!) : 12,
  ));
  createEffect(() => {
    if (focusedArtifactPath() && !layout().showSidebar) setFocusedArtifactPath(null);
  });
  const qualityWarningPaths = createMemo(() => new Set(qualityWarnings().flatMap((warning) =>
    warning.targets.flatMap((target) => target.path ? [target.path] : [])
  )));
  const gateWithQualityWarning = createMemo(() => {
    const gate = activeGateRequest();
    if (!gate || qualityWarnings().length === 0) return gate;
    const count = qualityWarnings().reduce((total, warning) => total + warning.targets.length, 0);
    return {
      ...gate,
      summary: `Quality warning: ${count} target${count === 1 ? "" : "s"} remain unconfirmed.\n\n${gate.summary}`,
    };
  });
  const composerPopupMaxRows = createMemo(() => Math.min(8, Math.max(1, layout().bottomHeight - 4)));

  // On mount, detect existing sessions so the welcome line can offer resume.
  onMount(() => {
    void refreshArtifacts();
    void agentStore.recoverInterrupted().then((recovered) => {
      if (recovered.length === 0) return;
      setMessages((current) => [...current, {
        role: "system",
        content: `Recovered ${recovered.length} interrupted SubAgent${recovered.length === 1 ? "" : "s"}; foreground tool calls were closed and background failures will be delivered when their parent sessions resume.`,
      }]);
      for (const agent of recovered.filter((entry) => entry.mode === "background")) {
        void continuationScheduler.notify(agent.parentSessionId).catch(reportError);
      }
    }).catch(reportError);
    void refreshMcpStatus().catch(reportError);
    if (!props.dangerouslySkipPermissions) void loadPermissionSettingsOnce().catch(reportError);
    void loadProviderConfigOnce().catch((error) => {
      setProviderConfigReady(true);
      reportError(error);
    });
    void listSessions().then((sessions) => {
      setResumableSessions(sessions);
      // `--resume`/`-r` routes to the same host-owned picker as `/resume` with
      // no argument: show the list, or report no sessions. Opening the picker
      // is state-only and never starts a provider turn on its own.
      if (props.initialResume) {
        if (sessions.length > 0) {
          setSessionPicker({ sessions, selected: 0 });
          setStatus("choose a session to resume");
        } else {
          setMessages((prev) => [...prev, { role: "system", content: "No existing sessions found." }]);
        }
        return;
      }
      if (sessions.length > 0) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `Found ${sessions.length} existing session${sessions.length > 1 ? "s" : ""}. Type /resume to list and continue one, or just type a new prompt to start fresh.`,
          },
        ]);
      }
    });
  });

  useInputRouting({
    renderer,
    setStatus,
    rewindPicker,
    handleRewindKey: rewindController.handleKey,
    modelPicker,
    handleModelPickerKey,
    qualityPicker,
    handleQualityPickerKey,
    sessionPicker,
    handleSessionPickerKey,
    yoloConfirmStage,
    handleYoloKey,
    activePermissionRequest,
    pendingUserQuestion,
    handleQuestionKey,
    pendingQualityDecision,
    handleQualityKey,
    activeGateRequest,
    handleGateKey,
    pasteClipboardImage,
    handleComposerKey,
    handlePromptEscape: handleEscapeAtPrompt,
    handleDecisionPaste,
    insertComposerPaste,
    handleStageMessageKey: (key) => handleStageMessageKey?.(key) ?? false,
    sideQuestionOverlay: sideQuestionController.overlay,
    handleSideQuestionKey: sideQuestionController.handleKey,
    artifactFocusActive: () => focusedArtifactPath() !== null,
    enterArtifactFocus,
    handleArtifactFocusKey,
  });
  /**
   * Slash commands for session management and help. These run locally and
   * never touch the provider:
   *   /resume           list resumable sessions with numeric indices
   *   /resume <n>       resume the nth session from the last /resume list
   *   /resume <id>      resume a session by full id prefix
   *   /model            choose a provider/model interactively
   *   /model <provider> switch to a provider's default model
   *   /model <model>    switch model within the active provider
   *   /model <p> <m>    switch to an exact provider/model pair
   *   /engine [id]      list or switch Prism engines for future turns
   *   /effort <tier>    set thinking effort: off/low/medium/high/xhigh/max/auto
   *   /reasoning <mode> show reasoning: hidden/collapsed/expanded
   *   /artifact [n|path] list or preview generated artifacts
   *   /validate <n|path> validate an artifact file
   *   /new              abandon the current session and start fresh
   *   /help             show available commands
   */
  // Command execution context: the surface slash-command handlers reach
  // through. Built once from component signals/helpers; submitPrompt passes it
  // to executeCommand. See src/tui/commands/.
  const commandContext: CommandContext = {
    setMessages,
    activeProvider,
    activeModel,
    activeModelLimits,
    ensureProviderRegistry,
    applyProviderSelection,
    persistProviderSwitch,
    activeEngine,
    setActiveEngine,
    persistEngineSwitch,
    thinkingTier,
    setThinkingTier,
    persistThinkingSwitch,
    reasoningDisplayMode,
    setReasoningDisplayMode,
    persistReasoningSwitch,
    permissionMode,
    changePermissionMode,
    artifacts,
    refreshArtifacts,
    loadArtifactPreview: (artifact, options) => loadArtifactPreview(process.cwd(), artifact, options),
    setSelectedArtifact,
    setStatus,
    recordActivity,
    setSessionId: (value) => {
      if (typeof value !== "function" && value === undefined) clearQueuedInputs();
      return setSessionId(value);
    },
    setSessionPath,
    setConversation,
    setOutput,
    lastTurnUsage,
    sessionUsage,
    setLastTurnUsage,
    setSessionUsage,
    setPendingGate,
    setPendingEngineSwitch,
    setPendingUserQuestion,
    setResumableSessions,
    setSessionPicker,
    listSessions,
    resumeSession,
    compactSession,
    initProject,
    openRewindPicker: rewindController.open,
    resetRewindState,
    agentCommand,
    startStage: async (characterPath, scenarioPath, commandEcho) => {
      const started = await startStageSession({
        rootDir: process.cwd(),
        characterPath,
        scenarioPath,
        provider: activeProvider(),
        providerId: activeProvider(),
        model: activeModel(),
        permissionMode: permissionMode(),
        reasoningTier: thinkingTier(),
      });
      clearQueuedInputs();
      setSessionId(started.sessionId);
      setSessionPath(started.sessionPath);
      setActiveEngine("stage");
      setConversation(started.messages);
      setOutput(started.opening);
      setLastTurnUsage(undefined);
      setSessionUsage({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, contextInputTokens: 0 });
      setNextSessionParent(null);
      setPendingGate(null);
      setPendingEngineSwitch(null);
      setPendingUserQuestion(null);
      setPendingPermission(null);
      setPendingQualityDecision(null);
      setMessages([
        { role: "user", content: commandEcho },
        ...started.warnings.map((warning) => ({ role: "system" as const, content: `Stage card warning: ${warning}` })),
        { id: started.openingRecordUuid, role: "assistant", content: started.opening, kind: "stage-bootstrap-opening", engine: "stage" },
      ]);
      setStatus("Stage session ready");
      recordActivity({ kind: "system", text: `started Stage session ${started.sessionId}` });
    },
    openModelPicker,
    openQualityPicker,
    openSideQuestion: (args) => sideQuestionController.openSideQuestion(args),
  };

  async function refreshArtifacts(): Promise<ArtifactEntry[]> {
    const entries = await scanArtifacts(process.cwd());
    setArtifacts(entries);
    setSelectedArtifact((selected) => selected && entries.some((entry) => entry.path === selected.path) ? selected : null);
    setFocusedArtifactPath((path) => entries.some((entry) => entry.path === path) ? path : null);
    return entries;
  }

  function enterArtifactFocus(): boolean {
    if (!layout().showSidebar || busy()) return false;
    const path = initialArtifactFocusPath(artifacts(), selectedArtifact()?.path);
    if (!path) return false;
    setFocusedArtifactPath(path);
    return true;
  }

  function handleArtifactFocusKey(key: import("./decision-interaction").TuiKeyEvent): boolean {
    const action = artifactFocusAction(key);
    if (action === "exit") {
      setFocusedArtifactPath(null);
      return true;
    }
    if (action === "previous" || action === "next") {
      setFocusedArtifactPath((path) => artifactFocusPath(artifacts(), path, action === "previous" ? -1 : 1));
      return true;
    }
    if (action === "preview") {
      const path = focusedArtifactPath();
      const index = artifacts().findIndex((artifact) => artifact.path === path);
      if (index >= 0 && !busy()) {
        setFocusedArtifactPath(null);
        void turnController.submitPrompt(`/artifact ${index + 1}`);
      }
      return true;
    }
    return true;
  }

  async function refreshQualityWarnings(targetSessionId = sessionId()): Promise<QualityWarning[]> {
    if (!targetSessionId) {
      setQualityWarnings([]);
      return [];
    }
    const snapshot = await loadSessionSnapshot(process.cwd(), targetSessionId, {
      synthesizeDanglingToolResults: false,
    });
    setQualityWarnings(snapshot.qualityWarnings);
    return snapshot.qualityWarnings;
  }

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={palette.bg}>
      <box height={3} border borderColor={palette.panelBorder} paddingX={1} flexDirection="row">
        <text
          content={headerLine(activeEngine(), layout().width, agentActivitySummary(agentCards()), backgroundProcessActivitySummary(backgroundProcesses()))}
          fg={engineAccent(activeEngine())}
          attributes={1}
          wrapMode="none"
        />
        <Show when={permissionMode() === "YOLO"} fallback={<box width={0} />}>
          <text content={props.dangerouslySkipPermissions ? "  YOLO · CLI OVERRIDE" : "  YOLO"} fg={palette.error} attributes={1} wrapMode="none" />
        </Show>
      </box>

      <Show when={focusedArtifactPath()} fallback={<box height={0} />}>
        {(path) => <ArtifactFocusPreview
          path={path()}
          index={Math.max(0, artifacts().findIndex((artifact) => artifact.path === path()))}
          total={artifacts().length}
          width={layout().width}
        />}
      </Show>

      <box flexDirection="row" flexGrow={1}>
        <Show when={sideQuestionController.overlay()} keyed fallback={<box width={0} />}>
          {(state) => (
            <SideQuestionOverlay
              exchange={sideQuestionController.currentExchange()}
              index={state.exchangeIndex}
              total={sideQuestionController.sessionExchanges(state.sessionId).length}
              mainStatus={sideQuestionController.mainStatusText()}
              width={layout().width}
              height={Math.max(6, dimensions().height - 3 - layout().footerHeight)}
              registerScroller={sideQuestionController.registerAnswerScroller}
            />
          )}
        </Show>

        <Show when={!sideQuestionController.overlay() && layout().showSidebar} fallback={<box width={0} />}>
          <Sidebar
            status={status()}
            thinkingTier={thinkingTier()}
            reasoningMode={reasoningDisplayMode()}
            sessionPath={sessionPath()}
            mcp={mcpStatus()}
            artifacts={artifacts()}
            qualityWarningPaths={qualityWarningPaths()}
            selectedArtifactPath={selectedArtifact()?.path}
            focusedArtifactPath={focusedArtifactPath() ?? undefined}
            agents={agentCards()}
            processes={backgroundProcesses()}
            currentSessionId={sessionId()}
            width={layout().leftPanelWidth}
          />
        </Show>

        <Show when={!sideQuestionController.overlay()} fallback={<box width={0} />}>
          <MessageStream
            messages={messages()}
            streamingReasoning={streamingReasoning()}
            streamingAssistant={streamingAssistant()}
            reasoningMode={reasoningDisplayMode()}
            contentWidth={layout().width - (layout().showSidebar ? layout().leftPanelWidth : 0) - 12}
            agents={agentCards()}
            activeEngine={activeEngine()}
            sessionId={sessionId()}
            onStageViewChange={(id, source) => setMessages((current) => current.map((message) => message.id === id ? { ...message, stageSource: source } : message))}
            registerStageKeyHandler={(handler) => { handleStageMessageKey = handler; }}
          />
        </Show>

        {/* The former right-hand Activity / Artifacts pane was removed in the
            TUI rewrite. Agent-loop activity and artifact detail now fold into
            the message stream itself (tool-call rendering, Phase D). The left
            Workspace sidebar holds the persistent artifact list. */}
      </box>

      <Show when={!sideQuestionController.overlay()} fallback={<box height={0} />}>
        <BottomSurface
        layout={layout()}
        yoloStage={yoloConfirmStage()}
        permissionRequest={activePermissionRequest()}
        question={pendingUserQuestion()}
        quality={pendingQualityDecision()}
        gate={gateWithQualityWarning()}
        rewind={rewindPicker()}
        session={sessionPicker()}
        qualityPicker={qualityPicker()}
        model={modelPicker()}
        gateFocus={gateFocus()}
        gateFeedbackMode={gateFeedbackMode()}
        gateFeedback={gateFeedback()}
        gateFeedbackCursor={gateFeedbackCursor()}
        engineSwitchPending={Boolean(pendingEngineSwitch())}
        questionSelected={questionSelected()}
        qualitySelected={qualitySelected()}
        questionFreeformText={questionFreeformText()}
        questionFreeformCursor={questionFreeformCursor()}
        modelItems={modelPickerItems()}
        modelTitle={modelPickerTitle()}
        qualityPickerItems={qualityPickerItems()}
        qualityPickerTitle={qualityPickerTitle()}
        commandMenuOpen={commandMenuOpen()}
        commandItems={commandMenuItems()}
        commandSelected={commandMenuSelected()}
        commandArgumentMenuOpen={commandArgumentMenuOpen()}
        commandArgumentItems={commandArgumentItems()}
        commandArgumentSelected={commandArgumentSelected()}
        commandArgumentDraft={commandArgumentDraft()}
        composerPopupMaxRows={composerPopupMaxRows()}
        composerPopupOpen={composerPopupOpen()}
        inputNeedsExpandedBottom={inputNeedsExpandedBottom()}
        inputValue={inputValue()}
        inputCursor={inputCursor()}
        inputWidth={composerInputWidth()}
        busy={busy()}
        queuedInputs={queuedInputs()}
        providerConfigReady={providerConfigReady()}
      />
      </Show>
      <box height={layout().footerHeight} paddingLeft={1}>
        <text
          content={footerLine(activeProvider(), activeModel(), providerHasApiKey(), layout().width, lastTurnUsage(), sessionUsage(), activeModelLimits())}
          fg={palette.textMuted}
          wrapMode="none"
        />
      </box>
    </box>
  );
}
