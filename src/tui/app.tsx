import { ThemedText } from "./theme-text";
import { createEffect, createMemo, createSignal, Show, onCleanup, onMount } from "solid-js";
import { useRenderer, useTerminalDimensions } from "@3akhp/opentui-solid";
import { loadEngineProfile, type EngineId } from "../core/engine/profile";
import type { VesicleMessage } from "../providers/shared/types";
import type { ReasoningTier } from "../providers/shared/types";
import { engineAccent, palette, reportTerminalThemeMode, themePreference } from "./theme";
import { createThemeScheduler } from "./theme-runtime";
import { createThemePreferenceController, parseEnvTheme, type ThemePreferenceController } from "./theme-preference-controller";
import { createWebSearchController, type WebSearchController } from "./web-search-controller";
import { clearSessionWebSearchOverride } from "../core/agent-loop/web-search-state";
import { listSessions, loadSessionSnapshot, loadSessionRecords, projectSessionTitle, appendSessionTitle, resetSessionTitleGeneration } from "../core/session/store";
import type { ReasoningDisplayMode, SessionSummary } from "../core/session/store";
import { createTurnFocusController } from "./turn-focus-controller";
import { loadArtifactPreview, scanArtifacts } from "../core/artifacts/workbench";
import type { ArtifactEntry } from "../core/artifacts/workbench";
import type { QualityWarning } from "../core/quality";
import { resolveTuiLayout } from "./layout";
import { resolveSplashMode, type SplashMode } from "./brand-mark";
import { Splash } from "./widgets/Splash";
import { Sidebar } from "./views/Sidebar";
import { MessageStream } from "./views/MessageStream";
import { rewindPickerPanelHeight } from "./RewindPicker";
import { branchPickerPanelHeight } from "./BranchPicker";
import { createBranchController } from "./branch/controller";
import { yoloPanelHeight } from "./YoloPrompt";
import { migrationPanelHeight } from "./MigrationPrompt";
import { createSessionMigrationController, type MigrationReviewState } from "./session-migration-controller";
import { qualityRewritePanelHeight } from "./QualityRewritePrompt";
import { createBuiltinCommands } from "./commands/builtin";
import { executeCommand } from "./commands/dispatch";
import type { BuiltinCommandContexts, Command } from "./commands/types";
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
  workspaceHeaderLine,
  latestTurnUsage,
  sessionUsageTelemetryLine,
  sumSessionUsage,
  turnUsageTelemetryLine,
  type TokenUsageSummary,
} from "./telemetry";
import { displayTranscriptFromSnapshot, isEmptySessionTranscript } from "./session-presenter";
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
import { artifactFocusAction, artifactFocusPath, initialArtifactFocusPath } from "./artifact-focus";
import { ArtifactFocusPreview } from "./widgets/ArtifactFocusPreview";
import { createInputQueue } from "./input-queue";
import { routeCommandSubmission } from "./command-scheduler";
import { createSideQuestionController } from "./side-question-controller";
import { createSkillPickerController } from "./skill-picker-controller";
import { createWorkspaceController } from "./workspace";
import { createQueuedWorkController } from "./queued-work-controller";
import { createStageSessionController } from "./stage-session-controller";
import { createStartupController } from "./startup-controller";

import { initializeSessionIdentity, type SessionIdentity } from "../core/agent-loop/session-init";
import { createSessionIdentityCoordinator } from "./session-identity-coordinator";
import { createSkillActivationOwner, type SkillActivationOptions } from "./skills/session-activation";
import { SideQuestionOverlay } from "./views/SideQuestionOverlay";
import { WorkspacePage } from "./workspace/view";
import { copyTextToClipboard } from "./clipboard";
import { closeAllProviderSessions, closeProviderSession } from "../providers/lifecycle";
import { registerHostShutdownCleanup } from "../core/process/shutdown";
import { resolveTerminalTitlePhase, type TerminalTitleController } from "./terminal-title";
import { basename } from "node:path";

export type AppProps = {
  dangerouslySkipPermissions?: boolean;
  initialResume?: boolean;
  bootstrapOnly?: boolean;
  /** Explicit startup-splash mode for deterministic host and test rendering. */
  splashMode?: SplashMode;
  /** Effective theme-preference owner (source precedence, session override, project persistence). */
  theme?: ThemePreferenceController;
  /** Called after the renderer has been destroyed to finish a CLI TUI exit. */
  onExit?: () => void;
  terminalTitle?: TerminalTitleController;
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
  const exitTui = props.onExit ?? (() => {});
  const terminalTitle = props.terminalTitle;
  terminalTitle?.attach(renderer);
  let terminalTitleLive = true;
  // The controller is constructed in runTui/setup before the first frame. Tests
  // that mount App directly fall back to an env-only controller (no project
  // read) so the palette and `/theme` still work without async I/O on mount.
  const themeController: ThemePreferenceController = props.theme
    ?? createThemePreferenceController({
      rootDir: process.cwd(),
      envParse: parseEnvTheme(process.env.VESICLE_THEME),
      project: {},
    });
  // runTui/runGuidedSetup already applied the startup preference before render;
  // only the test fallback controller (props.theme absent) needs it here.
  if (!props.theme) themeController.applyStartup();
  onMount(() => {
    if (props.bootstrapOnly) {
      process.nextTick(() => {
        terminalTitle?.clear();
        renderer.destroy();
        exitTui();
      });
    }
  });
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
  // Populated after the domain contexts are wired (later in this component); the
  // completion controller reads it reactively, and the signal avoids TDZ on the
  // late-initialised command list during the initial render pass.
  const [builtinCommands, setBuiltinCommands] = createSignal<readonly Command[]>([]);
  const [messages, setMessages] = createSignal<Message[]>([
    ...(props.dangerouslySkipPermissions ? [{
      role: "system" as const,
      content: "DANGER: --dangerously-skip-permissions enabled YOLO for this process. Tool approvals are bypassed; runtime hard guards remain active.",
    }] : []),
    ...(() => {
      // Surface bounded startup diagnostics (invalid env / invalid project preference).
      const diagnostics = themeController.startupDiagnostics();
      return diagnostics.map((text) => ({ role: "system" as const, content: text }));
    })(),
  ]);
  const [status, setStatus] = createSignal("loading provider config");
  const [sessionPath, setSessionPath] = createSignal("no session yet");
  const [sessionId, setSessionId] = createSignal<string | undefined>();
  let titleEffectGeneration = 0;
  createEffect(() => {
    const id = sessionId();
    const engine = activeEngine();
    const generation = ++titleEffectGeneration;
    if (!id) {
      terminalTitle?.setSession(engine, undefined, basename(process.cwd()));
      return;
    }
    void loadSessionSnapshot(process.cwd(), id, { synthesizeDanglingToolResults: false })
      .then((snapshot) => {
        if (!terminalTitleLive || generation !== titleEffectGeneration || sessionId() !== id || activeEngine() !== engine) return;
        // The reactive engine signal is the current host selection; the
        // snapshot engine may lag while an /engine host record is being saved.
        terminalTitle?.setSession(engine, snapshot.title?.title, basename(process.cwd()));
      })
      .catch(() => {
        if (terminalTitleLive && generation === titleEffectGeneration && sessionId() === id && activeEngine() === engine) {
          terminalTitle?.setSession(engine, undefined, basename(process.cwd()));
        }
      });
  });
  onCleanup(() => {
    terminalTitleLive = false;
    titleEffectGeneration++;
    terminalTitle?.clear();
  });
  let providerResourceSessionId: string | undefined;
  createEffect(() => {
    const current = sessionId();
    if (providerResourceSessionId && providerResourceSessionId !== current) {
      closeProviderSession(providerResourceSessionId);
    }
    providerResourceSessionId = current;
  });
  const [conversation, setConversation] = createSignal<VesicleMessage[]>([]);
  const [, setOutput] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const inputQueue = createInputQueue();
  const [restoringSession, setRestoringSession] = createSignal(false);
  // M1 startup splash: the mode is decided once from terminal capabilities and
  // environment; "skip" (non-interactive terminal) never mounts the overlay.
  const splashMode = props.splashMode ?? resolveSplashMode({
    isTty: Boolean(process.stdout.isTTY),
    rgb: renderer.capabilities?.rgb ?? true,
    reducedMotion: process.env.VESICLE_REDUCED_MOTION === "1",
  });
  const [splashGone, setSplashGone] = createSignal(splashMode === "skip");
  const [splashForceDone, setSplashForceDone] = createSignal(false);
  // M2: the empty-session hero shows only while the stream holds no real
  // conversation. The invariant (isEmptySessionTranscript) is "no user prompt,
  // assistant reply, tool activity, or compact summary has appeared yet" —
  // startup notices (the YOLO warning, "fresh session", etc.) are system
  // messages without a kind and may render above the hero, but a compact summary
  // or any turn makes this a live transcript. Deriving this from an explicit
  // conversation contract (instead of only "every visible role is system")
  // prevents a future system-role record from recreating the post-compact Hero
  // regression (issue #107 PR2 addendum).
  const showHero = createMemo(() => !restoringSession() && isEmptySessionTranscript(messages()));

  // Day/night theme. The effective preference (and its source) is applied
  // before the first frame by the controller in runTui/setup. Here the shell
  // subscribes to live terminal mode reports and owns the `auto` boundary
  // timer; the reactive palette authority stays in theme.ts.
  const reportedTheme = renderer.themeMode;
  if (reportedTheme) reportTerminalThemeMode(reportedTheme);
  void renderer.waitForThemeMode(500).then((detected) => {
    if (detected) reportTerminalThemeMode(detected);
  });
  renderer.on("theme_mode", reportTerminalThemeMode);
  // One owner for the `auto` boundary timer. It re-evaluates whenever the
  // effective preference changes and cancels itself when leaving `auto`.
  const themeScheduler = createThemeScheduler();
  createEffect(() => {
    themePreference();
    themeScheduler.schedule();
  });
  onCleanup(() => themeScheduler.dispose());
  const [, setResumableSessions] = createSignal<SessionSummary[]>([]);
  const [sessionPicker, setSessionPicker] = createSignal<SessionPickerState | null>(null);
  const [migrationReview, setMigrationReview] = createSignal<MigrationReviewState | null>(null);
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
    closeActiveProviderSession: () => {
      const id = sessionId();
      if (id) closeProviderSession(id);
    },
    clearWebSearchOverride: () => {
      const id = sessionId();
      if (id) clearSessionWebSearchOverride(id);
    },
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
  const branchController = createBranchController({
    rootDir: process.cwd(),
    sessionId,
    busy,
    setStatus,
    applySwitch: (toLeaf) => turnController.switchToCandidate(toLeaf),
    regenerateAt: (forkUuid) => turnController.regenerateTurn(forkUuid),
  });
  const branchPicker = branchController.state;
  const turnFocus = createTurnFocusController({
    rootDir: process.cwd(),
    sessionId,
    messages,
    busy,
    setStatus,
    setMessages,
  });
  function submitCommand(raw: string): boolean {
    return routeCommandSubmission(raw, busy(), builtinCommands(), {
      execute: (value) => {
        void executeCommand(value, builtinCommands(), { setMessages }).catch((error) => turnController.reportError(error));
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
  const workspaceController = createWorkspaceController(process.cwd(), {
    onExternalEditorReturn: () => {
      if (terminalTitleLive) terminalTitle?.reproject();
    },
  });
  const composerController = createComposerController({
    rootDir: process.cwd(),
    commands: builtinCommands,
    activeEngine,
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
    listWorkspaceTargets: () => workspaceController.listWorkspaceTargets(),
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
      if (aborted) queuedWork.markInterruptRequested();
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
    setHistoryIndex,
    setInputImages,
    setPromptHistory,
  } = composerController;
  const qualityPickerController = createQualityPickerController({
    providerRegistry,
    ensureProviderRegistry,
    activeProvider,
    activeModel,
    setStatus,
    setMessages,
    reportError: (error) => turnController.reportError(error),
  });
  const {
    qualityPicker,
    qualityRewriteConfirm,
    qualityPickerItems,
    qualityPickerTitle,
    handleQualityPickerKey,
    handleRewriteConfirmKey,
    openQualityPicker,
    openRewriteConfirm,
  } = qualityPickerController;
  const skillPickerController = createSkillPickerController({
    rootDir: process.cwd(),
    env: process.env,
    activeEngineProfile: () => ({ id: activeEngine() }),
    contextWindow: () => activeModelLimits()?.contextWindow,
    setStatus,
    setMessages,
    reportError: (error) => turnController.reportError(error),
    onActivate: (name) => activateSkill(name, { mode: "context-only" }),
  });
  const {
    skillPicker,
    skillPickerItems,
    skillPickerTitle,
    handleSkillPickerKey,
    openSkillPicker,
  } = skillPickerController;
  const unsubscribeProcesses = processManager.subscribe(handleBackgroundProcessEvent);
  let shutdownHostResourcesPromise: Promise<void> | undefined;
  const shutdownHostResources = () => {
    shutdownHostResourcesPromise ??= (async () => {
      unsubscribeProcesses();
      try {
        await processManager.shutdown();
      } finally {
        sideQuestionController.dispose();
      }
    })();
    return shutdownHostResourcesPromise;
  };
  const unregisterHostShutdown = registerHostShutdownCleanup(shutdownHostResources);
  onCleanup(() => {
    void shutdownHostResources()
      .catch(() => undefined)
      .finally(() => {
        unregisterHostShutdown();
        closeAllProviderSessions();
      });
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
  // Two-page shell (Scope B): page state outlives the per-page components.
  const workspaceActive = () => workspaceController.activePage() === "workspace";
  function switchPage(): void {
    setFocusedArtifactPath(null);
    workspaceController.togglePage();
  }
  const queuedWork = createQueuedWorkController({
    rootDir: process.cwd(),
    inputQueue,
    canDrain: () => !restoringSession()
      && !busy()
      && !pendingGate()
      && !pendingEngineSwitch()
      && !pendingUserQuestion()
      && !pendingPermission()
      && !pendingQualityDecision()
      && !pendingChildPermission()
      && !rewindPicker()
      && !branchPicker()
      && !sessionPicker()
      && !skillPicker()
      && !modelPicker()
      && !qualityPicker()
      && !qualityRewriteConfirm()
      && !yoloConfirmStage()
      && !migrationReview(),
    agentCards,
    setConversation,
    setMessages,
    setStatus,
    recordActivity,
    recordPromptHistory,
    submitPrompt: (value, images, elements) => turnController.submitPrompt(value, images, elements),
    executeLocalCommand: (raw) => executeCommand(raw, builtinCommands(), { setMessages }),
    reportError: (error) => turnController.reportError(error),
  });
  turnController = createTurnController({
    rootDir: process.cwd(),
    dangerouslySkipPermissions: props.dangerouslySkipPermissions === true,
    busy,
    setBusy,
    queuedWork,
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
    setSessionPath,
    conversation,
    setConversation,
    nextSessionParent,
    setNextSessionParent,
    setOutput,
    setStatus,
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
    onSessionTitleChanged: (title, titleSessionId) => {
      if (sessionId() !== titleSessionId) return;
      terminalTitle?.setSession(activeEngine(), title, basename(process.cwd()));
    },
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
    executeLocalCommand: (prompt) => executeCommand(prompt, builtinCommands(), { setMessages }),
    recordPromptHistory,
    applyComposerState,
    composerValue: inputValue,
    setInputImages,
    setHistoryIndex,
    setPromptHistory,
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
  const migrationController = createSessionMigrationController({
    rootDir: process.cwd(),
    migrationReview,
    setMigrationReview,
    setStatus,
    reportError: turnController.reportError,
    // Deferred through the `let resumeSession!` binding below: the handler only
    // runs after both controllers are constructed.
    resumeSession: (target, commandEcho) => resumeSession(target, commandEcho),
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
    clearThemeOverride: () => themeController.clearOverride(),
    clearWebSearchOverride: () => webSearchController.clearOverride(),
    beginMigrationReview: migrationController.beginMigrationReview,
    onSessionActive: (id) => {
      void sideQuestionController.rebuildForResume(id).catch(reportError);
      // Re-arm the candidate switcher so `<n/m>` and Option+←/→ survive reload.
      void turnController.refreshCandidateSwitcher(id).catch(reportError);
    },
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
  const startupController = createStartupController({
    dangerouslySkipPermissions: props.dangerouslySkipPermissions === true,
    initialResume: props.initialResume === true,
    refreshArtifacts,
    recoverInterruptedAgents: () => agentStore.recoverInterrupted(),
    notifyContinuation: (id) => continuationScheduler.notify(id),
    refreshMcpStatus,
    loadPermissionSettings: loadPermissionSettingsOnce,
    loadProviderConfig: loadProviderConfigOnce,
    setProviderConfigReady,
    listSessions,
    setResumableSessions,
    setSessionPicker,
    setMessages,
    setStatus,
    reportError,
  });
  const stageSessionController = createStageSessionController({
    rootDir: process.cwd(),
    activeProvider,
    activeModel,
    permissionMode,
    reasoningTier: thinkingTier,
    clearQueuedInputs,
    setSessionId,
    setSessionPath,
    setActiveEngine,
    setConversation,
    setOutput,
    setLastTurnUsage,
    setSessionUsage,
    setNextSessionParent,
    setPendingGate,
    setPendingEngineSwitch,
    setPendingUserQuestion,
    setPendingPermission,
    setPendingQualityDecision,
    setMessages,
    setStatus,
    recordActivity,
  });
  createEffect(() => {
    const id = sessionId();
    const ready = !restoringSession() && !busy() && !pendingGate() && !pendingEngineSwitch() && !pendingUserQuestion() && !pendingPermission() && !pendingQualityDecision() && !pendingChildPermission();
    if (id && ready) void continuationScheduler.notify(id).catch(reportError);
  });
  createEffect(() => {
    const inputRequired = Boolean(
      pendingGate()
      || pendingEngineSwitch()
      || pendingUserQuestion()
      || pendingPermission()
      || pendingQualityDecision()
      || pendingChildPermission()
      || yoloConfirmStage()
      || migrationReview()
      || qualityRewriteConfirm(),
    );
    terminalTitle?.setPhase(resolveTerminalTitlePhase({ inputRequired, busy: busy(), restoring: restoringSession() }));
  });

  const layout = createMemo(() => resolveTuiLayout(
    dimensions().width,
    dimensions().height,
    Boolean(pendingGate()) || Boolean(pendingEngineSwitch()) || Boolean(pendingUserQuestion()) || Boolean(pendingPermission()) || Boolean(pendingQualityDecision()) || Boolean(pendingChildPermission()) || Boolean(yoloConfirmStage()) || Boolean(qualityRewriteConfirm()) || Boolean(migrationReview()),
    Boolean(sessionPicker()) || Boolean(rewindPicker()) || Boolean(branchPicker()) || Boolean(skillPicker()) || Boolean(modelPicker()) || Boolean(qualityPicker()) || inputNeedsExpandedBottom(),
    yoloConfirmStage()
      ? Math.max(decisionPanelMinHeight(), yoloPanelHeight(yoloConfirmStage()!, dimensions().width))
      : migrationReview()
        ? Math.max(decisionPanelMinHeight(), migrationPanelHeight(migrationReview()!, dimensions().width))
        : qualityRewriteConfirm()
          ? Math.max(decisionPanelMinHeight(), qualityRewritePanelHeight(
            qualityRewriteConfirm()!.stage,
            qualityRewriteConfirm()!.candidate.providerAlias,
            qualityRewriteConfirm()!.candidate.modelId,
            qualityRewriteConfirm()!.candidate.judgeTimeoutMs,
            dimensions().width,
          ))
          : decisionPanelMinHeight(),
    rewindPicker() ? rewindPickerPanelHeight(rewindPicker()!) : branchPicker() ? branchPickerPanelHeight(branchPicker()!) : 8,
    rewindPicker() ? rewindPickerPanelHeight(rewindPicker()!) : branchPicker() ? branchPickerPanelHeight(branchPicker()!) : 12,
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

  onMount(() => {
    void startupController.start();
  });

  useInputRouting({
    renderer,
    beforeExit: () => terminalTitle?.clear(),
    onExit: exitTui,
    setStatus,
    splashActive: () => !splashGone(),
    dismissSplash: () => setSplashForceDone(true),
    rewindPicker,
    handleRewindKey: rewindController.handleKey,
    branchPicker,
    handleBranchKey: branchController.handleKey,
    modelPicker,
    handleModelPickerKey,
    qualityPicker,
    handleQualityPickerKey,
    qualityRewriteConfirm,
    handleRewriteConfirmKey,
    sessionPicker,
    handleSessionPickerKey,
    skillPicker,
    handleSkillPickerKey,
    yoloConfirmStage,
    handleYoloKey,
    migrationReview,
    handleMigrationKey: migrationController.handleMigrationKey,
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
    busy,
    handleDecisionPaste,
    insertComposerPaste,
    handleStageMessageKey: (key) => handleStageMessageKey?.(key) ?? false,
    triggerRegenerate: () => void turnController.regenerateTurn(turnFocus.focusedTurn() ?? undefined),
    triggerBranch: () => void branchController.open(),
    onRejectedCandidateSwitch: turnFocus.rejectCandidateSwitch,
    sideQuestionOverlay: sideQuestionController.overlay,
    handleSideQuestionKey: sideQuestionController.handleKey,
    artifactFocusActive: () => focusedArtifactPath() !== null,
    enterArtifactFocus,
    handleArtifactFocusKey,
    togglePage: switchPage,
    workspaceActive,
    workspaceFocusRegion: workspaceController.focusRegion,
    workspaceEditableSourcePasteActive: workspaceController.editableSourcePasteActive,
    handleWorkspaceKey: workspaceController.handleKey,
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
  // Command dispatch is fire-and-forget, so two rapid /skill commands share one
  // lazy identity. The coordinator releases a resolved identity and /new resets
  // it so later activations cannot revive an abandoned session.
  const sessionIdentityCoordinator = createSessionIdentityCoordinator({
    currentSessionId: sessionId,
    initialize: async (): Promise<SessionIdentity> => {
      // Mirror turn-controller's ensureRuntimeReady: the identity header needs a
      // resolved provider selection and effective permission settings, and the
      // active provider/model signals start as "loading" before config resolves.
      if (!providerConfigReady()) {
        setStatus("loading provider config");
        await loadProviderConfigOnce();
      }
      if (!permissionSettingsReady()) {
        setStatus("loading permission settings");
        await loadPermissionSettingsOnce();
      }
      return initializeSessionIdentity({
        engine: activeEngine(),
        rootDir: process.cwd(),
        providerSelection: activeProviderSelection(),
        generation: activeGeneration(),
        permission: {
          mode: permissionMode(),
          ...(props.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true as const } : {}),
          shellExecEnabled: shellExecEnabled(),
          shellInterpreter: shellInterpreter(),
        },
      });
    },
    apply: (identity) => {
      setSessionId(identity.sessionId);
      setSessionPath(identity.sessionPath);
    },
  });
  const skillActivation = createSkillActivationOwner({
    rootDir: process.cwd(),
    sessionIdentity: { ensure: () => sessionIdentityCoordinator.ensure() },
    activeEngine,
    activeModelLimits,
    branchParent: nextSessionParent,
    setBranchParent: setNextSessionParent,
    onNotice: (card) => setMessages((prev) => [...prev, { role: "system", content: card }]),
    submitTurn: (prompt) => turnController.submitPrompt(prompt),
  });
  // Function declaration (hoisted like the pre-T1 use case) so the picker's
  // onActivate closure cannot trip a TDZ regardless of construction order;
  // it only runs post-render, when skillActivation is initialized.
  async function activateSkill(name: string, options: SkillActivationOptions): Promise<void> {
    return skillActivation.activate(name, options);
  }

  // Slash-command domain contexts: each command family receives only the
  // fields it reads, built from component signals/helpers. createBuiltinCommands
  // composes the per-family factories into the registry the dispatcher and the
  // completion controller consume. See src/tui/commands/.
  const webSearchController: WebSearchController = createWebSearchController({
    getSessionId: () => sessionId(),
    getEngineProfile: () => loadEngineProfile(activeEngine(), process.cwd()),
    getModelView: () => {
      const provider = providerRegistry()
        ?.providers.find((candidate) => candidate.id === activeProvider());
      const model = provider?.models.find((candidate) => candidate.id === activeModel());
      return {
        ...model,
        provider: provider?.protocol,
        responsesProfile: provider?.responsesProfile,
      };
    },
  });
  const commandContexts: BuiltinCommandContexts = {
    provider: {
      setMessages, setStatus, recordActivity,
      activeProvider, activeModel,
      activeModelGeneration: () => providerRegistry()
        ?.providers.find((provider) => provider.id === activeProvider())
        ?.models.find((model) => model.id === activeModel())
        ?.generation,
      activeModelLimits,
      ensureProviderRegistry,
      applyProviderSelection,
      persistProviderSwitch,
      openModelPicker,
      thinkingTier, setThinkingTier, persistThinkingSwitch,
      reasoningDisplayMode, setReasoningDisplayMode, persistReasoningSwitch,
      lastTurnUsage, sessionUsage,
    },
    engine: {
      setMessages, setStatus, recordActivity,
      activeEngine, setActiveEngine, persistEngineSwitch, compactSession,
    },
    session: {
      setMessages, setStatus, recordActivity,
      activeEngine, setActiveEngine,
      setSessionId: (value) => {
        if (typeof value !== "function" && value === undefined) {
          sessionIdentityCoordinator.reset();
          clearQueuedInputs();
        }
        return setSessionId(value);
      },
      setSessionPath, setConversation, setOutput,
      setLastTurnUsage, setSessionUsage,
      setPendingGate, setPendingEngineSwitch, setPendingUserQuestion,
      setResumableSessions, setSessionPicker,
      listSessions, resumeSession,
      compactSession, initProject,
      openRewindPicker: rewindController.open,
      openBranchPicker: branchController.open,
      resetRewindState,
      theme: { clearOverride: () => themeController.clearOverride() },
      webSearch: { clearOverride: () => webSearchController.clearOverride() },
      title: {
        sessionId,
        current: async () => {
          const id = sessionId();
          if (!id) return {};
          const title = projectSessionTitle(await loadSessionRecords(process.cwd(), id));
          return title ? { title: title.title, source: title.source } : {};
        },
        rename: async (value) => {
          const id = sessionId();
          if (!id) throw new Error("No active session.");
          await appendSessionTitle(process.cwd(), id, value, "user");
          const title = projectSessionTitle(await loadSessionRecords(process.cwd(), id));
          terminalTitle?.setSession(activeEngine(), title?.title, basename(process.cwd()));
        },
        regenerate: async () => {
          const id = sessionId();
          if (!id) throw new Error("No active session.");
          await resetSessionTitleGeneration(process.cwd(), id);
        },
      },
    },
    quality: {
      setMessages, setStatus, recordActivity,
      openQualityPicker,
      openQualityRewriteConfirm: openRewriteConfirm,
      ensureProviderRegistry,
      activeProvider, activeModel,
    },
    skills: {
      setMessages,
      openSkillPicker,
      activateSkill: (name, options) => activateSkill(name, options),
    },
    workspace: {
      setMessages, setStatus, recordActivity,
      openWorkspaceTarget: async (relPath?: string) => {
        setFocusedArtifactPath(null);
        return workspaceController.openWorkspaceTarget(relPath);
      },
      refreshArtifacts,
      loadArtifactPreview: (artifact, options) => loadArtifactPreview(process.cwd(), artifact, options),
      setSelectedArtifact,
    },
    theme: {
      setMessages, setStatus, recordActivity,
      theme: {
        statusText: () => themeController.statusText(),
        applyOverride: (pref) => themeController.applyOverride(pref),
        clearOverride: () => themeController.clearOverride(),
        persistProject: (pref) => themeController.persistProject(pref),
        unsetProject: () => themeController.unsetProject(),
      },
    },
    webSearch: {
      setMessages, setStatus, recordActivity,
      webSearch: {
        statusText: () => webSearchController.statusText(),
        applyOverride: (enabled) => webSearchController.applyOverride(enabled),
        clearOverride: () => webSearchController.clearOverride(),
      },
    },
    agents: {
      setMessages,
      agentCommand,
      startStage: stageSessionController.start,
      openSideQuestion: (args) => sideQuestionController.openSideQuestion(args),
    },
    permissions: {
      setMessages,
      permissionMode,
      changePermissionMode,
    },
    help: {
      setMessages,
    },
  };
  setBuiltinCommands(createBuiltinCommands(commandContexts));

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
        <ThemedText
          content={workspaceActive()
            ? workspaceHeaderLine(process.cwd(), layout().width)
            : headerLine(activeEngine(), layout().width, agentActivitySummary(agentCards()), backgroundProcessActivitySummary(backgroundProcesses()))}
          fg={workspaceActive() ? palette.brand : engineAccent(activeEngine())}
          attributes={1}
          wrapMode="none"
        />
        <Show when={permissionMode() === "YOLO"} fallback={<box width={0} />}>
          <ThemedText content={props.dangerouslySkipPermissions ? "  YOLO · CLI OVERRIDE" : "  YOLO"} fg={palette.error} attributes={1} wrapMode="none" />
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

        <Show when={!sideQuestionController.overlay() && !workspaceActive() && layout().showSidebar} fallback={<box width={0} />}>
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

        <Show when={!sideQuestionController.overlay() && !workspaceActive()} fallback={<box width={0} />}>
          <MessageStream
            messages={messages()}
            streamingReasoning={streamingReasoning()}
            streamingAssistant={streamingAssistant()}
            reasoningMode={reasoningDisplayMode()}
            contentWidth={layout().width - (layout().showSidebar ? layout().leftPanelWidth : 0) - 12}
            agents={agentCards()}
            activeEngine={activeEngine()}
            sessionId={sessionId()}
            showHero={showHero()}
            onStageViewChange={(id, source) => setMessages((current) => current.map((message) => message.id === id ? { ...message, stageSource: source } : message))}
            registerStageKeyHandler={(handler) => { handleStageMessageKey = handler; }}
            candidateSwitcher={turnController.candidateSwitcher}
            onCandidateSwitch={(direction) => turnController.switchCandidate(direction)}
            onCandidateSwitchRejected={turnFocus.rejectCandidateSwitch}
            turnAnchors={turnFocus.turnAnchors}
            focusedTurn={turnFocus.focusedTurn}
            onFocusTurn={turnFocus.setFocusedTurn}
          />
        </Show>

        {/* Workspace page (Scope B / #62): the second top-level surface. The
            side-question overlay still wins the main row while open; gate and
            picker surfaces stay shared at the bottom so a turn's safety
            prompts remain reachable from either page. */}
        <Show when={!sideQuestionController.overlay() && workspaceActive()} fallback={<box width={0} />}>
          <WorkspacePage
            controller={workspaceController}
            projectRoot={process.cwd()}
            width={layout().width}
            height={Math.max(6, dimensions().height - 3 - layout().footerHeight)}
            treeWidth={layout().leftPanelWidth}
            compact={layout().mode === "compact"}
          />
        </Show>

        {/* The former right-hand Activity / Artifacts pane was removed in the
            TUI rewrite. Agent-loop activity and artifact detail now fold into
            the message stream itself (tool-call rendering, Phase D). The left
            Host sidebar holds the persistent artifact list. */}
      </box>

      <Show when={!sideQuestionController.overlay()} fallback={<box height={0} />}>
        <BottomSurface
        layout={layout()}
        composerFocused={!workspaceActive() || workspaceController.focusRegion() === "composer"}
        yoloStage={yoloConfirmStage()}
        migrationReview={migrationReview()}
        permissionRequest={activePermissionRequest()}
        question={pendingUserQuestion()}
        quality={pendingQualityDecision()}
        gate={gateWithQualityWarning()}
        rewind={rewindPicker()}
        branch={branchPicker()}
        session={sessionPicker()}
        skillPicker={skillPicker()}
        qualityPicker={qualityPicker()}
        qualityRewriteConfirm={qualityRewriteConfirm()}
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
        skillPickerItems={skillPickerItems()}
        skillPickerTitle={skillPickerTitle()}
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
        <ThemedText
          content={footerLine(activeProvider(), activeModel(), providerHasApiKey(), layout().width, lastTurnUsage(), sessionUsage(), activeModelLimits())}
          fg={palette.textMuted}
          wrapMode="none"
        />
      </box>

      {/* M1 startup splash: absolute overlay painted above the shell. It owns
          the only continuous motion in the app and unmounts cleanly once the
          session surface is ready — nothing persists below the transcript. */}
      <Show when={!splashGone()} fallback={<box width={0} height={0} />}>
        <Splash
          mode={splashMode === "skip" ? "static" : splashMode}
          ready={providerConfigReady}
          forceDone={splashForceDone}
          width={dimensions().width}
          height={dimensions().height}
          onGone={() => setSplashGone(true)}
        />
      </Show>
    </box>
  );
}
