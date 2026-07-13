import { createEffect, createMemo, createSignal, Show, onCleanup, onMount } from "solid-js";
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { inspectProviderConfig } from "../config/providers";
import { loadPermissionSettings } from "../config/permissions";
import type { ProviderRegistry, ProviderSelection } from "../config/providers";
import type { ModelCapabilities, ModelLimits } from "../config/env";
import { inspectMcpConfig } from "../mcp/registry";
import { resolveEngineSwitch, resolveGate, resolvePermission, resolveUserQuestion, runPrompt } from "../core/agent-loop/run";
import type { RunPromptResult } from "../core/agent-loop/run";
import type { AgentLoopEvent } from "../core/agent-loop/run";
import type { EngineId } from "../core/engine/profile";
import type { EngineSwitchRequest } from "../core/engine/switch";
import { ENGINE_HANDOFF_KIND, renderEngineHandoffPacket } from "../core/engine/transition";
import type { EngineTransition } from "../core/engine/transition";
import type { UserQuestionAnswer } from "../core/user-question/types";
import type { ResponseUsage, VesicleImageAttachment, VesicleMessage } from "../providers/shared/types";
import type { ReasoningTier } from "../providers/shared/types";
import { displayTextFromThinkingBlocks } from "../providers/shared/thinking";
import type { GateRequest, GateResolution } from "../core/gate/types";
import { compactConversation } from "../core/compact/service";
import { copySelectionToClipboard, readImageFromClipboard } from "./clipboard";
import { engineAccent, engineDisplayName, palette } from "./theme";
import { GatePrompt, engineSwitchGateFocusOrder, gateComposerIsActive, gateFocusOrder, gateResolutionFromState, gateSummaryLineBudget } from "./GatePrompt";
import type { GateFocusTarget } from "./GatePrompt";
import { createSessionStore, listSessions, loadSessionSnapshot } from "../core/session/store";
import type { ReasoningDisplayMode, ResumedMessage, SessionSummary } from "../core/session/store";
import { loadArtifactPreview, scanArtifacts } from "../core/artifacts/workbench";
import type { ArtifactEntry } from "../core/artifacts/workbench";
import { resolveTuiLayout } from "./layout";
import { truncateLine, truncateMiddle } from "./format";
import { Sidebar } from "./views/Sidebar";
import type { SidebarMcpState } from "./views/Sidebar";
import { MessageStream } from "./views/MessageStream";
import { SessionPicker } from "./SessionPicker";
import { RewindPicker, rewindPickerPanelHeight } from "./RewindPicker";
import { QuestionPrompt, questionComposerIsActive, questionPanelMinHeight } from "./QuestionPrompt";
import { PromptComposer } from "./PromptComposer";
import { CommandMenu } from "./widgets/CommandMenu";
import { ArgumentMenu } from "./widgets/ArgumentMenu";
import { OptionPicker } from "./widgets/OptionPicker";
import { renderModelDetails, renderValidationNotice } from "./commands/render";
import { applyComposerKey, insertComposerImage, insertComposerText, normalizeKeyName, setComposerValue } from "./composer";
import { composerVisualLineCount } from "./composer-layout";
import type { ComposerElement, ComposerState } from "./composer";
import {
  listRewindPoints,
  rewindConversation,
  type ConversationRewind,
} from "../core/rewind/service";
import { renderResumedToolResultSummary } from "./tool-summary";
import { builtinCommands } from "./commands/builtin";
import { executeCommand } from "./commands/dispatch";
import { matchCommands } from "./commands/match";
import {
  completeAgentArgument,
  completeFixedArgument,
  completeModelArgument,
  fixedArgumentOptions,
  matchOptionItems,
  parseAgentArgumentDraft,
  parseFixedArgumentDraft,
  parseModelArgumentDraft,
} from "./commands/argument-completion";
import type { AgentArgumentDraft, FixedArgumentDraft, ModelArgumentDraft } from "./commands/argument-completion";
import { clampCommandMenuSelection, moveCommandMenuSelection } from "./commands/selection";
import type { CommandContext } from "./commands/types";
import type { ActivityEntry, AgentCardState, Message, OptionItem, SelectedArtifact, SessionPickerState } from "./types";
import { createRewindController } from "./rewind/controller";
import { initDebugLogging } from "./debug-log";
import { TurnCancellation } from "./turn-cancellation";
import { PromptEscapeController } from "./prompt-escape";
import { ingestImageBytes } from "../core/attachments/store";
import { inspectEngineAssetDrift } from "../core/runtime/engine-assets";
import { AgentManager } from "../core/agents/manager";
import { AgentStore } from "../core/agents/store";
import { runChildAgent } from "../core/agents/child-runner";
import { AgentContinuationScheduler, AgentDeliveryDeferred } from "../core/agents/scheduler";
import type { AgentInboxEntry } from "../core/agents/types";
import { listAgentProfiles } from "../core/agents/profile";
import { agentActivitySummary, agentCardFromMetadata, applyAgentEvent, mergeRestoredAgentCards, renderAgentDetail, retryAgentDelivery, setAgentDeliveryState } from "./agent-view";
import { ToolPermissionBroker, type PermissionMode } from "../core/permissions";
import type { PermissionResolution } from "../core/permissions";
import { PermissionPrompt } from "./PermissionPrompt";
import { YoloPrompt } from "./YoloPrompt";
import { getProcessManager, type BackgroundProcessEvent, type BackgroundProcessState } from "../core/process/manager";
import { processEventFromTask } from "../core/tools/shell";

type PendingGate = Extract<RunPromptResult, { kind: "needs_user" }>;

type PendingGateState = Omit<PendingGate, "profile"> & {
  engine: EngineId;
  profile?: PendingGate["profile"];
};

type PendingEngineSwitch = Extract<RunPromptResult, { kind: "needs_engine_switch" }>;

type PendingEngineSwitchState = Omit<PendingEngineSwitch, "profile"> & {
  profile?: PendingEngineSwitch["profile"];
};

type PendingUserQuestion = Extract<RunPromptResult, { kind: "needs_user_question" }>;

type PendingUserQuestionState = Omit<PendingUserQuestion, "profile"> & {
  engine: EngineId;
  profile?: PendingUserQuestion["profile"];
};

type PendingPermission = Extract<RunPromptResult, { kind: "needs_permission" }>;

type PendingPermissionState = Omit<PendingPermission, "profile"> & {
  engine: EngineId;
  profile?: PendingPermission["profile"];
};

type TuiKeyEvent = {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
  sequence?: string;
  raw?: string;
  preventDefault?: () => void;
  stopPropagation?: () => void;
};

// Two-step interactive provider→model picker state for "/model" with no args.
type ModelPickerState = {
  step: "provider" | "model";
  providerId: string | null;
  selected: number;
};

type PromptHistoryEntry = {
  value: string;
  elements: ComposerElement[];
  images: VesicleImageAttachment[];
};

export type AppProps = {
  dangerouslySkipPermissions?: boolean;
};

export type TokenUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  contextInputTokens: number;
};

export function App(props: AppProps = {}) {
  initDebugLogging();
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [providerRegistry, setProviderRegistry] = createSignal<ProviderRegistry | null>(null);
  const [activeProvider, setActiveProvider] = createSignal("loading");
  const [activeModel, setActiveModel] = createSignal("loading");
  const [activeModelLimits, setActiveModelLimits] = createSignal<ModelLimits | undefined>();
  const [activeModelCapabilities, setActiveModelCapabilities] = createSignal<ModelCapabilities | undefined>();
  const [activeEngine, setActiveEngine] = createSignal<EngineId>("etl");
  const [thinkingTier, setThinkingTier] = createSignal<ReasoningTier | undefined>();
  const [reasoningDisplayMode, setReasoningDisplayMode] = createSignal<ReasoningDisplayMode>("collapsed");
  const [permissionMode, setPermissionMode] = createSignal<PermissionMode>(
    props.dangerouslySkipPermissions ? "YOLO" : "MOMENTUM",
  );
  const [shellExecEnabled, setShellExecEnabled] = createSignal(props.dangerouslySkipPermissions === true);
  const [permissionSettingsReady, setPermissionSettingsReady] = createSignal(props.dangerouslySkipPermissions === true);
  const [providerHasApiKey, setProviderHasApiKey] = createSignal(false);
  const [providerConfigReady, setProviderConfigReady] = createSignal(false);
  const [mcpStatus, setMcpStatus] = createSignal<SidebarMcpState>({
    loading: true,
    configured: false,
    enabled: false,
    servers: [],
  });
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
  const [output, setOutput] = createSignal("");
  const [inputValue, setInputValue] = createSignal("");
  const [inputCursor, setInputCursor] = createSignal(0);
  const [inputKillBuffer, setInputKillBuffer] = createSignal<string | undefined>();
  const [inputElements, setInputElements] = createSignal<ComposerElement[]>([]);
  const [inputImages, setInputImages] = createSignal<VesicleImageAttachment[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [restoringSession, setRestoringSession] = createSignal(false);
  const [resumableSessions, setResumableSessions] = createSignal<SessionSummary[]>([]);
  const [sessionPicker, setSessionPicker] = createSignal<SessionPickerState | null>(null);
  const [nextSessionParent, setNextSessionParent] = createSignal<{ uuid: string | null } | null>(null);
  const [modelPicker, setModelPicker] = createSignal<ModelPickerState | null>(null);
  const [modelPickerBusy, setModelPickerBusy] = createSignal(false);
  const [artifacts, setArtifacts] = createSignal<ArtifactEntry[]>([]);
  const [selectedArtifact, setSelectedArtifact] = createSignal<SelectedArtifact | null>(null);
  const [activity, setActivity] = createSignal<ActivityEntry[]>([
    { kind: "system", text: "Activity will show provider requests, tool calls, gates, and validation." },
  ]);
  const [agentCards, setAgentCards] = createSignal<AgentCardState[]>([]);
  const [backgroundProcesses, setBackgroundProcesses] = createSignal<BackgroundProcessState[]>([]);
  const [streamingAssistant, setStreamingAssistant] = createSignal("");
  const [streamingReasoning, setStreamingReasoning] = createSignal("");
  const [lastTurnUsage, setLastTurnUsage] = createSignal<TokenUsageSummary | undefined>();
  const [sessionUsage, setSessionUsage] = createSignal<TokenUsageSummary>(emptyUsageSummary());
  const [lastDisplayedToolAssistantContent, setLastDisplayedToolAssistantContent] = createSignal<string | null>(null);
  const [promptHistory, setPromptHistory] = createSignal<PromptHistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal<number | null>(null);
  const turnCancellation = new TurnCancellation();

  const rewindController = createRewindController({
    rootDir: process.cwd(),
    sessionId,
    branchHead: nextSessionParent,
    busy,
    engine: activeEngine,
    providerSelection: () => ({ provider: activeProvider(), model: activeModel() }),
    generation: activeGeneration,
    setStatus,
    setBusy,
    runCancellable: (operation) => turnCancellation.run(operation),
    refreshArtifacts,
    applyConversation: applyConversationRewind,
  });
  const rewindPicker = rewindController.state;

  // Gate UI state. When pendingGate is non-null the input bar is replaced
  // by the Select-style gate prompt; keyboard routing switches to gate mode.
  const [pendingGate, setPendingGate] = createSignal<PendingGateState | null>(null);
  const [pendingEngineSwitch, setPendingEngineSwitch] = createSignal<PendingEngineSwitchState | null>(null);
  const [pendingUserQuestion, setPendingUserQuestion] = createSignal<PendingUserQuestionState | null>(null);
  const [pendingPermission, setPendingPermission] = createSignal<PendingPermissionState | null>(null);
  const [pendingChildPermission, setPendingChildPermission] = createSignal<import("../core/permissions").PermissionRequest | null>(null);
  const [yoloConfirmStage, setYoloConfirmStage] = createSignal<1 | 2 | null>(null);
  const [questionSelected, setQuestionSelected] = createSignal(0);
  const [questionFreeformText, setQuestionFreeformText] = createSignal("");
  const [questionFreeformCursor, setQuestionFreeformCursor] = createSignal(0);
  const [questionFreeformKillBuffer, setQuestionFreeformKillBuffer] = createSignal<string | undefined>();
  const [gateFocus, setGateFocus] = createSignal<GateFocusTarget>("confirm");
  const [gateFeedbackMode, setGateFeedbackMode] = createSignal<GateFocusTarget | null>(null);
  const [gateFeedback, setGateFeedback] = createSignal("");
  const [gateFeedbackCursor, setGateFeedbackCursor] = createSignal(0);
  const [gateFeedbackKillBuffer, setGateFeedbackKillBuffer] = createSignal<string | undefined>();
  const agentStore = new AgentStore(process.cwd());
  const processManager = getProcessManager(process.cwd());
  const unsubscribeProcesses = processManager.subscribe(handleBackgroundProcessEvent);
  onCleanup(() => {
    unsubscribeProcesses();
    void processManager.shutdown();
  });
  const permissionBroker = new ToolPermissionBroker();
  permissionBroker.subscribe((request) => setPendingChildPermission(request ?? null));
  const pausedAgentDeliveries = new Set<string>();
  const continuationScheduler = new AgentContinuationScheduler(agentStore, deliverAgentResults, {
    isParentIdle: (parentSessionId) => sessionId() === parentSessionId
      && !pausedAgentDeliveries.has(parentSessionId)
      && !restoringSession()
      && !busy()
      && !pendingGate()
      && !pendingEngineSwitch()
      && !pendingUserQuestion()
      && !pendingPermission()
      && !pendingChildPermission(),
  });
  const agentManager = new AgentManager(agentStore, runChildAgent, {
    onEvent: (event) => {
      handleAgentEvent(event);
      if (event.type === "agent_completed"
        && event.result.mode === "background"
        && event.result.status !== "cancelled") {
        void continuationScheduler.notify(event.result.parentSessionId).catch(reportError);
      }
    },
  });
  createEffect(() => {
    const id = sessionId();
    const ready = !restoringSession() && !busy() && !pendingGate() && !pendingEngineSwitch() && !pendingUserQuestion() && !pendingPermission() && !pendingChildPermission();
    if (id && ready) void continuationScheduler.notify(id).catch(reportError);
  });

  const inputShowsCommandHelp = createMemo(() => inputValue().startsWith("/"));
  // Slash-command popup: open while the user is still typing the command
  // token (input starts with "/" and has no space yet). Once `/model` reaches
  // its arguments, the provider/model popup below takes over.
  const commandMenuOpen = createMemo(() => inputShowsCommandHelp() && !inputValue().slice(1).includes(" "));
  const commandMenuQuery = createMemo(() => inputValue().slice(1));
  const commandMenuItems = createMemo(() => matchCommands(commandMenuQuery(), builtinCommands));
  const [commandMenuSelected, setCommandMenuSelected] = createSignal(0);
  createEffect(() => {
    const count = commandMenuItems().length;
    setCommandMenuSelected((selected) => clampCommandMenuSelection(selected, count));
  });
  // A filtered list has different row identities even when its length is the
  // same. Reset on every query change so the cursor cannot stay attached to an
  // unrelated row from the previous result set.
  let previousCommandMenuQuery: string | null = null;
  createEffect(() => {
    const query = commandMenuOpen() ? commandMenuQuery() : null;
    if (query !== previousCommandMenuQuery) setCommandMenuSelected(0);
    previousCommandMenuQuery = query;
  });
  const modelArgumentDraft = createMemo(() => parseModelArgumentDraft(inputValue()));
  const fixedArgumentDraft = createMemo(() => parseFixedArgumentDraft(inputValue()));
  const agentArgumentDraft = createMemo(() => parseAgentArgumentDraft(inputValue()));
  const commandArgumentMenuOpen = createMemo(() => modelArgumentDraft() !== null || fixedArgumentDraft() !== null || agentArgumentDraft() !== null);
  const commandArgumentItems = createMemo<OptionItem[]>(() => {
    const modelDraft = modelArgumentDraft();
    if (modelDraft) {
      const registry = providerRegistry();
      if (!registry) return [];
      const options = modelDraft.stage === "provider"
        ? providerOptionItems(registry)
        : modelOptionItems(registry, modelDraft.providerId);
      return matchOptionItems(modelDraft.query, options);
    }
    const fixedDraft = fixedArgumentDraft();
    if (fixedDraft) return matchOptionItems(fixedDraft.query, fixedArgumentOptions(fixedDraft.command));
    const agentDraft = agentArgumentDraft();
    if (!agentDraft) return [];
    const handles: OptionItem[] = agentCards()
      .filter((agent) => agent.parentSessionId === sessionId())
      .map((agent) => ({
        id: agent.handle,
        label: agent.handle,
        detail: `${agent.status} · ${agent.description}`,
      }));
    const options = agentDraft.stage === "command"
      ? [
        { id: "stop", label: "stop", detail: "Interrupt a running SubAgent" },
        { id: "retry", label: "retry", detail: "Retry paused background-result delivery" },
        ...handles,
      ]
      : handles.filter((item) => {
        const agent = agentCards().find((candidate) => candidate.handle === item.id);
        return agent?.status === "queued" || agent?.status === "running";
      });
    return matchOptionItems(agentDraft.query, options);
  });
  const [commandArgumentSelected, setCommandArgumentSelected] = createSignal(0);
  createEffect(() => {
    setCommandArgumentSelected((selected) => clampCommandMenuSelection(selected, commandArgumentItems().length));
  });
  let previousCommandArgumentKey: string | null = null;
  createEffect(() => {
    const modelDraft = modelArgumentDraft();
    const fixedDraft = fixedArgumentDraft();
    const agentDraft = agentArgumentDraft();
    const key = modelDraft
      ? `model:${modelDraft.stage}:${modelDraft.stage === "model" ? `${modelDraft.providerId}:` : ""}${modelDraft.query}`
      : fixedDraft
        ? `fixed:${fixedDraft.command}:${fixedDraft.query}`
        : agentDraft
          ? `agent:${agentDraft.stage}:${agentDraft.query}`
        : null;
    if (key !== previousCommandArgumentKey) setCommandArgumentSelected(0);
    previousCommandArgumentKey = key;
  });
  // Items shown in the interactive model picker: providers first, then the
  // chosen provider's models. Detail reuses the shared model formatter.
  const modelPickerItems = createMemo<OptionItem[]>(() => {
    const picker = modelPicker();
    const registry = providerRegistry();
    if (!picker || !registry) return [];
    if (picker.step === "provider") {
      return providerOptionItems(registry);
    }
    const provider = registry.providers.find((p) => p.id === picker.providerId);
    if (!provider) return [];
    return modelOptionItems(registry, provider.id);
  });
  const modelPickerTitle = (picker: ModelPickerState): string =>
    picker.step === "provider" ? "Select provider" : `Select model · ${picker.providerId}`;

  const composerInputWidth = createMemo(() => Math.max(8, dimensions().width - 4));
  const inputVisualLines = createMemo(() => composerVisualLineCount(inputValue(), composerInputWidth()));
  const composerPopupOpen = createMemo(() => commandMenuOpen() || commandArgumentMenuOpen());
  const inputNeedsExpandedBottom = createMemo(() => composerPopupOpen() || inputVisualLines() > 1);
  const decisionPanelMinHeight = createMemo(() => {
    const pending = pendingUserQuestion();
    if (pendingEngineSwitch()) return 10;
    return pending ? questionPanelMinHeight(pending.question, questionSelected()) : 9;
  });
  const layout = createMemo(() => resolveTuiLayout(
    dimensions().width,
    dimensions().height,
    Boolean(pendingGate()) || Boolean(pendingEngineSwitch()) || Boolean(pendingUserQuestion()) || Boolean(pendingPermission()) || Boolean(pendingChildPermission()) || Boolean(yoloConfirmStage()),
    Boolean(sessionPicker()) || Boolean(rewindPicker()) || Boolean(modelPicker()) || inputNeedsExpandedBottom(),
    decisionPanelMinHeight(),
    rewindPicker() ? rewindPickerPanelHeight(rewindPicker()!) : 8,
    rewindPicker() ? rewindPickerPanelHeight(rewindPicker()!) : 12,
  ));
  const composerPopupMaxRows = createMemo(() => Math.min(8, Math.max(1, layout().bottomHeight - 4)));
  const activeGateRequest = createMemo(() => {
    const gate = pendingGate();
    if (gate) return gate.gate;
    const engineSwitch = pendingEngineSwitch();
    if (engineSwitch) return engineSwitchGateRequest(activeEngine(), engineSwitch.request);
    return null;
  });
  const activePermissionRequest = createMemo(() => pendingPermission()?.request ?? pendingChildPermission() ?? undefined);

  let lastCtrlCAt = 0;
  const promptEscape = new PromptEscapeController();
  let activeTurnSawResponse = false;
  let activeTurnUsage = emptyUsageSummary();
  let activeTurnAgentUsage = emptyUsageSummary();
  let activeTurnUsagePublished = false;
  let lastReportedAssetDriftKey: string | undefined;
  let providerConfigLoad: Promise<void> | null = null;
  let permissionSettingsLoad: Promise<void> | null = null;

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

  useKeyboard((rawKey) => {
    // Normalise once at the keypress entry point so every handler below sees
    // canonical names. OpenTUI emits "up_arrow"/"down_arrow"/"return"; the
    // pickers and composers expect "up"/"down"/"enter". applyComposerKey
    // re-normalises harmlessly (the transform is idempotent).
    const key = { ...rawKey, name: normalizeKeyName(rawKey.name) };
    if (key.ctrl && key.name === "c") {
      void copySelectionToClipboard(renderer).then((copied) => {
        if (copied) {
          renderer.clearSelection();
          setStatus("selection copied");
          lastCtrlCAt = 0;
          return;
        }
        const now = Date.now();
        if (now - lastCtrlCAt < 3000) {
          process.nextTick(() => renderer.destroy());
          return;
        }
        lastCtrlCAt = now;
        setStatus("press Ctrl+C again to exit");
      });
      return;
    }

    // Ctrl+Q is the unconditional keyboard exit path. Handle it before modal
    // pickers, whose routing intentionally owns every other key while active.
    if (key.ctrl && key.name === "q") {
      process.nextTick(() => renderer.destroy());
      return;
    }

    if (rewindPicker()) {
      if (rewindController.handleKey(key)) consumeKey(key);
      return;
    }

    if (modelPicker()) {
      if (handleModelPickerKey(key)) consumeKey(key);
      return;
    }

    if (sessionPicker()) {
      if (handleSessionPickerKey(key)) consumeKey(key);
      return;
    }

    if (yoloConfirmStage()) {
      if (handleYoloKey(key)) consumeKey(key);
      return;
    }

    if (pendingUserQuestion()) {
      if (handleQuestionKey(key)) consumeKey(key);
      return;
    }

    if (pendingGate() || pendingEngineSwitch() || pendingPermission() || pendingChildPermission()) {
      if (handleGateKey(key)) consumeKey(key);
      return;
    }

    if (key.name?.toLowerCase() === "v" && (key.meta || key.option)) {
      consumeKey(key);
      void pasteClipboardImage();
      return;
    }

    if (handleComposerKey(key)) {
      consumeKey(key);
      return;
    }

    if (key.name === "escape") {
      handleEscapeAtPrompt();
      consumeKey(key);
    }
  });

  usePaste((event) => {
    const text = new TextDecoder().decode(event.bytes);
    if ((pendingGate() || pendingEngineSwitch() || pendingPermission() || pendingChildPermission()) && gateComposerIsActive(gateFocus(), gateFeedbackMode())) {
      applyGateFeedbackState(insertComposerText(currentGateFeedbackState(), text));
      event.preventDefault();
      return;
    }
    if (pendingUserQuestion() && questionComposerIsActive(selectedQuestionOption())) {
      applyQuestionFreeformState(insertComposerText(currentQuestionFreeformState(), text));
      event.preventDefault();
      return;
    }
    if (pendingGate() || pendingEngineSwitch() || pendingUserQuestion() || pendingPermission() || pendingChildPermission() || yoloConfirmStage() || sessionPicker() || rewindPicker()) return;
    applyComposerState(insertComposerText(currentComposerState(), text));
    event.preventDefault();
  });

  async function pasteClipboardImage(): Promise<void> {
    setStatus("reading clipboard image");
    try {
      const bytes = await readImageFromClipboard();
      if (!bytes) throw new Error("No supported image was found in the clipboard.");
      const image = await ingestImageBytes(process.cwd(), bytes, {
        source: "clipboard",
        filename: "clipboard.png",
      });
      const number = inputElements().filter((element) => element.type === "image").length + 1;
      const withImage = insertComposerImage(currentComposerState(), image.id, `[Image #${number}]`);
      applyComposerState(insertComposerText(withImage, " "));
      setInputImages((current) => [...current, image]);
      setHistoryIndex(null);
      setStatus(activeModelCapabilities()?.vision === true
        ? `attached Image #${number}`
        : `attached Image #${number}; current model does not declare vision support`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`image paste failed: ${message}`);
      recordActivity({ kind: "system", text: `image paste failed: ${message}` });
    }
  }

  function handleGateKey(key: TuiKeyEvent): boolean {
    if (busy() && !pendingChildPermission()) return false;
    const focusOrder = currentGateFocusOrder();
    if (gateComposerIsActive(gateFocus(), gateFeedbackMode()) && key.name !== "tab" && key.name !== "escape") {
      const result = applyComposerKey(currentGateFeedbackState(), key);
      if (result.handled) {
        applyGateFeedbackState(result.state);
        if (result.action?.type === "submit") {
          const resolution = gateResolutionFromState(gateFocus(), result.action.value);
          if (pendingPermission()) {
            void submitPermissionResolution(permissionResolutionFromGate(resolution));
          } else if (pendingChildPermission()) {
            submitChildPermissionResolution(permissionResolutionFromGate(resolution));
          } else if (pendingEngineSwitch()) {
            void submitEngineSwitchResolution(resolution, { summarizeContext: gateFocus() === "confirm-summary" });
          } else {
            void submitGateResolution(resolution);
          }
        } else if (result.action?.type === "history_up") {
          moveGateFocus(-1, focusOrder);
        } else if (result.action?.type === "history_down") {
          moveGateFocus(1, focusOrder);
        }
        return true;
      }
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      moveGateFocus(-1, focusOrder);
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      moveGateFocus(1, focusOrder);
      return true;
    }
    if (key.name === "tab") {
      const target = gateFocus();
      if (target === "reject" || target === "confirm-summary") return true;
      setGateFeedbackMode((prev) => (prev === target ? null : target));
      setGateFeedback("");
      setGateFeedbackCursor(0);
      setGateFeedbackKillBuffer(undefined);
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      const resolution = gateResolutionFromState(gateFocus(), gateFeedback());
      if (pendingPermission()) {
        void submitPermissionResolution(permissionResolutionFromGate(resolution));
      } else if (pendingChildPermission()) {
        submitChildPermissionResolution(permissionResolutionFromGate(resolution));
      } else if (pendingEngineSwitch()) {
        void submitEngineSwitchResolution(resolution, { summarizeContext: gateFocus() === "confirm-summary" });
      } else {
        void submitGateResolution(resolution);
      }
      return true;
    }
    if (key.name === "escape") {
      // Cancel = retreat to rejection/discussion without committing.
      setGateFeedbackMode(null);
      setGateFeedback("");
      setGateFeedbackCursor(0);
      setGateFeedbackKillBuffer(undefined);
      setGateFocus("reject");
      return true;
    }
    return false;
  }

  function handleYoloKey(key: TuiKeyEvent): boolean {
    if (key.name === "up" || key.name === "down" || (key.ctrl && (key.name === "p" || key.name === "n"))) {
      setGateFocus((current) => current === "confirm" ? "reject" : "confirm");
      return true;
    }
    if (key.name === "escape") {
      setGateFocus("reject");
      setYoloConfirmStage(null);
      setStatus(`permission mode ${permissionMode()}`);
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      if (gateFocus() === "reject") {
        setYoloConfirmStage(null);
        setStatus(`permission mode ${permissionMode()}`);
      } else if (yoloConfirmStage() === 1) {
        setYoloConfirmStage(2);
      } else {
        void applyPermissionMode("YOLO");
        setYoloConfirmStage(null);
      }
      return true;
    }
    return false;
  }

  function currentGateFocusOrder(): GateFocusTarget[] {
    return pendingEngineSwitch() ? engineSwitchGateFocusOrder : gateFocusOrder;
  }

  function moveGateFocus(delta: -1 | 1, order = currentGateFocusOrder()): void {
    const current = gateFocus();
    const idx = Math.max(0, order.indexOf(current));
    setGateFocus(order[(idx + delta + order.length) % order.length]);
  }

  function handleEscapeAtPrompt(): void {
    const draft = inputValue();
    switch (promptEscape.press({ busy: busy(), draft, hasSession: Boolean(sessionId()) })) {
      case "interrupt":
        if (turnCancellation.abort()) setStatus("interrupting request");
        return;
      case "clear":
        if (draft.trim() || inputImages().length > 0) {
          recordPromptHistory(draft, inputElements(), inputImages());
        }
        clearComposer();
        setStatus("input cleared");
        return;
      case "arm-clear":
        setStatus("Esc again to clear");
        setTimeout(() => {
          if (status() === "Esc again to clear") setStatus("ready");
        }, 1000);
        return;
      case "rewind":
        void rewindController.open();
        return;
      case "arm-rewind":
      case "noop":
        return;
    }
  }

  function handleQuestionKey(key: TuiKeyEvent): boolean {
    const pending = pendingUserQuestion();
    if (!pending || busy()) return false;
    const selectedOption = pending.question.options[questionSelected()];
    if (questionComposerIsActive(selectedOption)) {
      if (key.name === "escape") {
        setQuestionFreeformText("");
        setQuestionFreeformCursor(0);
        setQuestionFreeformKillBuffer(undefined);
        setStatus(`question pending: ${pending.question.header}`);
        return true;
      }
      const result = applyComposerKey(currentQuestionFreeformState(), key);
      if (result.handled) {
        applyQuestionFreeformState(result.state);
        if (result.action?.type === "submit") {
          submitUserQuestionFreeform(result.action.value);
        } else if (result.action?.type === "history_up") {
          setQuestionSelected((prev) => (prev - 1 + pending.question.options.length) % pending.question.options.length);
        } else if (result.action?.type === "history_down") {
          setQuestionSelected((prev) => (prev + 1) % pending.question.options.length);
        }
        return true;
      }
      return false;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setQuestionSelected((prev) => (prev - 1 + pending.question.options.length) % pending.question.options.length);
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setQuestionSelected((prev) => (prev + 1) % pending.question.options.length);
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      void submitUserQuestionAnswer(questionSelected());
      return true;
    }
    return false;
  }

  function handleComposerKey(key: TuiKeyEvent): boolean {
    if (commandMenuOpen() && handleCommandMenuKey(key)) return true;
    if (commandArgumentMenuOpen() && handleCommandArgumentMenuKey(key)) return true;
    const result = applyComposerKey(currentComposerState(), key, { columns: composerInputWidth() });
    if (!result.handled) return false;
    applyComposerState(result.state);

    if (result.action?.type === "submit") {
      if (busy()) {
        setStatus("request in flight; draft kept");
        return true;
      }
      const submitted = result.action.value;
      if (submitted.trim().length === 0) return true;
      const submittedImages = imagesForElements(result.action.elements ?? []);
      if (submittedImages.length > 0 && activeModelCapabilities()?.vision !== true) {
        setStatus("current model does not declare vision support; draft kept");
        return true;
      }
      clearComposer();
      void submitPrompt(submitted, submittedImages, result.action.elements ?? []);
      return true;
    }
    if (result.action?.type === "history_up") {
      if (!busy()) recallPromptHistory(-1);
      return true;
    }
    if (result.action?.type === "history_down") {
      if (historyIndex() !== null && !busy()) recallPromptHistory(1);
      return true;
    }
    setHistoryIndex(null);
    return true;
  }

  // Navigate the slash-command popup. Returns true when it consumes the key
  // (so handleComposerKey skips the normal composer path); false for printable
  // chars so they flow into the composer and refilter the menu.
  function handleCommandMenuKey(key: TuiKeyEvent): boolean {
    const name = normalizeKeyName(key.name);
    if (name === "up" || (key.ctrl && name === "p")) {
      setCommandMenuSelected((selected) => moveCommandMenuSelection(selected, -1, commandMenuItems().length));
      return true;
    }
    if (name === "down" || (key.ctrl && name === "n")) {
      setCommandMenuSelected((selected) => moveCommandMenuSelection(selected, 1, commandMenuItems().length));
      return true;
    }
    if (name === "tab") {
      const cmd = commandMenuItems()[commandMenuSelected()];
      if (cmd) completeCommandName(cmd.name);
      return true;
    }
    if (name === "return" || name === "enter") {
      const cmd = commandMenuItems()[commandMenuSelected()];
      if (!cmd) return true;
      // Typing the full command name and pressing Enter runs it; a partial
      // token completes the name instead. Tab always just completes.
      if (inputValue() === `/${cmd.name}`) {
        if (busy()) {
          setStatus("request in flight; draft kept");
          return true;
        }
        clearComposer();
        void submitPrompt(`/${cmd.name}`);
      } else {
        completeCommandName(cmd.name);
      }
      return true;
    }
    if (name === "escape") {
      clearComposer();
      return true;
    }
    return false;
  }

  // Replace the draft with "/<name> " and drop into argument mode; the menu
  // closes itself because the value now contains a space.
  function completeCommandName(name: string) {
    const value = `/${name} `;
    applyComposerState(setComposerValue(value));
    setInputImages([]);
    setCommandMenuSelected(0);
    setHistoryIndex(null);
  }

  function handleCommandArgumentMenuKey(key: TuiKeyEvent): boolean {
    const name = normalizeKeyName(key.name);
    const items = commandArgumentItems();
    if (name === "up" || (key.ctrl && name === "p")) {
      setCommandArgumentSelected((selected) => moveCommandMenuSelection(selected, -1, items.length));
      return true;
    }
    if (name === "down" || (key.ctrl && name === "n")) {
      setCommandArgumentSelected((selected) => moveCommandMenuSelection(selected, 1, items.length));
      return true;
    }
    if (name === "tab") {
      completeSelectedCommandArgument();
      return true;
    }
    if (name === "enter" || name === "return") {
      const item = items[commandArgumentSelected()];
      if (!item) return false;
      const completed = selectedCommandArgumentValue(item);
      if (!completed) return false;
      const executable = completed.trimEnd();
      if (inputValue() === executable) submitCompletedCommandArgument(executable);
      else applyCompletedCommandArgument(completed);
      return true;
    }
    if (name === "escape") {
      clearComposer();
      return true;
    }
    return false;
  }

  function completeSelectedCommandArgument() {
    const item = commandArgumentItems()[commandArgumentSelected()];
    const completed = item ? selectedCommandArgumentValue(item) : null;
    if (completed) applyCompletedCommandArgument(completed);
  }

  function selectedCommandArgumentValue(item: OptionItem): string | null {
    const modelDraft = modelArgumentDraft();
    if (modelDraft) return completeModelArgument(modelDraft, item);
    const fixedDraft = fixedArgumentDraft();
    if (fixedDraft) return completeFixedArgument(fixedDraft, item);
    const agentDraft = agentArgumentDraft();
    return agentDraft ? completeAgentArgument(agentDraft, item) : null;
  }

  function submitCompletedCommandArgument(value: string) {
    if (busy()) {
      setStatus("request in flight; draft kept");
      return;
    }
    clearComposer();
    void submitPrompt(value);
  }

  function applyCompletedCommandArgument(value: string) {
    applyComposerState(setComposerValue(value));
    setInputImages([]);
    setCommandArgumentSelected(0);
    setHistoryIndex(null);
  }

  function recallPromptHistory(direction: -1 | 1) {
    const history = promptHistory();
    if (history.length === 0) return;
    const current = historyIndex();
    const next = current === null
      ? history.length - 1
      : Math.max(0, Math.min(history.length - 1, current + direction));
    setHistoryIndex(next);
    const entry = history[next];
    if (!entry) return;
    setInputValue(entry.value);
    setInputCursor(entry.value.length);
    setInputElements(entry.elements.map((element) => ({ ...element })));
    setInputImages(entry.images.map((image) => ({ ...image })));
  }

  function imagesForElements(elements: ComposerElement[]): VesicleImageAttachment[] {
    const byId = new Map(inputImages().map((image) => [image.id, image]));
    return elements.flatMap((element) => {
      const image = byId.get(element.attachmentId);
      return image ? [{ ...image }] : [];
    });
  }

  function recordPromptHistory(
    value: string,
    elements: ComposerElement[],
    images: VesicleImageAttachment[],
  ): void {
    const entry: PromptHistoryEntry = {
      value,
      elements: elements.map((element) => ({ ...element })),
      images: images.map((image) => ({ ...image })),
    };
    setPromptHistory((previous) => [
      ...previous.filter((candidate) => candidate.value !== value),
      entry,
    ].slice(-50));
  }

  function resetRewindState(): void {
    rewindController.reset();
    setNextSessionParent(null);
  }

  async function applyConversationRewind(result: ConversationRewind): Promise<void> {
    const snapshot = result.snapshot;
    setConversation(vesicleMessagesFromResumed(snapshot.messages));
    setMessages(displayTranscriptFromSnapshot(snapshot.messages, agentCards()));
    setActiveEngine(snapshot.engine ?? "etl");
    setThinkingTier(snapshot.reasoningTier);
    setReasoningDisplayMode(snapshot.reasoningDisplayMode ?? "collapsed");
    if (snapshot.providerSelection) {
      try {
        await applyProviderSelection(snapshot.providerSelection);
      } catch (error) {
        recordActivity({
          kind: "system",
          text: `rewind kept current provider: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    setPendingGate(null);
    setPendingEngineSwitch(null);
    setPendingUserQuestion(null);
    setPendingPermission(null);
    setOutput("");
    setNextSessionParent({ uuid: result.parentUuid });
    const images = result.images ?? [];
    applyComposerState({
      value: result.prompt,
      cursor: result.prompt.length,
      elements: composerElementsForImages(result.prompt, images),
    });
    setInputImages(images.map((image) => ({ ...image })));
    setHistoryIndex(null);
    await refreshArtifacts();
    setStatus("conversation rewound");
  }

  async function compactSession(instructions?: string): Promise<{ summary: string; messagesSummarized: number }> {
    const id = sessionId();
    if (!id) throw new Error("No active session to compact.");
    if (pendingGate() || pendingEngineSwitch() || pendingUserQuestion() || pendingPermission() || pendingChildPermission()) {
      throw new Error("Resolve the pending gate, engine switch, question, or permission before compacting.");
    }
    if (!providerConfigReady()) await loadProviderConfigOnce();

    setBusy(true);
    setStatus("compacting conversation");
    recordActivity({ kind: "provider", text: "compacting conversation" });
    try {
      const outcome = await turnCancellation.run((signal) => compactConversation({
        rootDir: process.cwd(),
        sessionId: id,
        engine: activeEngine(),
        providerSelection: activeProviderSelection(),
        generation: activeGeneration(),
        instructions,
        signal,
      }));
      if (outcome.kind === "interrupted") throw new Error("Compaction canceled.");
      const result = outcome.value;
      const snapshot = result.snapshot;
      setConversation(vesicleMessagesFromResumed(snapshot.messages));
      setMessages(displayTranscriptFromSnapshot(snapshot.messages, agentCards()));
      setLastTurnUsage(latestTurnUsage(snapshot.messages));
      setSessionUsage(sumSessionUsage(snapshot.messages));
      setOutput("");
      setNextSessionParent({ uuid: result.parentUuid });
      setPendingGate(null);
      setPendingEngineSwitch(null);
      setPendingUserQuestion(null);
      setPendingPermission(null);
      setSessionPicker(null);
      rewindController.reset();
      clearComposer();
      setHistoryIndex(null);
      setStatus(`compacted ${result.messagesSummarized} messages`);
      recordActivity({ kind: "system", text: `compacted ${result.messagesSummarized} messages` });
      return { summary: result.summary, messagesSummarized: result.messagesSummarized };
    } finally {
      setBusy(false);
    }
  }

  function handleSessionPickerKey(key: TuiKeyEvent): boolean {
    const picker = sessionPicker();
    if (!picker) return false;

    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setSessionPicker({
        ...picker,
        selected: (picker.selected - 1 + picker.sessions.length) % picker.sessions.length,
      });
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setSessionPicker({
        ...picker,
        selected: (picker.selected + 1) % picker.sessions.length,
      });
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      const target = picker.sessions[picker.selected];
      if (target) void resumeSession(target);
      return true;
    }
    if (key.name === "escape") {
      setSessionPicker(null);
      setStatus("resume cancelled");
      return true;
    }
    return false;
  }

  // Two-step model picker: provider step → model step → commit. Esc backs out
  // of the model step to the provider step, or closes from the provider step.
  function handleModelPickerKey(key: TuiKeyEvent): boolean {
    const picker = modelPicker();
    if (!picker) return false;
    if (modelPickerBusy()) return true;
    const items = modelPickerItems();
    if (items.length === 0) return false;

    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setModelPicker({ ...picker, selected: (picker.selected - 1 + items.length) % items.length });
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setModelPicker({ ...picker, selected: (picker.selected + 1) % items.length });
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      const item = items[picker.selected];
      if (!item) return true;
      if (picker.step === "provider") {
        setModelPicker({ step: "model", providerId: item.id, selected: 0 });
      } else {
        setModelPickerBusy(true);
        setStatus("switching provider/model");
        void commitModelPicker(picker.providerId ?? "", item.id);
      }
      return true;
    }
    if (key.name === "escape") {
      if (picker.step === "model") {
        setModelPicker({ step: "provider", providerId: null, selected: 0 });
      } else {
        setModelPicker(null);
        setStatus("model switch cancelled");
      }
      return true;
    }
    return false;
  }

  async function commitModelPicker(providerId: string, modelId: string) {
    try {
      const selection = await applyProviderSelection({ provider: providerId, model: modelId });
      await persistProviderSwitch(selection);
      setMessages((prev) => [...prev, { role: "system", content: `Using ${selection.provider}/${selection.model}.` }]);
    } catch (error) {
      reportError(error);
    } finally {
      setModelPicker(null);
      setModelPickerBusy(false);
    }
  }

  async function openModelPicker() {
    try {
      await ensureProviderRegistry();
      setModelPickerBusy(false);
      setModelPicker({ step: "provider", providerId: null, selected: 0 });
    } catch (error) {
      reportError(error);
    }
  }

  function consumeKey(key: TuiKeyEvent) {
    key.preventDefault?.();
    key.stopPropagation?.();
  }

  function currentComposerState(): ComposerState {
    return {
      value: inputValue(),
      cursor: inputCursor(),
      ...(inputKillBuffer() ? { killBuffer: inputKillBuffer() } : {}),
      ...(inputElements().length ? { elements: inputElements() } : {}),
    };
  }

  function applyComposerState(state: ComposerState) {
    setInputValue(state.value);
    setInputCursor(state.cursor);
    setInputKillBuffer(state.killBuffer);
    const elements = state.elements ?? [];
    setInputElements(elements);
    const ids = new Set(elements.map((element) => element.attachmentId));
    setInputImages((current) => current.filter((image) => ids.has(image.id)));
  }

  function clearComposer() {
    applyComposerState(setComposerValue(""));
    setInputImages([]);
  }

  function selectedQuestionOption() {
    const pending = pendingUserQuestion();
    return pending?.question.options[questionSelected()];
  }

  function currentGateFeedbackState(): ComposerState {
    return {
      value: gateFeedback(),
      cursor: gateFeedbackCursor(),
      ...(gateFeedbackKillBuffer() ? { killBuffer: gateFeedbackKillBuffer() } : {}),
    };
  }

  function applyGateFeedbackState(state: ComposerState) {
    setGateFeedback(state.value);
    setGateFeedbackCursor(state.cursor);
    setGateFeedbackKillBuffer(state.killBuffer);
  }

  function currentQuestionFreeformState(): ComposerState {
    return {
      value: questionFreeformText(),
      cursor: questionFreeformCursor(),
      ...(questionFreeformKillBuffer() ? { killBuffer: questionFreeformKillBuffer() } : {}),
    };
  }

  function applyQuestionFreeformState(state: ComposerState) {
    setQuestionFreeformText(state.value);
    setQuestionFreeformCursor(state.cursor);
    setQuestionFreeformKillBuffer(state.killBuffer);
  }

  const submitPrompt = async (
    value: string,
    images: VesicleImageAttachment[] = [],
    elements: ComposerElement[] = [],
  ) => {
    const prompt = value.trim();
    if (!prompt || busy()) return;

    // Slash commands for session management. These never hit the provider.
    if (prompt.startsWith("/") && images.length === 0) {
      try {
        await executeCommand(prompt, commandContext, builtinCommands);
      } catch (error) {
        reportError(error);
      }
      return;
    }

    if (!providerConfigReady()) {
      setStatus("loading provider config");
      try {
        await loadProviderConfigOnce();
      } catch (error) {
        setProviderConfigReady(true);
        reportError(error);
        return;
      }
    }
    if (!permissionSettingsReady()) {
      setStatus("loading permission settings");
      try {
        await loadPermissionSettingsOnce();
      } catch (error) {
        reportError(error);
        return;
      }
    }

    if (images.length > 0 && activeModelCapabilities()?.vision !== true) {
      applyComposerState({ value, cursor: value.length, elements: elements.map((element) => ({ ...element })) });
      setInputImages(images.map((image) => ({ ...image })));
      setStatus("current model does not declare vision support; draft restored");
      return;
    }

    recordPromptHistory(value, elements, images);
    if (sessionId()) pausedAgentDeliveries.delete(sessionId()!);
    setHistoryIndex(null);
    setSessionPicker(null);
    setLastDisplayedToolAssistantContent(null);
    setBusy(true);
    setStatus("sending request");
    recordActivity({ kind: "provider", text: "sending provider request" });
    const requestMessages: VesicleMessage[] = [
      ...conversation(),
      { role: "user", content: prompt, ...(images.length ? { images } : {}) },
    ];
    setMessages((prev) => [...prev, { role: "user", content: prompt, ...(images.length ? { images } : {}) }]);
    const branchParent = nextSessionParent();
    setNextSessionParent(null);
    activeTurnSawResponse = false;
    beginUsageTurn();

    try {
      const outcome = await turnCancellation.run((signal) => runPrompt({
        input: prompt,
        engine: activeEngine(),
        sessionId: sessionId(),
        ...(branchParent ? { sessionParentUuid: branchParent.uuid } : {}),
        messages: requestMessages,
        ...(images.length ? { images } : {}),
        providerSelection: activeProviderSelection(),
        generation: activeGeneration(),
        permission: {
          mode: permissionMode(),
          ...(props.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
          shellExecEnabled: shellExecEnabled(),
        },
        signal,
        onEvent: handleAgentEvent,
        agentManager,
        permissionBroker,
      }));
      if (outcome.kind === "interrupted") {
        if (!activeTurnSawResponse) await restoreInterruptedPrompt(value, images, elements);
        handleInterruptedTurn();
      } else {
        handleResult(outcome.value, requestMessages);
      }
    } catch (error) {
      if (!activeTurnSawResponse) {
        await restoreInterruptedPrompt(value, images, elements).catch(() => undefined);
      }
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  async function deliverAgentResults(parentSessionId: string, entries: AgentInboxEntry[], packet: string): Promise<void> {
    if (sessionId() !== parentSessionId || busy() || pendingGate() || pendingEngineSwitch() || pendingUserQuestion() || pendingPermission() || pendingChildPermission()) {
      throw new AgentDeliveryDeferred();
    }
    setBusy(true);
    try {
      setAgentCards((cards) => setAgentDeliveryState(cards, entries.map((entry) => entry.runId), "integrating", "integrating result into parent"));
      setStatus(`integrating ${entries.length} SubAgent result${entries.length === 1 ? "" : "s"}`);
      recordActivity({ kind: "agent", text: `delivering ${entries.length} background result${entries.length === 1 ? "" : "s"}` });
      setMessages((current) => [...current, {
        role: "system",
        content: `Background SubAgent${entries.length === 1 ? "" : "s"} completed: ${entries.map((entry) => `${entry.description} (${entry.status})`).join(", ")}.`,
      }]);
      const requestMessages: VesicleMessage[] = [...conversation(), { role: "user", content: packet }];
      activeTurnSawResponse = false;
      beginUsageTurn();
      for (const entry of entries) {
        if (entry.usage) recordIndependentAgentUsage(entry.usage);
      }
      const childUsage = combineIndependentUsage(entries.map((entry) => entry.usage));
      const inboxIds = entries.map((entry) => entry.inboxId).sort();
      const persistedDelivery = (await loadSessionSnapshot(process.cwd(), parentSessionId, {
        synthesizeDanglingToolResults: false,
      })).records.find((record) => record.role === "user"
        && record.metadata?.kind === "subagent-results"
        && sameStringSet(record.metadata?.inboxIds, inboxIds));
      const outcome = await turnCancellation.run((signal) => runPrompt({
        input: packet,
        engine: activeEngine(),
        sessionId: parentSessionId,
        messages: requestMessages,
        inputMetadata: {
          kind: "subagent-results",
          inboxIds,
          ...(childUsage ? { usage: childUsage } : {}),
        },
        ...(persistedDelivery ? { prePersistedInputUuid: persistedDelivery.uuid } : {}),
        providerSelection: activeProviderSelection(),
        generation: activeGeneration(),
        permission: {
          mode: permissionMode(),
          ...(props.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
          shellExecEnabled: shellExecEnabled(),
        },
        signal,
        onEvent: handleAgentEvent,
        agentManager,
        permissionBroker,
      }));
      if (outcome.kind === "interrupted") {
        handleInterruptedTurn();
        throw new Error("SubAgent result delivery was interrupted.");
      }
      handleResult(outcome.value, requestMessages);
      setAgentCards((cards) => setAgentDeliveryState(cards, entries.map((entry) => entry.runId), "integrated", "result integrated"));
    } catch (error) {
      setAgentCards((cards) => setAgentDeliveryState(cards, entries.map((entry) => entry.runId), "pending", "integration paused; use /agents retry or send input"));
      pausedAgentDeliveries.add(parentSessionId);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  const submitPermissionResolution = async (resolution: PermissionResolution) => {
    const pending = pendingPermission();
    if (!pending || busy()) return;
    setBusy(true);
    setStatus(`resolving permission: ${resolution.decision}`);
    recordActivity({ kind: "tool", text: `${resolution.decision} ${pending.request.toolName}` });
    setPendingPermission(null);
    setGateFeedbackMode(null);
    setGateFeedback("");
    setGateFeedbackCursor(0);
    setGateFeedbackKillBuffer(undefined);
    beginUsageTurn();
    try {
      const outcome = await turnCancellation.run((signal) => resolvePermission({
        engine: pending.engine,
        sessionId: pending.sessionId,
        messages: pending.messages,
        request: pending.request,
        remainingToolCalls: pending.remainingToolCalls,
        deferredAgentPermissions: pending.deferredAgentPermissions,
        resolution,
        providerSelection: activeProviderSelection(),
        generation: activeGeneration(),
        permission: {
          mode: permissionMode(),
          ...(props.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
          shellExecEnabled: shellExecEnabled(),
        },
        signal,
        onEvent: handleAgentEvent,
        agentManager,
        permissionBroker,
      }));
      if (outcome.kind === "interrupted") {
        await reconcilePermissionAfterContinuationFailure(pending);
        handleInterruptedTurn();
      } else {
        handleResult(outcome.value, pending.messages);
      }
    } catch (error) {
      await reconcilePermissionAfterContinuationFailure(pending);
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  async function reconcilePermissionAfterContinuationFailure(pending: PendingPermissionState): Promise<void> {
    try {
      const snapshot = await loadSessionSnapshot(process.cwd(), pending.sessionId, {
        synthesizeDanglingToolResults: false,
      });
      if (snapshot.pendingPermission?.id === pending.request.id) {
        setPendingPermission(pending);
        return;
      }
      setPendingPermission(null);
      setConversation(vesicleMessagesFromResumed(snapshot.messages));
      setMessages(displayTranscriptFromSnapshot(snapshot.messages, agentCards()));
      setStatus("permission resolved; provider continuation stopped");
    } catch {
      setPendingPermission(pending);
    }
  }

  function submitChildPermissionResolution(resolution: PermissionResolution): void {
    const request = pendingChildPermission();
    if (!request) return;
    if (!permissionBroker.resolve(request.id, resolution)) return;
    setGateFeedbackMode(null);
    setGateFeedback("");
    setGateFeedbackCursor(0);
    setGateFeedbackKillBuffer(undefined);
    setStatus(`${resolution.decision} ${request.agent?.handle ?? "SubAgent"} ${request.toolName}`);
    recordActivity({
      kind: "agent",
      text: `${resolution.decision} ${request.agent?.handle ?? "SubAgent"} ${request.toolName}`,
    });
  }

  const submitGateResolution = async (resolution: GateResolution) => {
    const gate = pendingGate();
    if (!gate || busy()) return;

    setBusy(true);
    setStatus(`resolving gate: ${resolution.decision}`);
    recordActivity({ kind: "gate", text: `resolving ${gate.gate.gate} as ${resolution.decision}` });
    setPendingGate(null);
    setGateFeedbackMode(null);
    setGateFeedback("");
    setGateFeedbackCursor(0);
    setGateFeedbackKillBuffer(undefined);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: `[gate:${gate.gate.gate}] ${resolution.decision}${resolution.feedback ? ` — ${resolution.feedback}` : ""}` },
    ]);
    beginUsageTurn();

    try {
      const outcome = await turnCancellation.run((signal) => resolveGate({
        engine: gate.engine,
        sessionId: gate.sessionId,
        messages: gate.messages,
        toolCallId: gate.toolCallId,
        gate: gate.gate,
        resolution,
        providerSelection: activeProviderSelection(),
        generation: activeGeneration(),
        permission: { mode: permissionMode(), shellExecEnabled: shellExecEnabled(), ...(props.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}) },
        signal,
        onEvent: handleAgentEvent,
        agentManager,
        permissionBroker,
      }));
      if (outcome.kind === "interrupted") {
        setPendingGate(gate);
        handleInterruptedTurn();
      } else {
        handleResult(outcome.value, gate.messages);
      }
    } catch (error) {
      setPendingGate(gate);
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const submitEngineSwitchResolution = async (
    resolution: GateResolution,
    options: { summarizeContext?: boolean } = {},
  ) => {
    const pending = pendingEngineSwitch();
    if (!pending || busy()) return;
    const summarizeContext = resolution.decision === "confirm" && options.summarizeContext === true;
    let switchApplied = false;

    setBusy(true);
    setStatus(summarizeContext ? "resolving engine switch with summary" : `resolving engine switch: ${resolution.decision}`);
    recordActivity({ kind: "gate", text: `resolving engine switch to ${pending.request.targetEngine} as ${summarizeContext ? "confirm-summary" : resolution.decision}` });
    setPendingEngineSwitch(null);
    setGateFeedbackMode(null);
    setGateFeedback("");
    setGateFeedbackCursor(0);
    setGateFeedbackKillBuffer(undefined);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: `[engine-switch:${pending.request.targetEngine}] ${resolution.decision}${resolution.feedback ? ` — ${resolution.feedback}` : ""}` },
    ]);
    // Confirming an engine switch is host-only: resolveEngineSwitch writes the
    // tool result and engine metadata without calling the provider, so it
    // should not clear the previous provider turn's token telemetry. Rejection
    // does call the current engine again and therefore starts a new
    // measured turn.
    if (resolution.decision !== "confirm") beginUsageTurn();

    try {
      const outcome = await turnCancellation.run((signal) => resolveEngineSwitch({
        engine: pending.profile?.id ?? activeEngine(),
        sessionId: pending.sessionId,
        messages: pending.messages,
        toolCallId: pending.toolCallId,
        request: pending.request,
        resolution,
        ...(summarizeContext ? { contextPolicy: "summary" as const } : {}),
        providerSelection: activeProviderSelection(),
        generation: activeGeneration(),
        permission: { mode: permissionMode(), shellExecEnabled: shellExecEnabled(), ...(props.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}) },
        signal,
        onEvent: handleAgentEvent,
        agentManager,
        permissionBroker,
      }));
      if (outcome.kind === "interrupted") {
        setPendingEngineSwitch(pending);
        handleInterruptedTurn();
        return;
      }
      const result = outcome.value;
      if (result.kind === "engine_switched") {
        switchApplied = true;
        setConversation([...result.messages]);
        setSessionId(result.sessionId);
        setSessionPath(result.sessionPath);
        setActiveEngine(result.engine);
        setStatus(`engine ${result.engine}`);
        recordActivity({ kind: "system", text: `engine switched to ${result.engine}` });
        if (summarizeContext) {
          const compact = await compactSession("Preserve the engine handoff, user intent, important files/artifacts, unresolved issues, and the next useful step.");
          setMessages((prev) => [
            ...prev,
            { role: "system", content: `Engine switched to ${result.engine} with summarized context (${compact.messagesSummarized} messages). Future turns will use that profile.` },
          ]);
        } else {
          setMessages((prev) => [...prev, { role: "system", content: `Engine switched to ${result.engine}. Future turns will use that profile.` }]);
        }
      } else {
        handleResult(result, result.messages);
      }
    } catch (error) {
      if (!switchApplied) setPendingEngineSwitch(pending);
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const submitUserQuestionAnswer = async (selectedIndex: number) => {
    const pending = pendingUserQuestion();
    if (!pending || busy()) return;
    const option = pending.question.options[selectedIndex];
    if (!option) return;
    if (option.kind === "freeform") {
      submitUserQuestionFreeform(questionFreeformText());
      return;
    }
    const answer: UserQuestionAnswer = {
      selectedIndex,
      label: option.label,
      description: option.description,
      ...(option.kind ? { kind: option.kind } : {}),
    };
    await submitUserQuestionAnswerPayload(pending, answer, selectedIndex);
  };

  const submitUserQuestionFreeform = (value: unknown) => {
    const pending = pendingUserQuestion();
    if (!pending || busy()) return;
    const text = (typeof value === "string" ? value : questionFreeformText()).trim();
    if (!text) {
      setStatus("type a free-form answer or press Esc");
      return;
    }
    const selectedIndex = questionSelected();
    const option = pending.question.options[selectedIndex];
    if (!option || option.kind !== "freeform") return;
    const answer: UserQuestionAnswer = {
      selectedIndex,
      label: option.label,
      description: option.description,
      kind: "freeform",
      freeformText: text,
    };
    setQuestionFreeformText("");
    setQuestionFreeformCursor(0);
    setQuestionFreeformKillBuffer(undefined);
    void submitUserQuestionAnswerPayload(pending, answer, selectedIndex);
  };

  async function submitUserQuestionAnswerPayload(
    pending: PendingUserQuestionState,
    answer: UserQuestionAnswer,
    selectedIndex: number,
  ) {
    setBusy(true);
    setStatus(`answering question: ${pending.question.header}`);
    recordActivity({
      kind: "gate",
      text: `answering question ${pending.question.header}: ${answer.kind === "freeform" ? "Other" : answer.label}`,
    });
    setPendingUserQuestion(null);
    setQuestionSelected(0);
    setQuestionFreeformText("");
    setQuestionFreeformCursor(0);
    setQuestionFreeformKillBuffer(undefined);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: displayUserQuestionAnswer(pending.question.header, answer) },
    ]);
    beginUsageTurn();

    try {
      const outcome = await turnCancellation.run((signal) => resolveUserQuestion({
        engine: pending.engine,
        sessionId: pending.sessionId,
        messages: pending.messages,
        toolCallId: pending.toolCallId,
        question: pending.question,
        answer,
        providerSelection: activeProviderSelection(),
        generation: activeGeneration(),
        permission: { mode: permissionMode(), shellExecEnabled: shellExecEnabled(), ...(props.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}) },
        signal,
        onEvent: handleAgentEvent,
        agentManager,
        permissionBroker,
      }));
      if (outcome.kind === "interrupted") {
        setPendingUserQuestion(pending);
        setQuestionSelected(selectedIndex);
        handleInterruptedTurn();
      } else {
        handleResult(outcome.value, outcome.value.messages);
      }
    } catch (error) {
      setPendingUserQuestion(pending);
      setQuestionSelected(selectedIndex);
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Apply a runPrompt/resolveGate result. Shared by both paths so the
   * needs_user / complete branching stays in one place.
   */
  function beginUsageTurn(): void {
    activeTurnUsage = emptyUsageSummary();
    activeTurnAgentUsage = emptyUsageSummary();
    activeTurnUsagePublished = false;
    setLastTurnUsage(undefined);
  }

  function recordResponseUsage(usage: ResponseUsage): void {
    activeTurnUsage = addResponseUsageToTurn(activeTurnUsage, usage);
    activeTurnUsagePublished = false;
  }

  function recordIndependentAgentUsage(usage: ResponseUsage): void {
    activeTurnAgentUsage = addIndependentUsageToTurn(activeTurnAgentUsage, usage);
    activeTurnUsagePublished = false;
  }

  function publishTurnUsage(): void {
    const combined = mergeLogicalTurnUsage(activeTurnUsage, activeTurnAgentUsage);
    const usage = hasUsageSummary(combined) ? combined : undefined;
    setLastTurnUsage(usage);
    if (usage && !activeTurnUsagePublished) {
      setSessionUsage((current) => addTurnUsageToSession(current, usage));
      activeTurnUsagePublished = true;
    }
  }

  function handleResult(result: RunPromptResult, carriedMessages: VesicleMessage[]) {
    publishTurnUsage();
    if (result.kind === "needs_user") {
      setConversation([...result.messages]);
      setSessionId(result.sessionId);
      setSessionPath(result.sessionPath);
      setPendingGate({ ...result, engine: result.profile.id });
      setPendingEngineSwitch(null);
      setPendingUserQuestion(null);
      setPendingPermission(null);
      setQuestionFreeformText("");
      setQuestionFreeformCursor(0);
      setQuestionFreeformKillBuffer(undefined);
      setSessionPicker(null);
      setGateFocus("confirm");
      setGateFeedbackMode(null);
      setGateFeedback("");
      setGateFeedbackCursor(0);
      setGateFeedbackKillBuffer(undefined);
      setOutput(result.assistantContent);
      const alreadyDisplayed = lastDisplayedToolAssistantContent() === result.assistantContent;
      setMessages((prev) => [
        ...prev,
        ...(alreadyDisplayed ? [] : [{ role: "assistant" as const, content: result.assistantContent }]),
        { role: "system", content: `Stop gate pending: ${result.gate.gate}. Use ↑/↓ + Enter, or type into the amend box (Tab).` },
      ]);
      setStatus(`gate pending: ${result.gate.gate}`);
      return;
    }

    if (result.kind === "needs_engine_switch") {
      setConversation([...result.messages]);
      setSessionId(result.sessionId);
      setSessionPath(result.sessionPath);
      setPendingGate(null);
      setPendingEngineSwitch(result);
      setPendingUserQuestion(null);
      setQuestionFreeformText("");
      setQuestionFreeformCursor(0);
      setQuestionFreeformKillBuffer(undefined);
      setSessionPicker(null);
      setGateFocus("confirm");
      setGateFeedbackMode(null);
      setGateFeedback("");
      setGateFeedbackCursor(0);
      setGateFeedbackKillBuffer(undefined);
      setOutput(result.assistantContent);
      const alreadyDisplayed = lastDisplayedToolAssistantContent() === result.assistantContent;
      setMessages((prev) => [
        ...prev,
        ...(alreadyDisplayed ? [] : [{ role: "assistant" as const, content: result.assistantContent }]),
        { role: "system", content: `Engine switch requested: ${result.profile.id} -> ${result.request.targetEngine}. Confirm below to switch future turns.` },
      ]);
      setStatus(`engine switch pending: ${result.request.targetEngine}`);
      return;
    }

    if (result.kind === "needs_user_question") {
      setConversation([...result.messages]);
      setSessionId(result.sessionId);
      setSessionPath(result.sessionPath);
      setPendingGate(null);
      setPendingEngineSwitch(null);
      setPendingUserQuestion({ ...result, engine: result.profile.id });
      setPendingPermission(null);
      setQuestionSelected(0);
      setQuestionFreeformText("");
      setQuestionFreeformCursor(0);
      setQuestionFreeformKillBuffer(undefined);
      setSessionPicker(null);
      setOutput(result.assistantContent);
      const alreadyDisplayed = lastDisplayedToolAssistantContent() === result.assistantContent;
      setMessages((prev) => [
        ...prev,
        ...(alreadyDisplayed ? [] : [{ role: "assistant" as const, content: result.assistantContent }]),
        { role: "system", content: `Question pending: ${result.question.header}. Choose an option below to continue.` },
      ]);
      setStatus(`question pending: ${result.question.header}`);
      return;
    }

    if (result.kind === "needs_permission") {
      setConversation([...result.messages]);
      setSessionId(result.sessionId);
      setSessionPath(result.sessionPath);
      setPendingGate(null);
      setPendingEngineSwitch(null);
      setPendingUserQuestion(null);
      setPendingPermission({ ...result, engine: result.profile.id });
      setOutput(result.assistantContent);
      setMessages((prev) => [
        ...prev,
        ...(result.assistantContent && lastDisplayedToolAssistantContent() !== result.assistantContent
          ? [{ role: "assistant" as const, content: result.assistantContent }]
          : []),
        { role: "system", content: `Permission pending: ${result.request.toolName}.` },
      ]);
      setStatus(`permission pending: ${result.request.toolName}`);
      return;
    }

    setPendingGate(null);
    setPendingEngineSwitch(null);
    setPendingUserQuestion(null);
    setPendingPermission(null);
    setQuestionFreeformText("");
    setQuestionFreeformCursor(0);
    setQuestionFreeformKillBuffer(undefined);
    setGateFeedbackMode(null);
    setGateFeedback("");
    setGateFeedbackCursor(0);
    setGateFeedbackKillBuffer(undefined);
    setLastDisplayedToolAssistantContent(null);

    const profileValidation = result.validation;
    const ok = profileValidation ? profileValidation.ok : true;

    // CR B2: carry the loop's full message list forward rather than appending
    // to a stale snapshot. result.messages already contains every prior turn
    // including tool calls and their results, so the next user prompt builds
    // on a provider-valid view.
    setConversation([...result.messages]);
    setSessionId(result.sessionId);
    setSessionPath(result.sessionPath);
    setOutput(result.response.content);
    void refreshArtifacts();

    const appended: Message[] = [];
    const reasoningText = displayTextFromThinkingBlocks(result.response.thinkingBlocks) ?? result.response.reasoningContent;
    if (!result.response.toolCalls?.length && reasoningText?.trim()) {
      appended.push({ role: "system", content: reasoningText, kind: "reasoning" });
    }
    if (!result.response.toolCalls?.length && result.response.content.trim()) {
      appended.push({ role: "assistant", content: result.response.content, engine: activeEngine(), model: activeModel() });
    }
    if (profileValidation) {
      appended.push({ role: "system", content: renderValidationNotice(profileValidation) });
    }
    setMessages((prev) => [...prev, ...appended]);
    setStatus(ok ? "complete" : "complete with validation findings");
  }

  function reportError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus("error");
    setOutput(message);
    setStreamingAssistant("");
    setStreamingReasoning("");
    recordActivity({ kind: "system", text: `error: ${message}` });
    setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${message}` }]);
  }

  function handleInterruptedTurn() {
    setStatus("Interrupted");
    setStreamingAssistant("");
    setStreamingReasoning("");
    setLastDisplayedToolAssistantContent(null);
    recordActivity({ kind: "system", text: "request interrupted" });
  }

  async function restoreInterruptedPrompt(
    prompt: string,
    images: VesicleImageAttachment[] = [],
    elements: ComposerElement[] = [],
  ): Promise<void> {
    const id = sessionId();
    if (!id) return;
    const points = await listRewindPoints(process.cwd(), id);
    const point = [...points].reverse().find((entry) => entry.content.trim() === prompt.trim());
    if (!point) return;
    await applyConversationRewind(await rewindConversation(process.cwd(), id, point));
    setPromptHistory((previous) => previous.at(-1)?.value === prompt ? previous.slice(0, -1) : previous);
    applyComposerState({ value: prompt, cursor: prompt.length, elements: elements.map((element) => ({ ...element })) });
    setInputImages(images.map((image) => ({ ...image })));
  }

  // Name of the tool call currently streaming into shape. tool_call_delta only
  // carries `name` on the first chunk; the long arguments tail (e.g. a large
  // write_file content) has none, so remember it to hold the status on
  // "calling · {tool}" through the whole argument stream. Cleared per request.
  let formingToolName: string | undefined;

  function handleAgentEvent(event: AgentLoopEvent) {
    if (event.type === "agent_created"
      || event.type === "agent_started"
      || event.type === "agent_progress"
      || event.type === "agent_completed"
      || event.type === "agent_integrated") {
      setAgentCards((cards) => applyAgentEvent(cards, event));
      if (event.type === "agent_created") {
        setMessages((current) => current.some((message) => message.kind === "agent" && message.agentRunId === event.agent.runId)
          ? current
          : [...current, { role: "system", content: "", kind: "agent", agentRunId: event.agent.runId }]);
      }
    }
    const eventParentSessionId = event.type === "agent_created" || event.type === "agent_started"
      ? event.agent.parentSessionId
      : event.type === "agent_progress" || event.type === "agent_integrated"
        ? event.parentSessionId
        : event.type === "agent_completed"
          ? event.result.parentSessionId
          : undefined;
    const currentAgentEvent = eventParentSessionId === undefined
      || eventParentSessionId === sessionId()
      || (!sessionId() && busy());
    switch (event.type) {
      case "agent_created":
        recordActivity({ kind: "agent", text: `queued ${event.agent.profileId}: ${event.agent.description}` });
        return;
      case "agent_started":
        recordActivity({ kind: "agent", text: `started ${event.agent.handle}: ${event.agent.description}` });
        return;
      case "agent_progress":
        recordActivity({ kind: "agent", text: `${event.handle}: ${event.text}` });
        return;
      case "agent_completed":
        if (currentAgentEvent && event.result.mode === "foreground" && event.result.usage) {
          recordIndependentAgentUsage(event.result.usage);
        }
        recordActivity({ kind: "agent", text: `${event.result.status} ${event.result.handle}: ${event.result.description}` });
        return;
      case "agent_integrated":
        recordActivity({ kind: "agent", text: `integrated ${event.handle}` });
        return;
      case "process_update":
        applyProcessUpdate(event.callId, event.processEvent);
        if (event.processEvent.executionMode === "foreground") {
          setStatus(event.processEvent.status === "running"
            ? `running shell · ${Math.max(0, Math.round(event.processEvent.durationMs / 1000))}s`
            : `shell ${event.processEvent.status}`);
        }
        return;
      case "asset_drift": {
        const key = `${sessionId() ?? "unknown"}:${event.fingerprint}`;
        if (lastReportedAssetDriftKey === key) return;
        lastReportedAssetDriftKey = key;
        const changed = event.changedPaths.length > 0 ? event.changedPaths.join(", ") : "effective assets";
        setMessages((current) => [...current, {
          role: "system",
          content: `Asset drift detected since this session began: ${changed}. This continuation uses the current effective assets.`,
        }]);
        recordActivity({ kind: "system", text: `asset drift: ${changed}` });
        return;
      }
      case "provider_request":
        setStreamingAssistant("");
        setStreamingReasoning("");
        formingToolName = undefined;
        setStatus("sending request");
        recordActivity({ kind: "provider", text: `provider request #${event.iteration + 1}` });
        return;
      case "assistant_delta":
        setStreamingAssistant((prev) => `${prev}${event.delta}`);
        setStatus("generating response");
        return;
      case "assistant_reasoning_delta":
        setStreamingReasoning((prev) => `${prev}${event.delta}`);
        setStatus("generating response");
        return;
      case "tool_call_delta":
        if (event.name) {
          formingToolName = event.name;
          recordActivity({ kind: "tool", text: `tool call forming: ${event.name}` });
        }
        // `name` only arrives on the first chunk; the long arguments tail has
        // none, so reuse the remembered name to stay on "calling · {tool}".
        setStatus(formingToolName ? `calling · ${formingToolName}` : "generating response");
        return;
      case "assistant_response":
        activeTurnSawResponse = true;
        setStreamingAssistant("");
        setStreamingReasoning("");
        const responseUsage = event.usage;
        if (responseUsage) {
          recordResponseUsage(responseUsage);
        }
        if (event.toolCalls.length > 0) {
          const reasoningText = displayTextFromThinkingBlocks(event.thinkingBlocks) ?? event.reasoningContent;
          if (reasoningText) appendReasoningMessage(reasoningText);
        }
        if (event.toolCalls.length > 0) {
          // Show only the assistant prose; the calls themselves render as inline
          // tool cards via the tool_call/tool_result events that follow. An
          // empty-prose tool turn pushes no assistant message.
          if (event.content.trim()) {
            setMessages((prev) => [...prev, { role: "assistant", content: event.content, engine: activeEngine(), model: activeModel() }]);
          }
          setLastDisplayedToolAssistantContent(event.content);
        }
        recordActivity({
          kind: "assistant",
          text: event.toolCalls.length > 0
            ? `assistant response with ${event.toolCalls.length} tool call${event.toolCalls.length > 1 ? "s" : ""}`
            : "assistant response complete",
        });
        return;
      case "tool_call":
        if (event.name === "spawn_agent") {
          setStatus("starting SubAgent");
          recordActivity({ kind: "agent", text: "spawn_agent requested" });
          return;
        }
        setMessages((prev) => [
          ...prev,
          { role: "tool", toolStage: "call", toolName: event.name, toolArgs: event.arguments, toolCallId: event.callId, content: "" },
        ]);
        setStatus(`calling · ${event.name}`);
        recordActivity({ kind: "tool", text: `calling ${event.name}` });
        return;
      case "tool_result":
        if (event.name === "spawn_agent") {
          if (!event.ok) {
            setStatus("SubAgent launch failed");
            setMessages((current) => [...current, {
              role: "system",
              content: `SubAgent launch failed: ${event.content}`,
            }]);
          }
          recordActivity({ kind: "agent", text: `${event.ok ? "ok" : "failed"} spawn_agent` });
          return;
        }
        const latestBackgroundProcess = event.processEvent?.taskId
          ? backgroundProcesses().find((process) => process.taskId === event.processEvent?.taskId)
          : undefined;
        const displayedProcessEvent = latestBackgroundProcess ? processEventFromTask(latestBackgroundProcess) : event.processEvent;
        setMessages((prev) => {
          // Merge the outcome onto the matching call card so its diff can show
          // the affected line range (matchLines → git-style hunk + gutter),
          // then add the `⎿` footer beneath it.
          const next = prev.map((m) =>
            m.toolCallId === event.callId && m.toolStage === "call"
              ? { ...m, toolFileEvent: event.fileEvent, toolWebEvent: event.webEvent, toolMcpEvent: event.mcpEvent, toolProcessEvent: displayedProcessEvent, toolOk: event.ok, images: event.images }
              : m,
          );
          next.push({
            role: "tool",
            toolStage: "result",
            toolName: event.name,
            toolCallId: event.callId,
            toolOk: event.ok,
            toolFileEvent: event.fileEvent,
            toolWebEvent: event.webEvent,
            toolMcpEvent: event.mcpEvent,
            toolProcessEvent: displayedProcessEvent,
            images: event.images,
            // Content is only needed for failure messages; on success the
            // structured fileEvent/webEvent/mcpEvent carries the footer detail.
            content: event.ok ? "" : event.content,
          });
          return next;
        });
        recordActivity({ kind: "tool", text: `${event.ok ? "ok" : "failed"} ${event.name}: ${event.content}` });
        return;
      case "gate_pending":
        recordActivity({ kind: "gate", text: `gate pending: ${event.gate}` });
        return;
      case "engine_switch_pending":
        recordActivity({ kind: "gate", text: `engine switch pending: ${event.targetEngine}` });
        return;
      case "user_question_pending":
        recordActivity({ kind: "gate", text: `question pending: ${event.header}` });
        return;
      case "validation":
        recordActivity({ kind: "validation", text: event.ok ? "validation passed" : "validation found issues" });
        return;
    }
  }

  function handleBackgroundProcessEvent(event: BackgroundProcessEvent): void {
    const process = event.process;
    setBackgroundProcesses((current) => {
      const index = current.findIndex((candidate) => candidate.taskId === process.taskId);
      if (index < 0) return [...current, process];
      return current.map((candidate, candidateIndex) => candidateIndex === index ? process : candidate);
    });
    applyProcessUpdate(process.parentToolCallId, processEventFromTask(process));
    if (process.status !== "running") {
      recordActivity({ kind: "tool", text: `${process.taskId} ${process.status}${process.exitCode !== undefined ? ` · exit ${process.exitCode}` : ""}` });
    }
  }

  function applyProcessUpdate(callId: string, processEvent: import("../core/tools").ProcessToolEvent): void {
    setMessages((current) => current.map((message) =>
      message.toolCallId === callId ? { ...message, toolProcessEvent: processEvent } : message
    ));
  }

  function recordActivity(entry: ActivityEntry) {
    setActivity((prev) => [...prev, entry].slice(-60));
  }

  function appendReasoningMessage(content: string) {
    if (!content.trim()) return;
    setMessages((prev) => [...prev, { role: "system", content, kind: "reasoning" }]);
  }

  async function refreshProviderConfig(selection?: Partial<ProviderSelection>) {
    const inspected = await inspectProviderConfig(selection);
    setProviderRegistry(inspected.registry);
    setActiveProvider(inspected.providerId);
    setActiveModel(inspected.model);
    setActiveModelLimits(inspected.limits);
    setActiveModelCapabilities(inspected.capabilities);
    setProviderHasApiKey(inspected.hasApiKey);
    recordActivity({
      kind: "provider",
      text: `active ${inspected.providerId}/${inspected.model} (${inspected.registry.source})`,
    });
    setProviderConfigReady(true);
    setStatus(inspected.hasApiKey ? "ready" : `missing API key for ${inspected.providerId}`);
  }

  async function refreshMcpStatus() {
    setMcpStatus((current) => ({ ...current, loading: true }));
    const inspected = await inspectMcpConfig();
    setMcpStatus({
      loading: false,
      configured: inspected.configured,
      enabled: inspected.enabled,
      servers: inspected.statuses.map((status) => ({
        id: status.id,
        enabled: status.enabled,
        connected: status.connected,
        toolCount: status.toolCount,
        ...(status.error ? { error: status.error } : {}),
      })),
    });
  }

  async function ensureProviderRegistry(): Promise<ProviderRegistry> {
    const existing = providerRegistry();
    if (existing) return existing;
    await loadProviderConfigOnce();
    const loaded = providerRegistry();
    if (!loaded) throw new Error("Provider registry did not load.");
    return loaded;
  }

  function loadProviderConfigOnce(): Promise<void> {
    providerConfigLoad ??= refreshProviderConfig().finally(() => {
      providerConfigLoad = null;
    });
    return providerConfigLoad;
  }

  function loadPermissionSettingsOnce(): Promise<void> {
    permissionSettingsLoad ??= loadPermissionSettings().then((settings) => {
      setShellExecEnabled(props.dangerouslySkipPermissions === true || settings.shellExec);
      if (!props.dangerouslySkipPermissions) setPermissionMode(settings.defaultMode);
      setPermissionSettingsReady(true);
    }).finally(() => {
      permissionSettingsLoad = null;
    });
    return permissionSettingsLoad;
  }

  async function applyProviderSelection(selection: Partial<ProviderSelection>): Promise<ProviderSelection> {
    const inspected = await inspectProviderConfig(selection);
    setProviderRegistry(inspected.registry);
    setActiveProvider(inspected.providerId);
    setActiveModel(inspected.model);
    setActiveModelLimits(inspected.limits);
    setActiveModelCapabilities(inspected.capabilities);
    setProviderHasApiKey(inspected.hasApiKey);
    setStatus(inspected.hasApiKey ? "ready" : `missing API key for ${inspected.providerId}`);
    recordActivity({ kind: "provider", text: `switched to ${inspected.providerId}/${inspected.model}` });
    return { provider: inspected.providerId, model: inspected.model };
  }

  function activeProviderSelection(): ProviderSelection {
    return { provider: activeProvider(), model: activeModel() };
  }

  function activeGeneration() {
    const reasoningTier = thinkingTier();
    return reasoningTier ? { reasoningTier } : undefined;
  }

  async function persistProviderSwitch(selection: ProviderSelection) {
    await appendHostSessionRecord({
      role: "system",
      content: `Provider switched to ${selection.provider}/${selection.model}.`,
      metadata: {
        kind: "provider-switch",
        providerId: selection.provider,
        model: selection.model,
      },
    });
  }

  async function persistEngineSwitch(transition: EngineTransition) {
    await appendHostSessionRecord({
      role: "system",
      content: `Engine switched to ${transition.toEngine}.`,
      metadata: {
        kind: "engine-switch",
        engine: transition.toEngine,
        targetEngine: transition.toEngine,
        reason: transition.reason,
        handoffSummary: transition.handoffSummary,
        ...(transition.recommendedNextAction ? { recommendedNextAction: transition.recommendedNextAction } : {}),
        transition,
      },
    });
    const packet = renderEngineHandoffPacket(transition);
    const appended = await appendHostSessionRecord({
      role: "user",
      content: packet,
      metadata: {
        kind: ENGINE_HANDOFF_KIND,
        engine: transition.toEngine,
        transition,
      },
    });
    if (appended) {
      setConversation((prev) => [...prev, { role: "user", content: packet }]);
    }
  }

  async function persistThinkingSwitch(tier: ReasoningTier | undefined) {
    await appendHostSessionRecord({
      role: "system",
      content: tier ? `Thinking effort switched to ${tier}.` : "Thinking effort reset to provider default.",
      metadata: {
        kind: "thinking-switch",
        reasoningTier: tier ?? null,
      },
    });
  }

  async function persistReasoningSwitch(mode: ReasoningDisplayMode) {
    await appendHostSessionRecord({
      role: "system",
      content: `Reasoning display switched to ${mode}.`,
      metadata: {
        kind: "reasoning-switch",
        reasoningDisplayMode: mode,
      },
    });
  }

  async function changePermissionMode(mode: PermissionMode): Promise<void> {
    if (mode === "YOLO" && permissionMode() !== "YOLO" && !props.dangerouslySkipPermissions) {
      setGateFocus("confirm");
      setYoloConfirmStage(1);
      setStatus("confirm YOLO permission mode");
      return;
    }
    await applyPermissionMode(mode);
  }

  async function applyPermissionMode(mode: PermissionMode): Promise<void> {
    setPermissionMode(mode);
    setStatus(`permission mode ${mode}`);
    await appendHostSessionRecord({
      role: "system",
      content: `Permission mode switched to ${mode}.`,
      metadata: { kind: "permission-mode-switch", permissionMode: mode },
    });
    setMessages((prev) => [...prev, {
      role: "system",
      content: mode === "YOLO"
        ? "DANGER: YOLO enabled for this process. All tool approvals are bypassed; runtime hard guards remain active."
        : `Permission mode switched to ${mode}.`,
    }]);
  }

  async function appendHostSessionRecord(record: { role: "system" | "user"; content: string; metadata: Record<string, unknown> }) {
    const id = sessionId();
    if (!id) return undefined;
    const branch = nextSessionParent();
    const store = await createSessionStore(
      process.cwd(),
      id,
      branch ? { parentUuid: branch.uuid } : {},
    );
    const appended = await store.append(record);
    if (branch) setNextSessionParent({ uuid: appended.uuid });
    return appended;
  }

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
    setSessionId,
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
    openRewindPicker: rewindController.open,
    resetRewindState,
    agentCommand,
    openModelPicker,
  };

  async function agentCommand(args: string): Promise<string> {
    const id = sessionId();
    const [action, target] = args.trim().split(/\s+/, 2);
    if (action === "stop") {
      if (!target) return "Usage: /agents stop <agent-handle>";
      if (!id) return "No active session.";
      const interrupted = await agentManager.interrupt(target, id);
      return interrupted ? `Interrupt requested for ${target}.` : `SubAgent is not running: ${target}.`;
    }
    if (action === "retry" && !target) {
      if (!id) return "No active session.";
      void retryAgentDelivery(pausedAgentDeliveries, id, (session) => continuationScheduler.notify(session)).catch(reportError);
      return "SubAgent result delivery retry scheduled.";
    }
    if (action && !target) {
      if (!id) return "No active session.";
      const agent = await agentStore.resolveReference(id, action);
      if (!agent) return `Unknown SubAgent: ${action}.`;
      const inbox = (await agentStore.listInbox(id)).filter((entry) => entry.runId === agent.runId);
      const card = agentCards().find((candidate) => candidate.runId === agent.runId)
        ?? agentCardFromMetadata(agent, inbox);
      return renderAgentDetail(agent, card, inbox);
    }
    if (args.trim()) return "Usage: /agents [handle|stop <handle>|retry]";
    const profiles = await listAgentProfiles(process.cwd());
    const agents = id ? await agentStore.listByParent(id) : [];
    const inbox = id ? await agentStore.listInbox(id) : [];
    const lines = ["Agent Profiles:"];
    for (const profile of profiles) {
      lines.push(`  ${profile.id} [${profile.defaultMode}/${profile.contextMode}] - ${profile.description}`);
    }
    lines.push("", "Current session SubAgents:");
    if (agents.length === 0) lines.push("  (none)");
    for (const agent of agents) {
      const card = agentCards().find((candidate) => candidate.runId === agent.runId)
        ?? agentCardFromMetadata(agent, inbox);
      lines.push(`  ${agent.handle} [${card.status}/${agent.mode}] ${agent.description}`);
    }
    lines.push("", "Use /agents <handle> for details, /agents stop <handle> to interrupt, or /agents retry after a delivery error.");
    return lines.join("\n");
  }

  async function resumeSession(target: SessionSummary, commandEcho?: string) {
    setRestoringSession(true);
    try {
      if (!permissionSettingsReady()) await loadPermissionSettingsOnce();
      const snapshot = await loadSessionSnapshot(process.cwd(), target.sessionId, {
        synthesizeDanglingToolResults: false,
      });
      const liveProcesses = await processManager.list(target.sessionId);
      const liveProcessesByTaskId = new Map(liveProcesses.map((process) => [process.taskId, process]));
      for (const message of snapshot.messages) {
        const taskId = message.toolProcessEvent?.taskId;
        const live = taskId ? liveProcessesByTaskId.get(taskId) : undefined;
        if (live) message.toolProcessEvent = processEventFromTask(live);
      }
      const resumedMessages = vesicleMessagesFromResumed(snapshot.messages);
      // Tool-call arguments live on the assistant record's toolCalls; build a
      // callId → {name, arguments} lookup so resumed tool results can render
      // the same inline cards as live tool calls.
      const argsByCallId = new Map<string, { name: string; arguments: string }>();
      for (const m of snapshot.messages) {
        if (m.toolCalls) {
          for (const tc of m.toolCalls) argsByCallId.set(tc.id, { name: tc.name, arguments: tc.arguments });
        }
      }
      const [storedAgents, storedInbox] = await Promise.all([
        agentStore.listByParent(target.sessionId),
        agentStore.listInbox(target.sessionId),
      ]);
      const restoredAgentCards = storedAgents.map((agent) => agentCardFromMetadata(agent, storedInbox));
      setAgentCards((current) => mergeRestoredAgentCards(current, target.sessionId, restoredAgentCards));
      const agentsByToolCallId = new Map(restoredAgentCards.map((agent) => [agent.parentToolCallId, agent]));
      const transcript = snapshot.messages.flatMap((m) => displayMessagesFromResumed(m, argsByCallId, agentsByToolCallId));
      const restoredEngine = snapshot.engine ?? "etl";
      setSessionId(target.sessionId);
      setNextSessionParent(null);
      setSessionPath(joinSessionPath(target.sessionId));
      setActiveEngine(restoredEngine);
      setConversation(resumedMessages);
      setLastTurnUsage(latestTurnUsage(snapshot.messages));
      setSessionUsage(sumSessionUsage(snapshot.messages));
      setOutput(snapshot.pendingGate?.assistantContent ?? snapshot.pendingEngineSwitch?.assistantContent ?? snapshot.pendingUserQuestion?.assistantContent ?? "");
      setSessionPicker(null);

      const hostMessages: Message[] = [];
      if (commandEcho) hostMessages.push({ role: "user", content: commandEcho });
      hostMessages.push({ role: "system", content: `Restored engine ${restoredEngine} from session.` });
      const restoredPermissionMode = props.dangerouslySkipPermissions
        ? "YOLO"
        : snapshot.permissionMode === "YOLO"
          ? "MOMENTUM"
          : snapshot.permissionMode ?? permissionMode();
      setPermissionMode(restoredPermissionMode);
      hostMessages.push({ role: "system", content: snapshot.permissionMode === "YOLO" && !props.dangerouslySkipPermissions
        ? "Previous YOLO permission mode was downgraded to MOMENTUM on resume. Re-enable YOLO explicitly if needed."
        : `Restored permission mode ${restoredPermissionMode}.` });
      const assetDrift = await inspectEngineAssetDrift(snapshot.assets, restoredEngine, process.cwd());
      if (assetDrift) {
        lastReportedAssetDriftKey = `${target.sessionId}:${assetDrift.current.sha256}`;
        const changed = assetDrift.changedPaths.length > 0
          ? assetDrift.changedPaths.join(", ")
          : "effective profile/prompt assets";
        hostMessages.push({
          role: "system",
          content: `Asset drift detected since this session began: ${changed}. Continued turns use the current effective assets.`,
        });
      }
      if (snapshot.providerSelection) {
        try {
          const selection = await applyProviderSelection(snapshot.providerSelection);
          hostMessages.push({ role: "system", content: `Restored provider ${selection.provider}/${selection.model} from session.` });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          hostMessages.push({ role: "system", content: `Session provider was not restored: ${message}` });
        }
      }
      if (snapshot.reasoningTier) {
        setThinkingTier(snapshot.reasoningTier);
        hostMessages.push({ role: "system", content: `Restored thinking effort ${snapshot.reasoningTier} from session.` });
      }
      if (snapshot.reasoningDisplayMode) {
        setReasoningDisplayMode(snapshot.reasoningDisplayMode);
        hostMessages.push({ role: "system", content: `Restored reasoning display ${snapshot.reasoningDisplayMode} from session.` });
      }

      if (snapshot.pendingPermission) {
        setPendingGate(null);
        setPendingEngineSwitch(null);
        setPendingUserQuestion(null);
        setPendingPermission({
          kind: "needs_permission",
          sessionId: target.sessionId,
          sessionPath: joinSessionPath(target.sessionId),
          engine: restoredEngine,
          request: snapshot.pendingPermission,
          remainingToolCalls: unresolvedToolCalls(snapshot.messages, snapshot.pendingPermission.toolCallId),
          assistantContent: "",
          messages: resumedMessages,
        });
        setGateFocus("confirm");
        setGateFeedbackMode(null);
        setGateFeedback("");
        setGateFeedbackCursor(0);
        setGateFeedbackKillBuffer(undefined);
        setStatus(`permission pending: ${snapshot.pendingPermission.toolName}`);
        hostMessages.push({ role: "system", content: `Resumed pending permission for ${snapshot.pendingPermission.toolName}.` });
      } else if (snapshot.pendingGate) {
        setPendingPermission(null);
        setPendingUserQuestion(null);
        setPendingGate({
          kind: "needs_user",
          sessionId: target.sessionId,
          sessionPath: joinSessionPath(target.sessionId),
          engine: restoredEngine,
          gate: snapshot.pendingGate.gate,
          toolCallId: snapshot.pendingGate.toolCallId,
          assistantContent: snapshot.pendingGate.assistantContent,
          messages: resumedMessages,
        });
        setGateFocus("confirm");
        setGateFeedbackMode(null);
        setGateFeedback("");
        setGateFeedbackCursor(0);
        setGateFeedbackKillBuffer(undefined);
        setStatus(`gate pending: ${snapshot.pendingGate.gate.gate}`);
        hostMessages.push({
          role: "system",
          content: `Resumed pending gate ${snapshot.pendingGate.gate.gate}. Use the gate controls below to continue.`,
        });
      } else if (snapshot.pendingEngineSwitch) {
        setPendingPermission(null);
        setPendingGate(null);
        setPendingUserQuestion(null);
        setPendingEngineSwitch({
          kind: "needs_engine_switch",
          sessionId: target.sessionId,
          sessionPath: joinSessionPath(target.sessionId),
          request: snapshot.pendingEngineSwitch.request,
          toolCallId: snapshot.pendingEngineSwitch.toolCallId,
          assistantContent: snapshot.pendingEngineSwitch.assistantContent,
          messages: resumedMessages,
        });
        setGateFocus("confirm");
        setGateFeedbackMode(null);
        setGateFeedback("");
        setGateFeedbackCursor(0);
        setGateFeedbackKillBuffer(undefined);
        setStatus(`engine switch pending: ${snapshot.pendingEngineSwitch.request.targetEngine}`);
        hostMessages.push({
          role: "system",
          content: `Resumed pending engine switch to ${snapshot.pendingEngineSwitch.request.targetEngine}. Use the gate controls below to continue.`,
        });
      } else if (snapshot.pendingUserQuestion) {
        setPendingPermission(null);
        setPendingGate(null);
        setPendingEngineSwitch(null);
        setPendingUserQuestion({
          kind: "needs_user_question",
          sessionId: target.sessionId,
          sessionPath: joinSessionPath(target.sessionId),
          engine: restoredEngine,
          question: snapshot.pendingUserQuestion.question,
          toolCallId: snapshot.pendingUserQuestion.toolCallId,
          assistantContent: snapshot.pendingUserQuestion.assistantContent,
          messages: resumedMessages,
        });
        setQuestionSelected(0);
        setQuestionFreeformText("");
        setQuestionFreeformCursor(0);
        setQuestionFreeformKillBuffer(undefined);
        setStatus(`question pending: ${snapshot.pendingUserQuestion.question.header}`);
        hostMessages.push({
          role: "system",
          content: `Resumed pending question ${snapshot.pendingUserQuestion.question.header}. Choose an option below to continue.`,
        });
      } else {
        setPendingGate(null);
        setPendingEngineSwitch(null);
        setPendingUserQuestion(null);
        setPendingPermission(null);
        setQuestionFreeformText("");
        setQuestionFreeformCursor(0);
        setQuestionFreeformKillBuffer(undefined);
        setGateFeedbackMode(null);
        setGateFeedback("");
        setGateFeedbackCursor(0);
        setGateFeedbackKillBuffer(undefined);
        setStatus(`resumed ${target.sessionId.slice(11)}`);
        hostMessages.push({
          role: "system",
          content: `Resumed session ${target.sessionId} with ${snapshot.messages.length} prior turns. Continue below.`,
        });
      }

      setMessages([...transcript, ...hostMessages]);
      await refreshArtifacts();
    } catch (error) {
      reportError(error);
    } finally {
      setRestoringSession(false);
    }
  }

  async function refreshArtifacts(): Promise<ArtifactEntry[]> {
    const entries = await scanArtifacts(process.cwd());
    setArtifacts(entries);
    setSelectedArtifact((selected) => selected && entries.some((entry) => entry.path === selected.path) ? selected : null);
    return entries;
  }

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={palette.bg}>
      <box height={3} border borderColor={palette.panelBorder} paddingX={1} flexDirection="row">
        <text
          content={headerLine(activeEngine(), layout().width, agentActivitySummary(agentCards()), backgroundProcessActivitySummary(backgroundProcesses()))}
          fg={engineAccent(activeEngine())}
          attributes={1}
        />
        <Show when={permissionMode() === "YOLO"} fallback={<box width={0} />}>
          <text content={props.dangerouslySkipPermissions ? "  YOLO · CLI OVERRIDE" : "  YOLO"} fg={palette.error} attributes={1} />
        </Show>
      </box>

      <box flexDirection="row" flexGrow={1}>
        <Show when={layout().showSidebar} fallback={<box width={0} />}>
          <Sidebar
            status={status()}
            thinkingTier={thinkingTier()}
            reasoningMode={reasoningDisplayMode()}
            sessionPath={sessionPath()}
            mcp={mcpStatus()}
            artifacts={artifacts()}
            selectedArtifactPath={selectedArtifact()?.path}
            agents={agentCards()}
            processes={backgroundProcesses()}
            currentSessionId={sessionId()}
            width={layout().leftPanelWidth}
          />
        </Show>

        <MessageStream
          messages={messages()}
          streamingReasoning={streamingReasoning()}
          streamingAssistant={streamingAssistant()}
          reasoningMode={reasoningDisplayMode()}
          contentWidth={layout().width - (layout().showSidebar ? layout().leftPanelWidth : 0) - 12}
          agents={agentCards()}
        />

        {/* The former right-hand Activity / Artifacts pane was removed in the
            TUI rewrite. Agent-loop activity and artifact detail now fold into
            the message stream itself (tool-call rendering, Phase D). The left
            Workspace sidebar holds the persistent artifact list. */}
      </box>

      <Show
        when={yoloConfirmStage()}
        fallback={
          <Show
            when={activePermissionRequest()}
            fallback={
          <Show
            when={pendingUserQuestion()}
            fallback={
          <Show
            when={activeGateRequest()}
            fallback={
              <Show
                when={rewindPicker()}
                fallback={
                  <Show
                    when={sessionPicker()}
                    fallback={
                      <Show when={modelPicker()} fallback={
                        <box height={inputNeedsExpandedBottom() ? layout().bottomHeight : 3} border borderColor={palette.panelBorder} paddingX={1} flexDirection="column">
                      <Show when={commandMenuOpen()} fallback={
                        <Show when={commandArgumentMenuOpen()} fallback={<box height={0} />}>
                          <box flexDirection="column">
                            <ArgumentMenu
                              items={commandArgumentItems()}
                              selected={commandArgumentSelected()}
                              width={layout().width - 4}
                              maxVisible={composerPopupMaxRows()}
                            />
                            <text content={commandArgumentHint(modelArgumentDraft(), fixedArgumentDraft(), agentArgumentDraft())} fg={palette.textDim} />
                          </box>
                        </Show>
                      }>
                        <box flexDirection="column">
                          <CommandMenu
                            commands={commandMenuItems()}
                            selected={commandMenuSelected()}
                            width={layout().width - 4}
                            maxVisible={composerPopupMaxRows()}
                          />
                          <text content="↑/↓ choose · Tab/Enter complete · Esc cancel" fg={palette.textDim} />
                        </box>
                      </Show>
                      <PromptComposer
                        value={inputValue()}
                        cursor={inputCursor()}
                        placeholder={busy() ? "Request in flight..." : !providerConfigReady() ? "Loading provider config..." : "Type prompt, Enter send, Ctrl+Enter newline, /help commands"}
                        width={composerInputWidth()}
                        maxLines={Math.max(1, layout().bottomHeight - (composerPopupOpen() ? composerPopupMaxRows() + 3 : 2))}
                      />
                        </box>
                      }>
                        {(mp) => (
                          <box height={layout().bottomHeight}>
                            <OptionPicker
                              title={modelPickerTitle(mp())}
                              items={modelPickerItems()}
                              selected={mp().selected}
                              width={layout().width}
                              hint="↑/↓ choose · Enter select · Esc back"
                              maxVisible={Math.max(1, layout().bottomHeight - 3)}
                            />
                          </box>
                        )}
                      </Show>
                    }
                  >
                    {(picker) => (
                      <box height={layout().bottomHeight}>
                        <SessionPicker sessions={picker().sessions} selected={picker().selected} width={layout().width} />
                      </box>
                    )}
                  </Show>
                }
              >
                {(picker) => (
                  <box height={layout().bottomHeight}>
                    <RewindPicker state={picker()} width={layout().width} />
                  </box>
                )}
              </Show>
            }
          >
            {(g) => (
              <box height={layout().bottomHeight}>
                <GatePrompt
                  gate={g()}
                  focused={gateFocus()}
                  feedbackMode={gateFeedbackMode()}
                  feedback={gateFeedback()}
                  feedbackCursor={gateFeedbackCursor()}
                  width={layout().width}
                  maxSummaryLines={gateSummaryLineBudget(
                    layout().summaryLines,
                    gateComposerIsActive(gateFocus(), gateFeedbackMode()),
                    pendingEngineSwitch() ? 1 : 0,
                  )}
                  showSummaryOption={Boolean(pendingEngineSwitch())}
                />
              </box>
            )}
          </Show>
            }
          >
            {(question) => (
              <box height={layout().bottomHeight}>
                <QuestionPrompt
                  question={question().question}
                  selected={questionSelected()}
                  width={layout().width}
                  freeformValue={questionFreeformText()}
                  freeformCursor={questionFreeformCursor()}
                />
              </box>
            )}
          </Show>
            }
          >
            {(permission) => (
              <box height={layout().bottomHeight}>
                <PermissionPrompt
                  request={permission()}
                  focused={gateFocus()}
                  feedbackMode={gateFeedbackMode()}
                  feedback={gateFeedback()}
                  feedbackCursor={gateFeedbackCursor()}
                  width={layout().width}
                />
              </box>
            )}
          </Show>
        }
      >
        {(stage) => (
          <box height={layout().bottomHeight}>
            <YoloPrompt stage={stage()} focused={gateFocus()} width={layout().width} />
          </box>
        )}
      </Show>
      <box height={layout().footerHeight} paddingLeft={1}>
        <text
          content={footerLine(activeProvider(), activeModel(), providerHasApiKey(), layout().width, lastTurnUsage(), sessionUsage(), activeModelLimits())}
          fg={palette.textMuted}
        />
      </box>
    </box>
  );
}

function composerElementsForImages(value: string, images: VesicleImageAttachment[]): ComposerElement[] {
  const matches = [...value.matchAll(/\[Image #\d+\]/g)];
  return images.flatMap((image, index) => {
    const match = matches[index];
    if (!match || match.index === undefined) return [];
    return [{
      type: "image" as const,
      attachmentId: image.id,
      placeholder: match[0],
      start: match.index,
      end: match.index + match[0].length,
    }];
  });
}

function unresolvedToolCalls(messages: ResumedMessage[], activeToolCallId: string) {
  const answered = new Set(messages.flatMap((message) => message.toolCallId ? [message.toolCallId] : []));
  for (let index = messages.length - 1; index >= 0; index--) {
    const calls = messages[index].toolCalls;
    if (!calls?.some((call) => call.id === activeToolCallId)) continue;
    return calls.filter((call) => call.id !== activeToolCallId && !answered.has(call.id));
  }
  return [];
}

function engineSwitchGateRequest(currentEngine: EngineId, request: EngineSwitchRequest): GateRequest {
  const lines = [
    `Current Engine: ${currentEngine}`,
    `Target Engine: ${request.targetEngine}`,
    "",
    `Reason: ${request.reason}`,
    "",
    `Handoff Summary: ${request.handoffSummary}`,
  ];
  if (request.recommendedNextAction) {
    lines.push("", `Recommended Next Action: ${request.recommendedNextAction}`);
  }
  return {
    gate: "engine-switch",
    summary: lines.join("\n"),
    options: [
      { label: `Confirm - switch to ${request.targetEngine}`, decision: "confirm" },
      { label: `Reject - stay on ${currentEngine} and discuss`, decision: "reject" },
    ],
  };
}

function permissionResolutionFromGate(resolution: GateResolution): PermissionResolution {
  const resolvedAt = new Date().toISOString();
  return resolution.decision === "confirm"
    ? { decision: "allow_once", resolvedAt }
    : {
        decision: "reject",
        resolvedAt,
        ...(resolution.feedback ? { feedback: resolution.feedback } : {}),
      };
}

function displayUserQuestionAnswer(header: string, answer: UserQuestionAnswer): string {
  if (answer.kind === "skip") return `[question:${header}] skipped`;
  if (answer.kind === "freeform") return `[question:${header}] ${answer.freeformText ?? answer.label}`;
  return `[question:${header}] ${answer.label}`;
}

export function headerLine(engine: EngineId, width: number, agents?: string, processes?: string): string {
  const left = `Prism Vesicle · ${engineDisplayName(engine)}`;
  const content = [left, ...(agents ? [`Agents ${agents}`] : []), ...(processes ? [`Shell ${processes}`] : [])].join(" · ");
  return truncateLine(content, Math.max(20, width - 4));
}

export function backgroundProcessActivitySummary(processes: BackgroundProcessState[]): string | undefined {
  const running = processes.filter((process) => process.status === "running").length;
  return running > 0 ? `${running} running` : undefined;
}

/**
 * Bottom telemetry line: connection identity plus current-turn and session
 * token counters. A turn is one logical user/gate/question input through the
 * provider tool loop that follows. Repeated provider requests inside the same
 * turn reuse most of the same context, so upstream/cache counters use the
 * latest request's context occupancy while downstream output still sums newly
 * generated tokens. Pricing intentionally stays out of this layer; adapters
 * only normalize runtime usage facts.
 */
export function footerLine(
  provider: string,
  model: string,
  hasKey: boolean,
  width: number,
  turnUsage?: TokenUsageSummary,
  sessionUsage?: TokenUsageSummary,
  modelLimits?: ModelLimits,
): string {
  const turnTelemetry = turnUsageTelemetryLine(turnUsage);
  const sessionTelemetry = sessionUsageTelemetryLine(sessionUsage);
  const contextTelemetry = contextUsageTelemetryLine(turnUsage, modelLimits);
  const left = `${provider}/${model} · key ${hasKey ? "ok" : "missing"}${turnTelemetry ? ` · ${turnTelemetry}` : ""}${sessionTelemetry ? ` · ${sessionTelemetry}` : ""}`;
  return footerWithRightTelemetry(left, contextTelemetry, Math.max(20, width - 2));
}

export function turnUsageTelemetryLine(usage: TokenUsageSummary | undefined): string | undefined {
  if (!usage) return undefined;
  if (!hasUsageSummary(usage)) return undefined;
  const parts: string[] = [];
  parts.push("turn", tokenArrowPair(usage));
  const cached = formatTokenCount(usage.cachedInputTokens);
  if (cached && usage.cachedInputTokens > 0) parts.push(`↻ ${cached}`);
  return parts.join(" ");
}

export function sessionUsageTelemetryLine(usage: TokenUsageSummary | undefined): string | undefined {
  if (!usage) return undefined;
  if (!hasUsageSummary(usage)) return undefined;
  return `session ${tokenArrowPair(usage)} ↻ ${formatTokenCount(usage.cachedInputTokens) ?? "0"}`;
}

export function contextUsageTelemetryLine(usage: TokenUsageSummary | undefined, modelLimits: ModelLimits | undefined): string | undefined {
  const contextWindow = modelLimits?.contextWindow;
  if (!usage || !contextWindow || contextWindow <= 0 || usage.contextInputTokens <= 0) return undefined;
  return `ctx ${formatTokenCount(usage.contextInputTokens)}/${formatTokenCount(contextWindow)} ${formatContextPercent(usage.contextInputTokens, contextWindow)}`;
}

function footerWithRightTelemetry(left: string, right: string | undefined, width: number): string {
  if (!right) return truncateLine(left, width);
  const gap = 4;
  if (right.length + gap >= width) return truncateLine(right, width);
  const leftWidth = width - right.length - gap;
  const leftText = truncateLine(left, leftWidth);
  const padding = Math.max(gap, width - leftText.length - right.length);
  return `${leftText}${" ".repeat(padding)}${right}`;
}

function tokenArrowPair(usage: TokenUsageSummary): string {
  return `↑${formatTokenCount(usage.inputTokens) ?? "0"} ↓${formatTokenCount(usage.outputTokens) ?? "0"}`;
}

function formatTokenCount(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatContextPercent(used: number, total: number): string {
  const percent = (used / total) * 100;
  return percent < 1 && percent > 0 ? "<1%" : `${Math.round(percent)}%`;
}

function emptyUsageSummary(): TokenUsageSummary {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, contextInputTokens: 0 };
}

function addResponseUsageToTurn(current: TokenUsageSummary, usage: ResponseUsage): TokenUsageSummary {
  const contextInputTokens = contextInputTokensForDisplay(usage);
  return {
    inputTokens: latestNonZero(current.inputTokens, contextInputTokens),
    outputTokens: current.outputTokens + finiteOrZero(usage.outputTokens),
    cachedInputTokens: latestNonZero(current.cachedInputTokens, cachedInputTokens(usage)),
    contextInputTokens: latestNonZero(current.contextInputTokens, contextInputTokens),
  };
}

function addIndependentUsageToTurn(current: TokenUsageSummary, usage: ResponseUsage): TokenUsageSummary {
  const input = contextInputTokensForDisplay(usage);
  return {
    inputTokens: current.inputTokens + input,
    outputTokens: current.outputTokens + finiteOrZero(usage.outputTokens),
    cachedInputTokens: current.cachedInputTokens + cachedInputTokens(usage),
    contextInputTokens: latestNonZero(current.contextInputTokens, input),
  };
}

function combineIndependentUsage(usages: Array<ResponseUsage | undefined>): ResponseUsage | undefined {
  const present = usages.filter((usage): usage is ResponseUsage => Boolean(usage));
  if (present.length === 0) return undefined;
  const sum = (read: (usage: ResponseUsage) => number | undefined) => present.reduce((total, usage) => total + finiteOrZero(read(usage)), 0);
  const inputTokens = sum((usage) => usage.inputTokens ?? usage.contextInputTokens);
  const outputTokens = sum((usage) => usage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadInputTokens: sum((usage) => usage.cacheReadInputTokens),
    cacheWriteInputTokens: sum((usage) => usage.cacheWriteInputTokens),
    cacheHitInputTokens: sum((usage) => usage.cacheHitInputTokens),
    cacheMissInputTokens: sum((usage) => usage.cacheMissInputTokens),
    reasoningTokens: sum((usage) => usage.reasoningTokens),
    effectiveTokens: sum((usage) => usage.effectiveTokens),
  };
}

function mergeLogicalTurnUsage(parent: TokenUsageSummary, agents: TokenUsageSummary): TokenUsageSummary {
  return {
    inputTokens: parent.inputTokens + agents.inputTokens,
    outputTokens: parent.outputTokens + agents.outputTokens,
    cachedInputTokens: parent.cachedInputTokens + agents.cachedInputTokens,
    contextInputTokens: parent.contextInputTokens || agents.contextInputTokens,
  };
}

function addTurnUsageToSession(current: TokenUsageSummary, turn: TokenUsageSummary): TokenUsageSummary {
  return {
    inputTokens: current.inputTokens + turn.inputTokens,
    outputTokens: current.outputTokens + turn.outputTokens,
    cachedInputTokens: current.cachedInputTokens + turn.cachedInputTokens,
    contextInputTokens: latestNonZero(current.contextInputTokens, turn.contextInputTokens),
  };
}

export function sumSessionUsage(messages: ResumedMessage[]): TokenUsageSummary {
  let session = emptyUsageSummary();
  let turn = emptyUsageSummary();
  let agents = emptyUsageSummary();
  for (const message of messages) {
    if (message.role === "user" && isAuthoredUserMessage(message)) {
      const combined = mergeLogicalTurnUsage(turn, agents);
      if (hasUsageSummary(combined)) session = addTurnUsageToSession(session, combined);
      turn = emptyUsageSummary();
      agents = emptyUsageSummary();
      continue;
    }
    if (message.usage) {
      if (message.kind === "subagent-result" || message.kind === "subagent-results") {
        agents = addIndependentUsageToTurn(agents, message.usage);
      } else {
        turn = addResponseUsageToTurn(turn, message.usage);
      }
    }
  }
  const combined = mergeLogicalTurnUsage(turn, agents);
  if (hasUsageSummary(combined)) session = addTurnUsageToSession(session, combined);
  return session;
}

export function latestTurnUsage(messages: ResumedMessage[]): TokenUsageSummary | undefined {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user" && isAuthoredUserMessage(messages[index])) {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return undefined;
  let summary = emptyUsageSummary();
  let agents = emptyUsageSummary();
  for (const message of messages.slice(lastUserIndex + 1)) {
    if (message.usage) {
      if (message.kind === "subagent-result" || message.kind === "subagent-results") {
        agents = addIndependentUsageToTurn(agents, message.usage);
      } else {
        summary = addResponseUsageToTurn(summary, message.usage);
      }
    }
  }
  const combined = mergeLogicalTurnUsage(summary, agents);
  return hasUsageSummary(combined) ? combined : undefined;
}

function isAuthoredUserMessage(message: ResumedMessage): boolean {
  return message.kind !== "gate-resolution"
    && message.kind !== "user-question-answer"
    && message.kind !== "compact-summary"
    && message.kind !== "subagent-results"
    && message.kind !== "background-process-results"
    && message.kind !== ENGINE_HANDOFF_KIND;
}

function cachedInputTokens(usage: ResponseUsage): number {
  return finiteOrZero(usage.cacheReadInputTokens ?? usage.cacheHitInputTokens);
}

function contextInputTokensForDisplay(usage: ResponseUsage): number {
  return finiteOrZero(usage.contextInputTokens ?? usage.inputTokens);
}

function latestNonZero(current: number, next: number): number {
  return next > 0 ? next : current;
}

function hasUsageSummary(usage: TokenUsageSummary): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cachedInputTokens > 0 || usage.contextInputTokens > 0;
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sameStringSet(value: unknown, expected: string[]): boolean {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return false;
  const actual = [...new Set(value as string[])].sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function activityLine(entry: ActivityEntry, width: number): string {
  const label = entry.kind.padEnd(10, " ");
  return truncateLine(`${label} ${entry.text}`, width);
}

function activityColor(kind: ActivityEntry["kind"]): string {
  switch (kind) {
    case "provider":
      return palette.user;
    case "assistant":
      return palette.assistant;
    case "tool":
      return palette.tool;
    case "agent":
      return palette.brand;
    case "gate":
      return palette.gateAccent;
    case "validation":
      return palette.warn;
    case "system":
      return palette.textDim;
  }
}

function vesicleMessagesFromResumed(messages: ResumedMessage[]): VesicleMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
    ...(message.thinkingBlocks ? { thinkingBlocks: message.thinkingBlocks.map((block) => ({ ...block })) } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) } : {}),
    ...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}),
  }));
}

export function displayTranscriptFromSnapshot(messages: ResumedMessage[], agents: AgentCardState[] = []): Message[] {
  const argsByCallId = new Map<string, { name: string; arguments: string }>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      argsByCallId.set(call.id, { name: call.name, arguments: call.arguments });
    }
  }
  const agentsByToolCallId = new Map(agents.map((agent) => [agent.parentToolCallId, agent]));
  return messages.flatMap((message) => displayMessagesFromResumed(message, argsByCallId, agentsByToolCallId));
}

function displayMessagesFromResumed(
  message: ResumedMessage,
  argsByCallId: Map<string, { name: string; arguments: string }>,
  agentsByToolCallId: Map<string, AgentCardState> = new Map(),
): Message[] {
  if (message.kind === ENGINE_HANDOFF_KIND) {
    return [{
      role: "system",
      content: message.content
        .replace(/^\[engine_handoff\]\s*/i, "Engine handoff\n")
        .replace(/\s*\[\/engine_handoff\]\s*$/i, ""),
    }];
  }
  if (message.kind === "compact-summary") {
    return [{ role: "system", content: message.content.replace(/^\[conversation summary\]\s*/i, "Conversation summary\n") }];
  }
  if (message.role === "assistant") {
    // Prose only — the tool calls render as inline cards from the tool-result
    // records that follow (mirrors the live assistant_response handling).
    const reasoningText = displayTextFromThinkingBlocks(message.thinkingBlocks) ?? message.reasoningContent;
    const out: Message[] = [];
    if (reasoningText?.trim()) out.push({ role: "system", content: reasoningText, kind: "reasoning" });
    if (message.content.trim()) {
      out.push({
        role: "assistant",
        content: message.content,
        ...(message.engine ? { engine: message.engine } : {}),
        ...(message.model ? { model: message.model } : {}),
      });
    }
    return out;
  }
  if (message.role === "tool") {
    const lookup = message.toolCallId ? argsByCallId.get(message.toolCallId) : undefined;
    if (lookup?.name === "spawn_agent") {
      const agent = message.toolCallId ? agentsByToolCallId.get(message.toolCallId) : undefined;
      return agent ? [{ role: "system", content: "", kind: "agent", agentRunId: agent.runId }] : [];
    }
    if (lookup) {
      // Reconstruct the same call + result pair the live event flow produces.
      const ok = message.toolOk ?? true;
      return [
        {
          role: "tool",
          toolStage: "call",
          toolName: lookup.name,
          toolArgs: lookup.arguments,
          toolCallId: message.toolCallId,
          toolFileEvent: message.toolFileEvent,
          toolWebEvent: message.toolWebEvent,
          toolMcpEvent: message.toolMcpEvent,
          toolProcessEvent: message.toolProcessEvent,
          toolOk: ok,
          images: message.images,
          content: "",
        },
        {
          role: "tool",
          toolStage: "result",
          toolName: lookup.name,
          toolCallId: message.toolCallId,
          toolOk: ok,
          toolFileEvent: message.toolFileEvent,
          toolWebEvent: message.toolWebEvent,
          toolMcpEvent: message.toolMcpEvent,
          toolProcessEvent: message.toolProcessEvent,
          images: message.images,
          content: ok ? "" : extractResultContent(message.content),
        },
      ];
    }
    return [{ role: "tool", content: renderResumedToolResultSummary(message.content), images: message.images }];
  }
  if (message.role === "user" && message.kind === "subagent-results") {
    return [{ role: "system", content: "Background SubAgent results were delivered to the parent Engine." }];
  }
  if (message.role === "user" && message.kind === "background-process-results") {
    return [{ role: "system", content: "Background shell completion was delivered to the active Engine." }];
  }
  if (message.role === "user") {
    return [{
      role: message.role,
      content: message.content,
      ...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}),
    }];
  }
  return [{ role: "system", content: message.content }];
}

/** Pull the result text out of a stored `{ok, result}` tool-record content. */
function extractResultContent(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as { result?: unknown }).result === "string") {
      return (parsed as { result: string }).result;
    }
  } catch {
    // fall through
  }
  return raw;
}

function providerOptionItems(registry: ProviderRegistry): OptionItem[] {
  return registry.providers.map((provider) => ({
    id: provider.id,
    label: provider.id,
    detail: `${provider.protocol} · ${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`,
  }));
}

function commandArgumentHint(modelDraft: ModelArgumentDraft | null, fixedDraft: FixedArgumentDraft | null, agentDraft: AgentArgumentDraft | null): string {
  const scope = modelDraft
    ? modelDraft.stage === "provider" ? "providers" : `models · ${modelDraft.providerId}`
    : fixedDraft?.command ?? (agentDraft ? agentDraft.stage === "stop" ? "running agents" : "agents" : "arguments");
  return `${scope} · ↑/↓ choose · Tab complete · Enter select`;
}

function modelOptionItems(registry: ProviderRegistry, providerId: string): OptionItem[] {
  const provider = registry.providers.find((entry) => entry.id === providerId);
  if (!provider) return [];
  return provider.models.map((model) => ({
    id: model.id,
    label: model.id,
    detail: renderModelDetails(model),
  }));
}

function joinSessionPath(sessionId: string): string {
  return `.vesicle/sessions/${sessionId}.jsonl`;
}
