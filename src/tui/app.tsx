import { createMemo, createSignal, For, Show, onMount } from "solid-js";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { inspectProviderConfig } from "../config/providers";
import type { ProviderRegistry, ProviderSelection } from "../config/providers";
import { resolveGate, runPrompt } from "../core/agent-loop/run";
import type { RunPromptResult } from "../core/agent-loop/run";
import type { AgentLoopEvent } from "../core/agent-loop/run";
import type { VesicleMessage } from "../providers/shared/types";
import { reasoningTiers } from "../providers/shared/types";
import type { ReasoningTier } from "../providers/shared/types";
import type { GateResolution } from "../core/gate/types";
import { copySelectionToClipboard } from "./clipboard";
import { sharedSyntaxStyle, palette } from "./theme";
import { GatePrompt, gateFocusOrder, gateResolutionFromState } from "./GatePrompt";
import type { GateFocusTarget } from "./GatePrompt";
import { createSessionStore, listSessions, loadSessionSnapshot } from "../core/session/store";
import type { ReasoningDisplayMode, ResumedMessage, SessionSummary } from "../core/session/store";
import { resolveValidators, runValidators } from "../core/validators/registry";
import { executeFileTool } from "../core/tools";
import { resolveTuiLayout } from "./layout";
import { SessionPicker } from "./SessionPicker";
import {
  renderAssistantToolTurn,
  renderResumedToolResultSummary,
  renderToolCallSummary,
  renderToolResultSummary,
} from "./tool-summary";

type Role = "user" | "assistant" | "system" | "tool";
type Message = {
  role: Role;
  content: string;
  kind?: "reasoning";
};

type PendingGate = Extract<RunPromptResult, { kind: "needs_user" }>;

type PendingGateState = Omit<PendingGate, "profile"> & {
  profile?: PendingGate["profile"];
};

type ArtifactEntry = {
  path: string;
  updatedAt: string;
};

type SelectedArtifact = ArtifactEntry & {
  preview: string;
  validation?: string;
};

type ActivityEntry = {
  kind: "provider" | "assistant" | "tool" | "gate" | "validation" | "system";
  text: string;
};

type SessionPickerState = {
  sessions: SessionSummary[];
  selected: number;
};

export function App() {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [providerRegistry, setProviderRegistry] = createSignal<ProviderRegistry | null>(null);
  const [activeProvider, setActiveProvider] = createSignal("loading");
  const [activeModel, setActiveModel] = createSignal("loading");
  const [thinkingTier, setThinkingTier] = createSignal<ReasoningTier | undefined>();
  const [reasoningDisplayMode, setReasoningDisplayMode] = createSignal<ReasoningDisplayMode>("collapsed");
  const [providerHasApiKey, setProviderHasApiKey] = createSignal(false);
  const [providerConfigReady, setProviderConfigReady] = createSignal(false);
  const [messages, setMessages] = createSignal<Message[]>([
    {
      role: "system",
      content: "Ready. Enter one Prism prompt and press Enter.",
    },
  ]);
  const [status, setStatus] = createSignal("loading provider config");
  const [sessionPath, setSessionPath] = createSignal("no session yet");
  const [sessionId, setSessionId] = createSignal<string | undefined>();
  const [conversation, setConversation] = createSignal<VesicleMessage[]>([]);
  const [output, setOutput] = createSignal("");
  const [inputValue, setInputValue] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [resumableSessions, setResumableSessions] = createSignal<SessionSummary[]>([]);
  const [sessionPicker, setSessionPicker] = createSignal<SessionPickerState | null>(null);
  const [artifacts, setArtifacts] = createSignal<ArtifactEntry[]>([]);
  const [selectedArtifact, setSelectedArtifact] = createSignal<SelectedArtifact | null>(null);
  const [activity, setActivity] = createSignal<ActivityEntry[]>([
    { kind: "system", text: "Activity will show provider requests, tool calls, gates, and validation." },
  ]);
  const [streamingAssistant, setStreamingAssistant] = createSignal("");
  const [streamingReasoning, setStreamingReasoning] = createSignal("");
  const [lastDisplayedToolAssistantContent, setLastDisplayedToolAssistantContent] = createSignal<string | null>(null);
  const [promptHistory, setPromptHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal<number | null>(null);

  // Gate UI state. When pendingGate is non-null the input bar is replaced
  // by the Select-style gate prompt; keyboard routing switches to gate mode.
  const [pendingGate, setPendingGate] = createSignal<PendingGateState | null>(null);
  const [gateFocus, setGateFocus] = createSignal<GateFocusTarget>("confirm");
  const [gateFeedbackMode, setGateFeedbackMode] = createSignal<GateFocusTarget | null>(null);
  const [gateFeedback, setGateFeedback] = createSignal("");

  const layout = createMemo(() => resolveTuiLayout(
    dimensions().width,
    dimensions().height,
    Boolean(pendingGate()),
    Boolean(sessionPicker()) || inputValue().startsWith("/"),
  ));

  let lastCtrlCAt = 0;
  let providerConfigLoad: Promise<void> | null = null;

  // On mount, detect existing sessions so the welcome line can offer resume.
  onMount(() => {
    void refreshArtifacts();
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

  useKeyboard((key) => {
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

    if (sessionPicker()) {
      handleSessionPickerKey(key);
      return;
    }

    if (pendingGate()) {
      handleGateKey(key);
      return;
    }

    if (key.name === "up" && !busy()) {
      recallPromptHistory(-1);
      return;
    }
    if (key.name === "down" && historyIndex() !== null && !busy()) {
      recallPromptHistory(1);
      return;
    }

    if ((key.ctrl && key.name === "q") || key.name === "escape") {
      process.nextTick(() => renderer.destroy());
    }
  });

  function handleGateKey(key: { name?: string; ctrl?: boolean; shift?: boolean }) {
    if (busy()) return;
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      const idx = gateFocusOrder.indexOf(gateFocus());
      setGateFocus(gateFocusOrder[(idx - 1 + gateFocusOrder.length) % gateFocusOrder.length]);
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      const idx = gateFocusOrder.indexOf(gateFocus());
      setGateFocus(gateFocusOrder[(idx + 1) % gateFocusOrder.length]);
      return;
    }
    if (key.name === "tab") {
      const target = gateFocus();
      if (target === "chat") return;
      setGateFeedbackMode((prev) => (prev === target ? null : target));
      setGateFeedback("");
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      const resolution = gateResolutionFromState(gateFocus(), gateFeedback());
      void submitGateResolution(resolution);
      return;
    }
    if (key.name === "escape") {
      // Cancel = retreat to chat without committing.
      setGateFeedbackMode(null);
      setGateFeedback("");
      setGateFocus("chat");
      return;
    }
  }

  function recallPromptHistory(direction: -1 | 1) {
    const history = promptHistory();
    if (history.length === 0) return;
    const current = historyIndex();
    const next = current === null
      ? history.length - 1
      : Math.max(0, Math.min(history.length - 1, current + direction));
    setHistoryIndex(next);
    setInputValue(history[next]);
  }

  function handleSessionPickerKey(key: { name?: string; ctrl?: boolean }) {
    const picker = sessionPicker();
    if (!picker) return;

    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setSessionPicker({
        ...picker,
        selected: (picker.selected - 1 + picker.sessions.length) % picker.sessions.length,
      });
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setSessionPicker({
        ...picker,
        selected: (picker.selected + 1) % picker.sessions.length,
      });
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      const target = picker.sessions[picker.selected];
      if (target) void resumeSession(target);
      return;
    }
    if (key.name === "escape") {
      setSessionPicker(null);
      setStatus("resume cancelled");
      return;
    }
  }

  const submitPrompt = async (value: string) => {
    const prompt = value.trim();
    if (!prompt || busy()) return;

    // Slash commands for session management. These never hit the provider.
    if (prompt.startsWith("/")) {
      try {
        await handleCommand(prompt);
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

    setPromptHistory((prev) => [...prev.filter((entry) => entry !== prompt), prompt].slice(-50));
    setHistoryIndex(null);
    setSessionPicker(null);
    setLastDisplayedToolAssistantContent(null);
    setBusy(true);
    setStatus("sending request");
    recordActivity({ kind: "provider", text: "sending provider request" });
    const requestMessages: VesicleMessage[] = [
      ...conversation(),
      { role: "user", content: prompt },
    ];
    setMessages((prev) => [...prev, { role: "user", content: prompt }]);

    try {
      const result = await runPrompt({
        input: prompt,
        engine: "etl",
        sessionId: sessionId(),
        messages: requestMessages,
        providerSelection: activeProviderSelection(),
        generation: activeGeneration(),
        onEvent: handleAgentEvent,
      });
      handleResult(result, requestMessages);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const submitGateResolution = async (resolution: GateResolution) => {
    const gate = pendingGate();
    if (!gate || busy()) return;

    setBusy(true);
    setStatus(`resolving gate: ${resolution.decision}`);
    recordActivity({ kind: "gate", text: `resolving ${gate.gate.gate} as ${resolution.decision}` });
    setPendingGate(null);
    setGateFeedbackMode(null);
    setGateFeedback("");
    setMessages((prev) => [
      ...prev,
      { role: "user", content: `[gate:${gate.gate.gate}] ${resolution.decision}${resolution.feedback ? ` — ${resolution.feedback}` : ""}` },
    ]);

    try {
      const result = await resolveGate({
        engine: "etl",
        sessionId: gate.sessionId,
        messages: gate.messages,
        toolCallId: gate.toolCallId,
        gate: gate.gate,
        resolution,
        providerSelection: activeProviderSelection(),
        generation: activeGeneration(),
        onEvent: handleAgentEvent,
      });
      handleResult(result, gate.messages);
    } catch (error) {
      setPendingGate(gate);
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Apply a runPrompt/resolveGate result. Shared by both paths so the
   * needs_user / complete branching stays in one place.
   */
  function handleResult(result: RunPromptResult, carriedMessages: VesicleMessage[]) {
    if (result.kind === "needs_user") {
      setConversation([...result.messages]);
      setSessionId(result.sessionId);
      setSessionPath(result.sessionPath);
      setPendingGate(result);
      setSessionPicker(null);
      setGateFocus("confirm");
      setGateFeedbackMode(null);
      setGateFeedback("");
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

    setPendingGate(null);
    setGateFeedbackMode(null);
    setGateFeedback("");
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
    if (!result.response.toolCalls?.length && result.response.reasoningContent?.trim()) {
      appended.push({ role: "system", content: result.response.reasoningContent, kind: "reasoning" });
    }
    if (!result.response.toolCalls?.length && result.response.content.trim()) {
      appended.push({ role: "assistant", content: result.response.content });
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

  function handleAgentEvent(event: AgentLoopEvent) {
    switch (event.type) {
      case "provider_request":
        setStreamingAssistant("");
        setStreamingReasoning("");
        recordActivity({ kind: "provider", text: `provider request #${event.iteration + 1}` });
        return;
      case "assistant_delta":
        setStreamingAssistant((prev) => `${prev}${event.delta}`);
        return;
      case "assistant_reasoning_delta":
        setStreamingReasoning((prev) => `${prev}${event.delta}`);
        return;
      case "tool_call_delta":
        if (event.name) {
          recordActivity({ kind: "tool", text: `tool call forming: ${event.name}` });
        }
        return;
      case "assistant_response":
        setStreamingAssistant("");
        setStreamingReasoning("");
        if (event.reasoningContent && event.toolCalls.length > 0) {
          appendReasoningMessage(event.reasoningContent);
        }
        if (event.toolCalls.length > 0) {
          const content = renderAssistantToolTurn(event.content, event.toolCalls);
          setMessages((prev) => [...prev, { role: "assistant", content }]);
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
        setMessages((prev) => [...prev, { role: "tool", content: renderToolCallSummary(event.name, event.arguments) }]);
        recordActivity({ kind: "tool", text: `calling ${event.name}` });
        return;
      case "tool_result":
        setMessages((prev) => [...prev, { role: "tool", content: renderToolResultSummary(event.name, event.ok, event.content) }]);
        recordActivity({ kind: "tool", text: `${event.ok ? "ok" : "failed"} ${event.name}: ${event.content}` });
        return;
      case "gate_pending":
        recordActivity({ kind: "gate", text: `gate pending: ${event.gate}` });
        return;
      case "validation":
        recordActivity({ kind: "validation", text: event.ok ? "validation passed" : "validation found issues" });
        return;
    }
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
    setProviderHasApiKey(inspected.hasApiKey);
    recordActivity({
      kind: "provider",
      text: `active ${inspected.providerId}/${inspected.model} (${inspected.registry.source})`,
    });
    setProviderConfigReady(true);
    setStatus(inspected.hasApiKey ? `provider ${inspected.providerId}` : `missing API key for ${inspected.providerId}`);
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

  async function applyProviderSelection(selection: Partial<ProviderSelection>): Promise<ProviderSelection> {
    const inspected = await inspectProviderConfig(selection);
    setProviderRegistry(inspected.registry);
    setActiveProvider(inspected.providerId);
    setActiveModel(inspected.model);
    setProviderHasApiKey(inspected.hasApiKey);
    setStatus(inspected.hasApiKey ? `provider ${inspected.providerId}` : `missing API key for ${inspected.providerId}`);
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
    const id = sessionId();
    if (!id) return;
    const store = await createSessionStore(process.cwd(), id);
    await store.append({
      role: "system",
      content: `Provider switched to ${selection.provider}/${selection.model}.`,
      metadata: {
        kind: "provider-switch",
        providerId: selection.provider,
        model: selection.model,
      },
    });
  }

  async function persistThinkingSwitch(tier: ReasoningTier | undefined) {
    const id = sessionId();
    if (!id) return;
    const store = await createSessionStore(process.cwd(), id);
    await store.append({
      role: "system",
      content: tier ? `Thinking tier switched to ${tier}.` : "Thinking tier reset to provider default.",
      metadata: {
        kind: "thinking-switch",
        reasoningTier: tier ?? null,
      },
    });
  }

  async function persistReasoningSwitch(mode: ReasoningDisplayMode) {
    const id = sessionId();
    if (!id) return;
    const store = await createSessionStore(process.cwd(), id);
    await store.append({
      role: "system",
      content: `Reasoning display switched to ${mode}.`,
      metadata: {
        kind: "reasoning-switch",
        reasoningDisplayMode: mode,
      },
    });
  }

  const handleSubmit = (value: unknown) => {
    if (pendingGate()) return; // gate mode owns the input
    const submitted = typeof value === "string" ? value : inputValue();
    if (submitted.trim().length === 0) return;
    setInputValue("");
    void submitPrompt(submitted);
  };

  /**
   * Slash commands for session management and help. These run locally and
   * never touch the provider:
   *   /resume           list resumable sessions with numeric indices
   *   /resume <n>       resume the nth session from the last /resume list
   *   /resume <id>      resume a session by full id prefix
   *   /providers        list configured providers
   *   /models [id]      list models for a provider
   *   /use <id> <model> switch provider and model
   *   /model <model>    switch model within the active provider
   *   /think <tier>     set thinking tier: off/low/midium/high/xhigh/max/auto
   *   /reasoning <mode> show reasoning: hidden/collapsed/expanded
   *   /artifacts        list generated artifacts
   *   /artifact <n|path> preview an artifact
   *   /validate <n|path> validate an artifact file
   *   /revise <n|path> <instructions> revise an artifact
   *   /new              abandon the current session and start fresh
   *   /help             show available commands
   */
  async function handleCommand(input: string) {
    const [command, ...rest] = input.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();

    if (command === "help") {
      setMessages((prev) => [
        ...prev,
        { role: "user", content: input },
        {
          role: "system",
          content: "Commands:\n  /providers        list configured providers\n  /models [id]      list models for a provider\n  /use <id> <model> switch provider/model\n  /model <model>    switch model in active provider\n  /think <tier>     set thinking tier: off/low/midium/high/xhigh/max/auto\n  /reasoning <mode> show reasoning: hidden/collapsed/expanded (aliases: off/preview/on)\n  /artifacts        list generated artifacts\n  /artifact <n|path> preview an artifact\n  /validate <n|path> validate an artifact file\n  /revise <n|path> <instructions> revise an artifact\n  /resume           list sessions\n  /resume <n|id>    resume a session\n  /new              start a fresh session\n  /help             show this help",
        },
      ]);
      return;
    }

    if (command === "providers") {
      const registry = await ensureProviderRegistry();
      setMessages((prev) => [
        ...prev,
        { role: "user", content: input },
        { role: "system", content: renderProviderList(registry, activeProvider()) },
      ]);
      return;
    }

    if (command === "models") {
      const registry = await ensureProviderRegistry();
      const providerId = arg || activeProvider();
      setMessages((prev) => [
        ...prev,
        { role: "user", content: input },
        { role: "system", content: renderModelList(registry, providerId, activeModel()) },
      ]);
      return;
    }

    if (command === "use") {
      const [providerId, ...modelParts] = arg.split(/\s+/).filter(Boolean);
      const model = modelParts.join(" ");
      if (!providerId || !model) {
        setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: "Usage: /use <provider> <model>" }]);
        return;
      }
      const selection = await applyProviderSelection({ provider: providerId, model });
      await persistProviderSwitch(selection);
      setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: `Using ${selection.provider}/${selection.model}.` }]);
      return;
    }

    if (command === "model") {
      if (!arg) {
        setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: "Usage: /model <model>" }]);
        return;
      }
      const selection = await applyProviderSelection({ provider: activeProvider(), model: arg });
      await persistProviderSwitch(selection);
      setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: `Using ${selection.provider}/${selection.model}.` }]);
      return;
    }

    if (command === "think") {
      if (!arg) {
        setMessages((prev) => [
          ...prev,
          { role: "user", content: input },
          { role: "system", content: `Thinking tier: ${thinkingTier() ?? "provider default"}. Use /think off|low|midium|high|xhigh|max|auto.` },
        ]);
        return;
      }
      const tier = parseThinkingTier(arg);
      if (!tier) {
        setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: "Usage: /think off|low|midium|high|xhigh|max|auto" }]);
        return;
      }
      if (tier === "auto") {
        setThinkingTier(undefined);
        setStatus("thinking provider default");
        recordActivity({ kind: "provider", text: "thinking tier provider default" });
        await persistThinkingSwitch(undefined);
        setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: "Thinking tier reset to provider default." }]);
        return;
      }
      setThinkingTier(tier);
      setStatus(`thinking ${tier}`);
      recordActivity({ kind: "provider", text: `thinking tier ${tier}` });
      await persistThinkingSwitch(tier);
      setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: `Thinking tier set to ${tier}.` }]);
      return;
    }

    if (command === "reasoning") {
      if (!arg) {
        setMessages((prev) => [
          ...prev,
          { role: "user", content: input },
          { role: "system", content: `Reasoning display: ${reasoningDisplayMode()}. Use /reasoning hidden|collapsed|expanded (aliases: off|preview|on).` },
        ]);
        return;
      }
      const mode = parseReasoningDisplayMode(arg);
      if (!mode) {
        setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: "Usage: /reasoning hidden|collapsed|expanded" }]);
        return;
      }
      setReasoningDisplayMode(mode);
      setStatus(`reasoning ${mode}`);
      recordActivity({ kind: "provider", text: `reasoning display ${mode}` });
      await persistReasoningSwitch(mode);
      setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: `Reasoning display set to ${mode}.` }]);
      return;
    }

    if (command === "artifacts") {
      const entries = await refreshArtifacts();
      setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: renderArtifactList(entries) }]);
      return;
    }

    if (command === "artifact" || command === "open") {
      const entries = artifacts().length > 0 ? artifacts() : await refreshArtifacts();
      const artifact = resolveArtifactTarget(entries, arg);
      if (!artifact) {
        setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: `No artifact matches "${arg || "(empty)"}". Use /artifacts to list.` }]);
        return;
      }
      const selected = await loadArtifactPreview(artifact);
      setSelectedArtifact(selected);
      setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: `Selected artifact ${selected.path}. Preview is shown in the right pane.` }]);
      return;
    }

    if (command === "validate") {
      const entries = artifacts().length > 0 ? artifacts() : await refreshArtifacts();
      const artifact = resolveArtifactTarget(entries, arg);
      if (!artifact) {
        setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: `No artifact matches "${arg || "(empty)"}". Use /artifacts to list.` }]);
        return;
      }
      const selected = await loadArtifactPreview(artifact, { validate: true });
      setSelectedArtifact(selected);
      setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: selected.validation ?? `No validator matched ${selected.path}.` }]);
      return;
    }

    if (command === "revise") {
      const [targetArg, ...instructionParts] = arg.split(/\s+/).filter(Boolean);
      const instructions = instructionParts.join(" ");
      if (!targetArg || !instructions) {
        setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: "Usage: /revise <n|path> <instructions>" }]);
        return;
      }
      const entries = artifacts().length > 0 ? artifacts() : await refreshArtifacts();
      const artifact = resolveArtifactTarget(entries, targetArg);
      if (!artifact) {
        setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: `No artifact matches "${targetArg}". Use /artifacts to list.` }]);
        return;
      }
      await submitPrompt(`Revise artifact ${artifact.path}. First read_file that path, then apply this request and write_file the revised artifact back to the same path: ${instructions}`);
      return;
    }

    if (command === "new") {
      setMessages((prev) => [...prev, { role: "user", content: input }]);
      setSessionId(undefined);
      setSessionPath("no session yet");
      setConversation([]);
      setOutput("");
      setPendingGate(null);
      setStatus("fresh session");
      setMessages((prev) => [...prev, { role: "system", content: "Started a fresh session. Type a prompt to begin." }]);
      return;
    }

    if (command === "resume") {
      const sessions = await listSessions();
      setResumableSessions(sessions);
      if (sessions.length === 0) {
        setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: "No existing sessions found." }]);
        return;
      }

      if (!arg) {
        setMessages((prev) => [...prev, { role: "user", content: input }]);
        setSessionPicker({ sessions, selected: 0 });
        setStatus("choose a session to resume");
        return;
      }

      const target = resolveSessionTarget(sessions, arg);
      if (!target) {
        setMessages((prev) => [...prev, { role: "user", content: input }, { role: "system", content: `No session matches "${arg}".` }]);
        return;
      }

      await resumeSession(target, input);
      return;
    }

    setMessages((prev) => [
      ...prev,
      { role: "user", content: input },
      { role: "system", content: `Unknown command: /${command}. Type /help for available commands.` },
    ]);
  }

  async function resumeSession(target: SessionSummary, commandEcho?: string) {
    try {
      const snapshot = await loadSessionSnapshot(process.cwd(), target.sessionId, {
        synthesizeDanglingToolResults: false,
      });
      const resumedMessages = vesicleMessagesFromResumed(snapshot.messages);
      const transcript = snapshot.messages.flatMap(displayMessagesFromResumed);
      setSessionId(target.sessionId);
      setSessionPath(joinSessionPath(target.sessionId));
      setConversation(resumedMessages);
      setOutput(snapshot.pendingGate?.assistantContent ?? "");
      setSessionPicker(null);

      const hostMessages: Message[] = [];
      if (commandEcho) hostMessages.push({ role: "user", content: commandEcho });
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
        hostMessages.push({ role: "system", content: `Restored thinking tier ${snapshot.reasoningTier} from session.` });
      }
      if (snapshot.reasoningDisplayMode) {
        setReasoningDisplayMode(snapshot.reasoningDisplayMode);
        hostMessages.push({ role: "system", content: `Restored reasoning display ${snapshot.reasoningDisplayMode} from session.` });
      }

      if (snapshot.pendingGate) {
        setPendingGate({
          kind: "needs_user",
          sessionId: target.sessionId,
          sessionPath: joinSessionPath(target.sessionId),
          gate: snapshot.pendingGate.gate,
          toolCallId: snapshot.pendingGate.toolCallId,
          assistantContent: snapshot.pendingGate.assistantContent,
          messages: resumedMessages,
        });
        setGateFocus("confirm");
        setGateFeedbackMode(null);
        setGateFeedback("");
        setStatus(`gate pending: ${snapshot.pendingGate.gate.gate}`);
        hostMessages.push({
          role: "system",
          content: `Resumed pending gate ${snapshot.pendingGate.gate.gate}. Use the gate controls below to continue.`,
        });
      } else {
        setPendingGate(null);
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
    }
  }

  async function refreshArtifacts(): Promise<ArtifactEntry[]> {
    const entries = await scanArtifacts(process.cwd());
    setArtifacts(entries);
    setSelectedArtifact((selected) => selected && entries.some((entry) => entry.path === selected.path) ? selected : null);
    return entries;
  }

  function renderReasoningBlock(content: string, streaming: boolean) {
    const mode = reasoningDisplayMode();
    if (mode === "hidden" || !content.trim()) return <box height={0} />;

    const sideWidth = (layout().showWorkspace ? layout().leftPanelWidth : 0) + (layout().showOutput ? layout().rightPanelWidth : 0);
    const width = Math.max(20, layout().width - sideWidth - 12);
    const maxLines = mode === "expanded" ? 14 : 4;
    const lines = reasoningDisplayLines(content, width, maxLines);
    const rawLines = content.split(/\r?\n/).length;
    const label = mode === "expanded" ? "thinking expanded" : "thinking collapsed";
    const hint = mode === "expanded" ? "/reasoning collapse" : "/reasoning expand";
    const stats = `${content.length} chars, ${rawLines} line${rawLines === 1 ? "" : "s"}`;

    return (
      <box flexDirection="column">
        <text content={`━━━━━━━━ ${streaming ? "thinking streaming" : label} (${stats}) ${hint}`} fg={palette.textMuted} attributes={1} />
        <For each={lines}>
          {(line) => <text content={line} fg={palette.textDim} />}
        </For>
        <text content=" " fg={palette.textDim} />
      </box>
    );
  }

  const renderMessage = (message: Message) => {
    if (message.kind === "reasoning") {
      return renderReasoningBlock(message.content, false);
    }

    const color =
      message.role === "user" ? palette.user
        : message.role === "assistant" ? palette.assistant
          : message.role === "system" ? palette.system
            : palette.tool;
    const prefix = message.role === "user" ? "you" : message.role;

    // Assistant content gets full markdown rendering; user/system/tool stay
    // as styled plain text so the user's own typing and host notices stay
    // visually distinct from rendered model output.
    if (message.role === "assistant" && message.content.trim()) {
      return (
        <box flexDirection="column">
          <text content="━━━━━━━━ assistant" fg={palette.assistant} attributes={1} />
          <markdown content={message.content} syntaxStyle={sharedSyntaxStyle} conceal={true} />
          <text content=" " fg={palette.textDim} />
        </box>
      );
    }

    if (message.role === "user") {
      return (
        <box flexDirection="column">
          <text content="━━━━━━━━ you" fg={palette.user} attributes={1} />
          <text content={message.content} fg={palette.textPrimary} />
          <text content=" " fg={palette.textDim} />
        </box>
      );
    }

    return (
      <box flexDirection="column">
        <text content={prefix} fg={color} attributes={1} />
        <text content={message.content} fg={palette.textPrimary} />
      </box>
    );
  };

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={palette.bg}>
      <box height={3} border borderColor={palette.panelBorder} paddingX={1} flexDirection="row">
        <text
          content={headerLine(activeProvider(), activeModel(), status(), layout().width)}
          fg={busy() ? palette.warn : pendingGate() ? palette.gateAccent : palette.success}
          attributes={1}
        />
      </box>

      <box flexDirection="row" flexGrow={1}>
        <Show when={layout().showWorkspace} fallback={<box width={0} />}>
          <box title="Workspace" border borderColor={palette.sectionBorder} width={layout().leftPanelWidth} padding={1} flexDirection="column">
            <PanelLine content="Engine" fg={palette.textMuted} />
            <PanelLine content="etl" fg={palette.textPrimary} attributes={1} />
            <PanelLine content=" " fg={palette.textDim} />
            <PanelLine content="Provider" fg={palette.textMuted} />
            <PanelLine content={truncateLine(`${activeProvider()}/${activeModel()}`, layout().leftPanelWidth - 4)} fg={palette.textSecondary} />
            <PanelLine content={providerHasApiKey() ? "API key: available" : "API key: missing"} fg={providerHasApiKey() ? palette.success : palette.error} />
            <PanelLine content={truncateLine(`Thinking: ${thinkingTier() ?? "provider default"}`, layout().leftPanelWidth - 4)} fg={palette.textSecondary} />
            <PanelLine content={truncateLine(`Reasoning: ${reasoningDisplayMode()}`, layout().leftPanelWidth - 4)} fg={palette.textSecondary} />
            <PanelLine content=" " fg={palette.textDim} />
            <PanelLine content="Session" fg={palette.textMuted} />
            <PanelLine content={truncateMiddle(sessionPath(), layout().leftPanelWidth - 4)} fg={palette.textSecondary} />
            <PanelLine content=" " fg={palette.textDim} />
            <PanelLine content="Artifacts" fg={palette.textMuted} />
            <Show when={artifacts().length > 0} fallback={<PanelLine content="none yet" fg={palette.textDim} />}>
              <For each={artifacts().slice(0, 4)}>
                {(artifact) => <PanelLine content={truncateMiddle(artifact.path, layout().leftPanelWidth - 4)} fg={palette.textSecondary} />}
              </For>
            </Show>
          </box>
        </Show>

        <box title="Messages" border borderColor={palette.sectionBorder} flexGrow={1} padding={1}>
          <scrollbox width="100%" height="100%" stickyScroll stickyStart="bottom">
            <box flexDirection="column">
              {messages().map((message) => renderMessage(message))}
              <Show when={streamingReasoning().trim().length > 0 && reasoningDisplayMode() !== "hidden"} fallback={<box height={0} />}>
                {renderReasoningBlock(streamingReasoning(), true)}
              </Show>
              <Show when={streamingAssistant().trim().length > 0} fallback={<box height={0} />}>
                <box flexDirection="column">
                  <text content="━━━━━━━━ assistant streaming" fg={palette.assistant} attributes={1} />
                  <markdown content={streamingAssistant()} syntaxStyle={sharedSyntaxStyle} conceal={true} />
                </box>
              </Show>
            </box>
          </scrollbox>
        </box>

        <Show when={layout().showOutput} fallback={<box width={0} />}>
          <box title="Activity / Artifacts" border borderColor={palette.sectionBorder} width={layout().rightPanelWidth} padding={1}>
            <scrollbox width="100%" height="100%" stickyScroll stickyStart="top">
              <box flexDirection="column">
                <text content="Activity" fg={palette.textMuted} />
                <For each={activity().slice(-10)}>
                  {(entry) => <text content={activityLine(entry, layout().rightPanelWidth - 4)} fg={activityColor(entry.kind)} />}
                </For>
                <text content=" " />
                <text content="Selected artifact" fg={palette.textMuted} />
                <Show when={selectedArtifact()} fallback={<text content="none selected" fg={palette.textDim} />}>
                  {(artifact) => (
                    <box flexDirection="column">
                      <text content={truncateMiddle(artifact().path, layout().rightPanelWidth - 4)} fg={palette.textSecondary} />
                      <Show when={artifact().validation} fallback={<box height={0} />}>
                        {(validation) => <text content={truncateLine(validation().split("\n")[0] ?? "", layout().rightPanelWidth - 4)} fg={validation().includes("found issues") ? palette.warn : palette.success} />}
                      </Show>
                      <text content={truncateLine(artifact().preview, layout().rightPanelWidth - 4)} fg={palette.textPrimary} />
                    </box>
                  )}
                </Show>
                <text content=" " />
                <text content="Recent artifacts" fg={palette.textMuted} />
                <Show when={artifacts().length > 0} fallback={<text content="none yet" fg={palette.textDim} />}>
                  <For each={artifacts().slice(0, 6)}>
                    {(artifact) => <text content={truncateMiddle(artifact.path, layout().rightPanelWidth - 4)} fg={palette.textSecondary} />}
                  </For>
                </Show>
              </box>
            </scrollbox>
          </box>
        </Show>
      </box>

      <Show
        when={pendingGate()}
        fallback={
          <Show
            when={sessionPicker()}
            fallback={
              <box height={inputValue().startsWith("/") ? layout().bottomHeight : 3} border borderColor={palette.panelBorder} paddingX={1} flexDirection="column">
                <Show when={inputValue().startsWith("/")} fallback={<box height={0} />}>
                  <box flexDirection="column">
                    <text content="/providers  list providers    /models  list models    /use <p> <m>  switch" fg={palette.textDim} />
                    <text content="/think <tier> off/low/midium/high/xhigh/max/auto    /reasoning <mode>" fg={palette.textDim} />
                    <text content="/resume  list sessions    /new  start fresh    /help" fg={palette.textDim} />
                    <text content="Up/Down recalls prompt history" fg={palette.textDim} />
                  </box>
                </Show>
                <input
                  focused
                  placeholder={busy() ? "Request in flight..." : !providerConfigReady() ? "Loading provider config..." : "Type prompt, Enter to send, /help for commands"}
                  value={inputValue()}
                  onInput={setInputValue}
                  onSubmit={handleSubmit}
                  width="100%"
                />
              </box>
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
        {(g) => (
          <box height={layout().bottomHeight}>
            <GatePrompt
              gate={g().gate}
              focused={gateFocus()}
              feedbackMode={gateFeedbackMode()}
              feedback={gateFeedback()}
              onFeedbackInput={setGateFeedback}
              width={layout().width}
              maxSummaryLines={layout().summaryLines}
            />
          </box>
        )}
      </Show>
    </box>
  );
}

function PanelLine(props: { content: string; fg: string; attributes?: number }) {
  return (
    <box height={1}>
      <text content={props.content} fg={props.fg} attributes={props.attributes} width="100%" />
    </box>
  );
}

function renderProviderList(registry: ProviderRegistry, activeProvider: string): string {
  const lines = [`Configured providers (${registry.source}):`];
  for (const provider of registry.providers) {
    const marker = provider.id === activeProvider ? "*" : " ";
    lines.push(`${marker} ${provider.id} [${provider.protocol}] ${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`);
  }
  lines.push("");
  lines.push("Use /models <provider> to inspect models, /use <provider> <model> to switch.");
  return lines.join("\n");
}

function renderModelList(registry: ProviderRegistry, providerId: string, activeModel: string): string {
  const provider = registry.providers.find((entry) => entry.id === providerId);
  if (!provider) return `Unknown provider "${providerId}". Use /providers to list configured providers.`;
  const lines = [`Models for ${provider.id}:`];
  for (const model of provider.models) {
    const marker = model.id === activeModel ? "*" : " ";
    const details = renderModelDetails(model);
    lines.push(`${marker} ${model.id}${details ? ` (${details})` : ""}`);
  }
  lines.push("");
  lines.push(`Use /use ${provider.id} <model> or /model <model> to switch.`);
  return lines.join("\n");
}

function renderModelDetails(model: ProviderRegistry["providers"][number]["models"][number]): string {
  const details: string[] = [];
  if (model.generation?.temperature !== undefined) details.push(`temp ${model.generation.temperature}`);
  if (model.generation?.maxTokens !== undefined) details.push(`max ${model.generation.maxTokens}`);
  const capabilities = Object.entries(model.capabilities ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name);
  if (capabilities.length > 0) details.push(`cap ${capabilities.join("/")}`);
  return details.join(", ");
}

function parseThinkingTier(value: string): ReasoningTier | "auto" | null {
  const raw = value.trim().toLowerCase();
  if (raw === "auto" || raw === "unset" || raw === "default") return "auto";
  const normalized = raw === "medium" ? "midium" : raw;
  return (reasoningTiers as readonly string[]).includes(normalized) ? normalized as ReasoningTier : null;
}

function parseReasoningDisplayMode(value: string): ReasoningDisplayMode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "hide" || normalized === "hidden" || normalized === "off") return "hidden";
  if (normalized === "collapse" || normalized === "collapsed" || normalized === "fold" || normalized === "preview") return "collapsed";
  if (normalized === "expand" || normalized === "expanded" || normalized === "show" || normalized === "on") return "expanded";
  return null;
}

function renderArtifactList(entries: ArtifactEntry[]): string {
  if (entries.length === 0) return "No artifacts found yet.";
  const lines = ["Artifacts:"];
  entries.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.path}`);
  });
  lines.push("");
  lines.push("Use /artifact <n|path> to preview, /validate <n|path> to validate, /revise <n|path> <instructions> to edit.");
  return lines.join("\n");
}

function resolveArtifactTarget(entries: ArtifactEntry[], arg: string): ArtifactEntry | null {
  const trimmed = arg.trim();
  if (!trimmed) return entries[0] ?? null;
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= entries.length) return entries[numeric - 1];
  return entries.find((entry) => entry.path === trimmed) ?? null;
}

async function loadArtifactPreview(artifact: ArtifactEntry, options: { validate?: boolean } = {}): Promise<SelectedArtifact> {
  const result = await executeFileTool(process.cwd(), {
    id: "artifact-preview",
    name: "read_file",
    arguments: JSON.stringify({ path: artifact.path }),
  });
  if (!result.ok) throw new Error(result.content);
  const content = result.content;
  const preview = content.replace(/\s+/g, " ").trim().slice(0, 500) || "(empty)";
  const validation = options.validate ? validateArtifactContent(content) : undefined;
  return { ...artifact, preview, ...(validation ? { validation } : {}) };
}

function validateArtifactContent(content: string): string {
  const names = selectArtifactValidators(content);
  if (names.length === 0) return "No validator matched this artifact.";
  const validation = runValidators(resolveValidators(names), content);
  return renderValidationNotice(validation);
}

function selectArtifactValidators(content: string): string[] {
  const keys = frontmatterKeys(content);
  if (keys.size === 0) return [];
  if (keys.has("scenario_name")) return ["scenario-card"];
  if (keys.has("name") && keys.has("archetype")) return ["character-card"];
  return ["character-card", "scenario-card"];
}

function frontmatterKeys(content: string): Set<string> {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return new Set();
  const lines = trimmed.split(/\r?\n/);
  const keys = new Set<string>();
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "---") break;
    const colon = line.indexOf(":");
    if (colon > 0) keys.add(line.slice(0, colon).trim());
  }
  return keys;
}

function headerLine(provider: string, model: string, status: string, width: number): string {
  return truncateLine(`Prism Vesicle | etl | ${provider} | ${model} | ${status}`, Math.max(20, width - 4));
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
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) } : {}),
  }));
}

function displayMessagesFromResumed(message: ResumedMessage): Message[] {
  if (message.role === "assistant") {
    const content = message.toolCalls && message.toolCalls.length > 0
      ? renderAssistantToolTurn(message.content, message.toolCalls)
      : message.content;
    return [
      ...(message.reasoningContent?.trim() ? [{ role: "system" as const, content: message.reasoningContent, kind: "reasoning" as const }] : []),
      { role: "assistant", content },
    ];
  }
  if (message.role === "tool") {
    return [{ role: "tool", content: renderResumedToolResultSummary(message.content) }];
  }
  if (message.role === "user") {
    return [{ role: message.role, content: message.content }];
  }
  return [{ role: "system", content: message.content }];
}

function truncateLine(value: string, width: number): string {
  const limit = Math.max(8, width);
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

function reasoningDisplayLines(content: string, width: number, maxLines: number): string[] {
  const cleaned = content.replace(/\t/g, "  ");
  const rawLines = cleaned.split(/\r?\n/).map((line) => truncateLine(line || " ", width));
  if (rawLines.length <= maxLines) return rawLines;
  const visibleTailLines = Math.max(0, maxLines - 1);
  const hidden = rawLines.length - visibleTailLines;
  return [
    `... ${hidden} earlier reasoning line${hidden === 1 ? "" : "s"} hidden`,
    ...rawLines.slice(-visibleTailLines),
  ];
}

function truncateMiddle(value: string, width: number): string {
  const limit = Math.max(8, width);
  if (value.length <= limit) return value;
  const head = Math.ceil((limit - 3) / 2);
  const tail = Math.floor((limit - 3) / 2);
  return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}

async function scanArtifacts(rootDir: string): Promise<ArtifactEntry[]> {
  const roots = ["workspace", "novels", "reports", "test_runs"];
  const entries: ArtifactEntry[] = [];

  for (const root of roots) {
    const dir = join(rootDir, root);
    await scanArtifactDir(rootDir, dir, entries).catch(() => undefined);
  }

  return entries
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12);
}

async function scanArtifactDir(rootDir: string, dir: string, entries: ArtifactEntry[]) {
  const children = await readdir(dir, { withFileTypes: true });
  for (const child of children) {
    if (child.name === ".gitkeep") continue;
    const fullPath = join(dir, child.name);
    if (child.isDirectory()) {
      await scanArtifactDir(rootDir, fullPath, entries);
      continue;
    }
    if (!child.isFile()) continue;
    const info = await stat(fullPath);
    entries.push({
      path: relative(rootDir, fullPath).replace(/\\/g, "/"),
      updatedAt: info.mtime.toISOString(),
    });
  }
}

function renderValidationNotice(validation: { ok: boolean; results: Array<{ name: string; result: { errors: string[]; warnings: string[] } }> }): string {
  const lines: string[] = [`Validation ${validation.ok ? "passed" : "found issues"}:`];
  for (const entry of validation.results) {
    const tag = entry.result.errors.length > 0 ? "✗" : entry.result.warnings.length > 0 ? "⚠" : "✓";
    lines.push(`  ${tag} ${entry.name}`);
    for (const error of entry.result.errors) lines.push(`      ${error}`);
    for (const warning of entry.result.warnings) lines.push(`      ${warning}`);
  }
  return lines.join("\n");
}

function resolveSessionTarget(sessions: SessionSummary[], arg: string): SessionSummary | null {
  // Numeric index (1-based) into the most recent /resume list.
  const numeric = Number(arg);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= sessions.length) {
    return sessions[numeric - 1];
  }
  // Otherwise treat as an id prefix.
  const match = sessions.find((s) => s.sessionId.startsWith(arg));
  return match ?? null;
}

function joinSessionPath(sessionId: string): string {
  return `.vesicle/sessions/${sessionId}.jsonl`;
}
