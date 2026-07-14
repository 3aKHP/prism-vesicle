import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { PermissionMode } from "../core/permissions";
import { engineIds, type EngineId } from "../core/engine/profile";
import { applyComposerKey, insertComposerText, normalizeKeyName, type ComposerState } from "../tui/composer";
import { PromptComposer } from "../tui/PromptComposer";
import { palette } from "../tui/theme";
import { discoverOpenAIModels, normalizeOpenAIBaseUrl } from "./model-discovery";
import { testMcpServer, type McpTestResult } from "./mcp-test";
import { writeSetupConfiguration, type SetupMcpServer, type SetupWriteResult } from "./config-writer";

type SetupStep =
  | "welcome"
  | "base-url"
  | "api-key"
  | "discovering"
  | "discovery-error"
  | "models"
  | "add-model"
  | "default-model"
  | "tavily-choice"
  | "tavily-key"
  | "mcp-choice"
  | "mcp-name"
  | "mcp-url"
  | "mcp-auth"
  | "mcp-header"
  | "mcp-secret"
  | "mcp-engines"
  | "mcp-testing"
  | "mcp-result"
  | "mcp-more"
  | "permissions"
  | "project-choice"
  | "project"
  | "review"
  | "saving"
  | "complete"
  | "save-error";

export type SetupCompletion = {
  launch: boolean;
  projectDirectory?: string;
  writeResult?: SetupWriteResult;
};

export type SetupAppProps = {
  env?: NodeJS.ProcessEnv;
  discoverModels?: typeof discoverOpenAIModels;
  testMcp?: typeof testMcpServer;
  writeConfiguration?: typeof writeSetupConfiguration;
  onComplete: (result: SetupCompletion) => void;
};

type InputPage = Extract<SetupStep,
  "base-url" | "api-key" | "add-model" | "tavily-key" | "mcp-name" | "mcp-url" | "mcp-header" | "mcp-secret" | "project"
>;

const permissionOptions: Array<{ mode: Exclude<PermissionMode, "YOLO">; label: string; detail: string }> = [
  { mode: "MOMENTUM", label: "Recommended", detail: "Reads and ordinary workspace changes proceed; shell stays off" },
  { mode: "INERTIA", label: "More cautious", detail: "Reads proceed; changes ask first" },
  { mode: "MANUAL", label: "Ask every time", detail: "Every model-visible tool asks first" },
];

export function SetupApp(props: SetupAppProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const env = props.env ?? process.env;
  const [step, setStep] = createSignal<SetupStep>("welcome");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [draft, setDraft] = createSignal("");
  const [draftCursor, setDraftCursor] = createSignal(0);
  const [status, setStatus] = createSignal("Use arrow keys and Enter. Ctrl+Q exits Setup.");
  const [baseUrl, setBaseUrl] = createSignal("");
  const [apiKey, setApiKey] = createSignal("");
  const [models, setModels] = createSignal<string[]>([]);
  const [selectedModels, setSelectedModels] = createSignal<string[]>([]);
  const [defaultModel, setDefaultModel] = createSignal("");
  const [tavilyApiKey, setTavilyApiKey] = createSignal("");
  const [mcpServers, setMcpServers] = createSignal<SetupMcpServer[]>([]);
  const [mcpDraft, setMcpDraft] = createSignal<SetupMcpServer>(emptyMcpDraft());
  const [mcpTestResult, setMcpTestResult] = createSignal<McpTestResult | null>(null);
  const [mcpTestError, setMcpTestError] = createSignal("");
  const [permissionMode, setPermissionMode] = createSignal<Exclude<PermissionMode, "YOLO">>("MOMENTUM");
  const [projectDirectory, setProjectDirectory] = createSignal(defaultProjectDirectory(env));
  const [projectInputReturnStep, setProjectInputReturnStep] = createSignal<"project-choice" | "review">("project-choice");
  const [writeResult, setWriteResult] = createSignal<SetupWriteResult>();
  const busy = createMemo(() => step() === "discovering" || step() === "mcp-testing" || step() === "saving");

  useKeyboard((rawKey) => {
    const key = {
      name: normalizeKeyName(rawKey.name),
      ctrl: rawKey.ctrl,
      meta: rawKey.meta,
      shift: rawKey.shift,
      option: rawKey.option,
      sequence: rawKey.sequence,
      raw: rawKey.raw,
      preventDefault: () => rawKey.preventDefault(),
      stopPropagation: () => rawKey.stopPropagation(),
    };
    if (key.ctrl && (key.name === "q" || key.name === "c")) {
      complete({ launch: false });
      consumeKey(key);
      return;
    }
    if (busy()) {
      consumeKey(key);
      return;
    }
    if (isInputPage(step())) {
      handleInputKey(key);
      consumeKey(key);
      return;
    }
    handleChoiceKey(key);
    consumeKey(key);
  });

  usePaste((event) => {
    if (!isInputPage(step()) || busy()) {
      event.preventDefault();
      return;
    }
    const text = new TextDecoder().decode(event.bytes).replace(/[\r\n]+/g, " ");
    const next = insertComposerText(inputState(), text);
    applyInputState(next);
    event.preventDefault();
  });

  function handleInputKey(key: Parameters<typeof applyComposerKey>[1]): void {
    if (key.name === "escape") {
      goBackFromInput();
      return;
    }
    const result = applyComposerKey(inputState(), key);
    applyInputState(result.state);
    if (result.action?.type === "submit") submitInput(result.action.value.trim());
  }

  function handleChoiceKey(key: { name?: string; ctrl?: boolean }): void {
    if (key.name === "escape") {
      goBackFromChoice();
      return;
    }
    if (step() === "models" || step() === "mcp-engines") {
      handleMultiSelectKey(key);
      return;
    }
    const items = choiceItems();
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setSelectedIndex((value) => wrapIndex(value - 1, items.length));
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setSelectedIndex((value) => wrapIndex(value + 1, items.length));
      return;
    }
    if (key.name === "enter" || key.name === "return") chooseCurrent();
  }

  function handleMultiSelectKey(key: { name?: string; ctrl?: boolean }): void {
    const items = step() === "models" ? models() : [...engineIds];
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setSelectedIndex((value) => wrapIndex(value - 1, items.length));
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setSelectedIndex((value) => wrapIndex(value + 1, items.length));
      return;
    }
    if (step() === "models" && key.name?.toLowerCase() === "a") {
      enterInput("add-model", "");
      return;
    }
    if (key.name === "space") {
      const value = items[selectedIndex()];
      if (!value) return;
      if (step() === "models") toggleSelectedModel(value);
      else toggleEngine(value as EngineId);
      return;
    }
    if (key.name !== "enter" && key.name !== "return") return;
    if (step() === "models") {
      if (selectedModels().length === 0) {
        setStatus("Select at least one model with Space, or press A to add one.");
        return;
      }
      setSelectedIndex(0);
      setStep("default-model");
      setStatus("Choose the model Vesicle should use by default.");
    } else {
      if (mcpDraft().enabledEngines.length === 0) {
        setStatus("Select at least one Engine with Space.");
        return;
      }
      void runMcpTest();
    }
  }

  function submitInput(value: string): void {
    switch (step()) {
      case "base-url": {
        try {
          const normalized = normalizeOpenAIBaseUrl(value);
          setBaseUrl(normalized);
          enterInput("api-key", "");
          setStatus(`Models will be requested from ${normalized}/models.`);
        } catch (error) {
          setStatus(errorMessage(error));
        }
        return;
      }
      case "api-key":
        if (!value) {
          setStatus("API key is required.");
          return;
        }
        setApiKey(value);
        void runDiscovery();
        return;
      case "add-model":
        if (!value) {
          setStatus("Enter an exact model id.");
          return;
        }
        setModels((current) => [...new Set([...current, value])].sort((a, b) => a.localeCompare(b)));
        setSelectedModels((current) => [...new Set([...current, value])]);
        setStep("models");
        setSelectedIndex(Math.max(0, models().indexOf(value)));
        setStatus(`Added and selected ${value}.`);
        return;
      case "tavily-key":
        if (!value) {
          setStatus("Enter a Tavily API key, or press Esc to skip.");
          return;
        }
        setTavilyApiKey(value);
        setStep("mcp-choice");
        setSelectedIndex(0);
        setStatus("Tavily will be available to the ETL and Evaluate engines.");
        return;
      case "mcp-name":
        if (!value) {
          setStatus("Enter a short name for this MCP server.");
          return;
        }
        setMcpDraft((current) => ({ ...current, name: value }));
        enterInput("mcp-url", "");
        return;
      case "mcp-url":
        try {
          const url = new URL(value);
          if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("MCP URL must use http:// or https://.");
          setMcpDraft((current) => ({ ...current, url: url.toString() }));
          setStep("mcp-auth");
          setSelectedIndex(0);
          setStatus("Choose how this MCP server authenticates.");
        } catch (error) {
          setStatus(errorMessage(error));
        }
        return;
      case "mcp-header":
        if (!/^[A-Za-z0-9-]+$/.test(value)) {
          setStatus("Header name may contain letters, numbers, and hyphens.");
          return;
        }
        setMcpDraft((current) => ({ ...current, headerName: value }));
        enterInput("mcp-secret", "");
        return;
      case "mcp-secret":
        if (!value) {
          setStatus("Authentication secret is required.");
          return;
        }
        setMcpDraft((current) => ({ ...current, secret: value }));
        setStep("mcp-engines");
        setSelectedIndex(0);
        setStatus("Space toggles Engines; Enter tests the server.");
        return;
      case "project": {
        if (!value) {
          setStatus("Enter a folder for the one-time launch, or press Esc to skip it.");
          return;
        }
        const resolved = resolveProjectPath(value, env);
        setProjectDirectory(resolved);
        setStep("review");
        setSelectedIndex(0);
        setStatus("Review the choices, then save them together.");
        return;
      }
    }
  }

  function chooseCurrent(): void {
    const index = selectedIndex();
    switch (step()) {
      case "welcome":
        if (index === 0) enterInput("base-url", "");
        else complete({ launch: false });
        return;
      case "discovery-error":
        if (index === 0) void runDiscovery();
        else if (index === 1) enterInput("base-url", baseUrl());
        else {
          setModels([]);
          setSelectedModels([]);
          enterInput("add-model", "");
        }
        return;
      case "default-model": {
        const model = selectedModels()[index];
        if (!model) return;
        setDefaultModel(model);
        setStep("tavily-choice");
        setSelectedIndex(0);
        setStatus("Tavily web research is optional and can be configured later.");
        return;
      }
      case "tavily-choice":
        if (index === 0) {
          setTavilyApiKey("");
          setStep("mcp-choice");
          setSelectedIndex(0);
        } else enterInput("tavily-key", "");
        return;
      case "mcp-choice":
        if (index === 0) {
          setStep("permissions");
          setSelectedIndex(0);
          setStatus("Choose how often Vesicle should ask before using tools.");
        } else beginMcpServer();
        return;
      case "mcp-auth": {
        const auth = (["none", "bearer", "custom-header"] as const)[index] ?? "none";
        setMcpDraft((current) => ({ ...current, auth }));
        if (auth === "none") {
          setStep("mcp-engines");
          setSelectedIndex(0);
          setStatus("Space toggles Engines; Enter tests the server.");
        } else if (auth === "custom-header") enterInput("mcp-header", "X-API-Key");
        else enterInput("mcp-secret", "");
        return;
      }
      case "mcp-result":
        if (index === 0) {
          setMcpServers((current) => [...current, mcpDraft()]);
          setStep("mcp-more");
          setSelectedIndex(0);
          setStatus("The server will be written when Setup saves all configuration.");
        } else if (index === 1) void runMcpTest();
        else enterInput("mcp-url", mcpDraft().url);
        return;
      case "mcp-more":
        if (index === 0) {
          setStep("permissions");
          setSelectedIndex(0);
          setStatus("Choose how often Vesicle should ask before using tools.");
        } else beginMcpServer();
        return;
      case "permissions": {
        const option = permissionOptions[index] ?? permissionOptions[0];
        setPermissionMode(option.mode);
        setStep("project-choice");
        setSelectedIndex(0);
        setStatus("Project selection is optional and is never saved as a global default.");
        return;
      }
      case "project-choice":
        if (index === 0) {
          setProjectDirectory("");
          setStep("review");
          setSelectedIndex(0);
          setStatus("No project will be pinned. Launch Vesicle from any folder with vesicle .");
        } else {
          setProjectInputReturnStep("project-choice");
          enterInput("project", projectDirectory() || defaultProjectDirectory(env));
          setStatus("This folder is used for the first launch only and is not saved globally.");
        }
        return;
      case "review":
        if (index === 0) void saveConfiguration();
        else if (index === 1) {
          setProjectInputReturnStep("review");
          enterInput("project", projectDirectory() || defaultProjectDirectory(env));
        }
        else {
          setProjectDirectory("");
          setSelectedIndex(0);
          setStatus("The one-time first launch was removed; no project will be pinned.");
        }
        return;
      case "complete": {
        const launch = Boolean(projectDirectory()) && index === 0;
        complete({
          launch,
          ...(launch ? { projectDirectory: projectDirectory() } : {}),
          writeResult: writeResult(),
        });
        return;
      }
      case "save-error":
        if (index === 0) void saveConfiguration();
        else if (index === 1) {
          setStep("review");
          setSelectedIndex(0);
        } else complete({ launch: false });
        return;
    }
  }

  async function runDiscovery(): Promise<void> {
    setStep("discovering");
    setStatus("Contacting the provider without saving the API key yet...");
    try {
      const result = await (props.discoverModels ?? discoverOpenAIModels)(baseUrl(), apiKey());
      setBaseUrl(result.baseUrl);
      setModels(result.models);
      setSelectedModels(result.models[0] ? [result.models[0]] : []);
      setSelectedIndex(0);
      setStep("models");
      setStatus(`Found ${result.models.length} models. Space toggles; A adds an exact model id.`);
    } catch (error) {
      setStep("discovery-error");
      setSelectedIndex(0);
      setStatus(errorMessage(error));
    }
  }

  async function runMcpTest(): Promise<void> {
    setStep("mcp-testing");
    setMcpTestResult(null);
    setMcpTestError("");
    setStatus("Initializing the MCP server and requesting its tool list...");
    try {
      const result = await (props.testMcp ?? testMcpServer)(mcpDraft());
      setMcpTestResult(result);
      setStatus(`Connected successfully; discovered ${result.toolCount} tools.`);
    } catch (error) {
      setMcpTestError(errorMessage(error));
      setStatus("The MCP test failed. You may edit, retry, or explicitly save it anyway.");
    } finally {
      setStep("mcp-result");
      setSelectedIndex(0);
    }
  }

  async function saveConfiguration(): Promise<void> {
    setStep("saving");
    setStatus("Validating and saving user configuration with backups...");
    try {
      const result = await (props.writeConfiguration ?? writeSetupConfiguration)({
        baseUrl: baseUrl(),
        apiKey: apiKey(),
        modelIds: selectedModels(),
        defaultModel: defaultModel(),
        ...(tavilyApiKey() ? { tavilyApiKey: tavilyApiKey() } : {}),
        ...(mcpServers().length ? { mcpServers: mcpServers() } : {}),
        permissionMode: permissionMode(),
        ...(projectDirectory() ? { projectDirectory: projectDirectory() } : {}),
      }, env);
      setWriteResult(result);
      setStep("complete");
      setSelectedIndex(0);
      setStatus(result.backups.length > 0
        ? `Saved successfully and created ${result.backups.length} backups.`
        : "Saved successfully. Prism Vesicle is ready to launch.");
    } catch (error) {
      setStep("save-error");
      setSelectedIndex(0);
      setStatus(errorMessage(error));
    }
  }

  function goBackFromInput(): void {
    switch (step()) {
      case "base-url": setStep("welcome"); return;
      case "api-key": enterInput("base-url", baseUrl()); return;
      case "add-model": setStep("models"); return;
      case "tavily-key": setStep("tavily-choice"); return;
      case "mcp-name": setStep("mcp-choice"); return;
      case "mcp-url": enterInput("mcp-name", mcpDraft().name); return;
      case "mcp-header": setStep("mcp-auth"); return;
      case "mcp-secret": setStep("mcp-auth"); return;
      case "project": setStep(projectInputReturnStep()); return;
    }
  }

  function goBackFromChoice(): void {
    switch (step()) {
      case "models": enterInput("api-key", ""); return;
      case "default-model": setStep("models"); return;
      case "tavily-choice": setStep("default-model"); return;
      case "mcp-choice": setStep("tavily-choice"); return;
      case "mcp-auth": enterInput("mcp-url", mcpDraft().url); return;
      case "mcp-engines": setStep("mcp-auth"); return;
      case "mcp-result": enterInput("mcp-url", mcpDraft().url); return;
      case "mcp-more": setStep("mcp-choice"); return;
      case "permissions": setStep("mcp-choice"); return;
      case "project-choice": setStep("permissions"); return;
      case "review": setStep("project-choice"); return;
      case "save-error": setStep("review"); return;
    }
  }

  function enterInput(next: InputPage, value: string): void {
    setDraft(value);
    setDraftCursor(value.length);
    setStep(next);
    setStatus(inputHint(next));
  }

  function beginMcpServer(): void {
    setMcpDraft(emptyMcpDraft());
    enterInput("mcp-name", "");
  }

  function inputState(): ComposerState {
    return { value: draft(), cursor: draftCursor() };
  }

  function applyInputState(state: ComposerState): void {
    setDraft(state.value);
    setDraftCursor(state.cursor);
  }

  function toggleSelectedModel(model: string): void {
    setSelectedModels((current) => current.includes(model) ? current.filter((entry) => entry !== model) : [...current, model]);
  }

  function toggleEngine(engine: EngineId): void {
    setMcpDraft((current) => ({
      ...current,
      enabledEngines: current.enabledEngines.includes(engine)
        ? current.enabledEngines.filter((entry) => entry !== engine)
        : [...current.enabledEngines, engine],
    }));
  }

  function complete(result: SetupCompletion): void {
    props.onComplete(result);
    process.nextTick(() => renderer.destroy());
  }

  function choiceItems(): Array<{ label: string; detail?: string }> {
    switch (step()) {
      case "welcome": return [
        { label: "Begin guided setup", detail: "No configuration files to edit" },
        { label: "Exit", detail: "You can reopen Setup from the Start Menu" },
      ];
      case "discovery-error": return [
        { label: "Retry model discovery" },
        { label: "Edit Base URL" },
        { label: "Add a model manually", detail: "Continue even when /models is unavailable" },
      ];
      case "default-model": return selectedModels().map((model) => ({ label: model }));
      case "tavily-choice": return [
        { label: "Skip for now", detail: "Web research can be added later" },
        { label: "Configure Tavily", detail: "Add optional web research tools" },
      ];
      case "mcp-choice": return [
        { label: "Skip for now", detail: "MCP servers can be added later" },
        { label: "Add an MCP server", detail: "Streamable HTTP" },
      ];
      case "mcp-auth": return [
        { label: "No authentication" },
        { label: "Bearer token", detail: "Authorization: Bearer ..." },
        { label: "Custom header", detail: "For X-API-Key and similar services" },
      ];
      case "mcp-result": return [
        { label: mcpTestError() ? "Save server anyway" : "Save server and continue", detail: mcpTestError() ? "The failed connection is recorded only after this choice" : undefined },
        { label: "Retry test" },
        { label: "Edit server URL" },
      ];
      case "mcp-more": return [
        { label: "Continue", detail: `${mcpServers().length} MCP server(s) ready` },
        { label: "Add another MCP server" },
      ];
      case "permissions": return permissionOptions.map((option) => ({ label: option.label, detail: option.detail }));
      case "project-choice": return [
        { label: "Skip project selection", detail: "Launch projects later with vesicle ." },
        { label: "Choose a folder for the first launch", detail: "Used once; never pinned" },
      ];
      case "review": return [
        { label: "Save configuration", detail: "Existing files receive timestamped backups" },
        { label: projectDirectory() ? "Change one-time launch folder" : "Choose a one-time launch folder" },
        ...(projectDirectory() ? [{ label: "Skip the one-time launch", detail: "No project is saved globally" }] : []),
      ];
      case "complete": return projectDirectory()
        ? [
            { label: "Launch this folder once", detail: projectDirectory() },
            { label: "Exit Setup", detail: "Later, run vesicle . in a project" },
          ]
        : [{ label: "Exit Setup", detail: "Run vesicle . from any project folder" }];
      case "save-error": return [
        { label: "Retry save" },
        { label: "Back to review" },
        { label: "Exit without changes" },
      ];
      default: return [];
    }
  }

  const visibleMultiItems = createMemo(() => {
    const values = step() === "models" ? models() : [...engineIds];
    return visibleWindow(values, selectedIndex(), Math.max(5, Math.min(14, dimensions().height - 12)));
  });

  return (
    <box flexDirection="column" width="100%" height="100%" paddingX={2} paddingY={1} backgroundColor={palette.bg}>
      <box height={2} flexDirection="column">
        <text content="Prism Vesicle Setup" fg={palette.brand} attributes={TextAttributes.BOLD} />
        <text content={progressLabel(step())} fg={palette.textDim} />
      </box>
      <box marginTop={1} flexGrow={1} flexDirection="column" border borderColor={palette.panelBorder} paddingX={2} paddingY={1}>
        <text content={pageTitle(step())} fg={palette.textPrimary} attributes={TextAttributes.BOLD} />
        <text content={pageDescription(step())} fg={palette.textSecondary} />
        <box marginTop={1} flexDirection="column" flexGrow={1}>
          <Show when={isInputPage(step())} fallback={renderChoiceContent()}>
            <text content={inputLabel(step() as InputPage)} fg={palette.textSecondary} />
            <box marginTop={1} border borderColor={palette.brandDim} paddingX={1} height={3}>
              <PromptComposer
                value={isSecretPage(step()) ? maskValue(draft()) : draft()}
                cursor={draftCursor()}
                placeholder={inputPlaceholder(step() as InputPage)}
                width={Math.max(20, dimensions().width - 10)}
                maxLines={1}
              />
            </box>
            <text content="Enter continues · Esc goes back" fg={palette.textDim} />
          </Show>
        </box>
      </box>
      <box height={3} marginTop={1} flexDirection="column">
        <text content={status()} fg={status().toLowerCase().includes("failed") || status().toLowerCase().includes("required") ? palette.error : palette.textSecondary} />
        <text content="Secrets stay in .env; Setup never writes them to YAML or logs." fg={palette.textDim} />
      </box>
    </box>
  );

  function renderChoiceContent() {
    if (step() === "discovering" || step() === "mcp-testing" || step() === "saving") {
      return <text content="Working..." fg={palette.warn} />;
    }
    if (step() === "models" || step() === "mcp-engines") {
      return (
        <box flexDirection="column">
          <For each={visibleMultiItems().visible}>{(item, index) => {
            const absolute = () => visibleMultiItems().start + index();
            const selected = () => absolute() === selectedIndex();
            const checked = () => step() === "models" ? selectedModels().includes(item) : mcpDraft().enabledEngines.includes(item as EngineId);
            return <text
              content={`${selected() ? ">" : " "} [${checked() ? "x" : " "}] ${item}`}
              fg={selected() ? palette.textPrimary : palette.textSecondary}
              attributes={selected() ? TextAttributes.BOLD : TextAttributes.NONE}
            />;
          }}</For>
          <text content={step() === "models" ? "Space toggles · A adds a model · Enter continues" : "Space toggles · Enter tests connection"} fg={palette.textDim} />
        </box>
      );
    }
    if (step() === "review") {
      return (
        <box flexDirection="column">
          <text content={`Provider  ${baseUrl()}`} fg={palette.textSecondary} />
          <text content={`Models    ${selectedModels().length} selected · default ${defaultModel()}`} fg={palette.textSecondary} />
          <text content={`Tavily    ${tavilyApiKey() ? "configured" : "skipped"}`} fg={palette.textSecondary} />
          <text content={`MCP       ${mcpServers().length} server(s)`} fg={palette.textSecondary} />
          <text content={`Permission ${permissionMode()} · shell disabled`} fg={palette.textSecondary} />
          <text content={`First run ${projectDirectory() || "skipped; no project is pinned"}`} fg={palette.textSecondary} />
          <box marginTop={1} flexDirection="column">{renderOptions(choiceItems())}</box>
        </box>
      );
    }
    if (step() === "mcp-result") {
      return (
        <box flexDirection="column">
          <text content={mcpTestError() || `Connected${mcpTestResult()?.serverName ? ` to ${mcpTestResult()!.serverName}` : ""}; ${mcpTestResult()?.toolCount ?? 0} tools found.`} fg={mcpTestError() ? palette.error : palette.success} />
          <box marginTop={1} flexDirection="column">{renderOptions(choiceItems())}</box>
        </box>
      );
    }
    return <box flexDirection="column">{renderOptions(choiceItems())}</box>;
  }

  function renderOptions(items: Array<{ label: string; detail?: string }>) {
    return <For each={items}>{(item, index) => {
      const selected = () => index() === selectedIndex();
      return <text
        content={`${selected() ? ">" : " "} ${item.label}${item.detail ? `  — ${item.detail}` : ""}`}
        fg={selected() ? palette.textPrimary : palette.textSecondary}
        attributes={selected() ? TextAttributes.BOLD : TextAttributes.NONE}
      />;
    }}</For>;
  }
}

export function defaultProjectDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.USERPROFILE || env.HOME || homedir();
  return join(home, "Documents", "PrismVesicle", "MyFirstProject");
}

export function resolveProjectPath(input: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.USERPROFILE || env.HOME || homedir();
  const expanded = input.trim().replace(/^~(?=$|[\\/])/, home);
  return resolve(expanded);
}

function emptyMcpDraft(): SetupMcpServer {
  return { name: "", url: "", auth: "none", enabledEngines: ["etl", "evaluate"] };
}

function isInputPage(step: SetupStep): step is InputPage {
  return ["base-url", "api-key", "add-model", "tavily-key", "mcp-name", "mcp-url", "mcp-header", "mcp-secret", "project"].includes(step);
}

function isSecretPage(step: SetupStep): boolean {
  return step === "api-key" || step === "tavily-key" || step === "mcp-secret";
}

export function maskValue(value: string): string {
  return value.replace(/[\s\S]/g, "•");
}

function inputLabel(step: SetupStep): string {
  const labels: Record<InputPage, string> = {
    "base-url": "OpenAI-compatible Base URL",
    "api-key": "Provider API key",
    "add-model": "Exact model id",
    "tavily-key": "Tavily API key",
    "mcp-name": "MCP server name",
    "mcp-url": "MCP Streamable HTTP URL",
    "mcp-header": "Authentication header name",
    "mcp-secret": "MCP authentication secret",
    "project": "One-time first-launch folder",
  };
  return isInputPage(step) ? labels[step] : "";
}

function inputPlaceholder(step: SetupStep): string {
  const placeholders: Record<InputPage, string> = {
    "base-url": "https://api.example.com/v1",
    "api-key": "Paste the key; it is masked",
    "add-model": "provider-model-id",
    "tavily-key": "tvly-...",
    "mcp-name": "Research server",
    "mcp-url": "https://mcp.example.com/mcp",
    "mcp-header": "X-API-Key",
    "mcp-secret": "Paste the token; it is masked",
    "project": "C:\\Users\\you\\Documents\\PrismVesicle\\MyFirstProject",
  };
  return isInputPage(step) ? placeholders[step] : "";
}

function inputHint(step: InputPage): string {
  if (isSecretPage(step)) return "Input is masked. Enter continues; Esc goes back without saving.";
  if (step === "base-url") return "Enter the API base. A missing /v1 suffix is added automatically.";
  if (step === "project") return "The folder is created when Setup saves; it is never saved as a global project.";
  return "Enter continues; Esc goes back.";
}

function pageTitle(step: SetupStep): string {
  const titles: Record<SetupStep, string> = {
    welcome: "Welcome",
    "base-url": "Connect a model provider",
    "api-key": "Authenticate securely",
    discovering: "Discovering models",
    "discovery-error": "Model discovery needs attention",
    models: "Choose available models",
    "add-model": "Add a model manually",
    "default-model": "Choose the default model",
    "tavily-choice": "Optional web research",
    "tavily-key": "Configure Tavily",
    "mcp-choice": "Optional MCP tools",
    "mcp-name": "Name the MCP server",
    "mcp-url": "Connect the MCP server",
    "mcp-auth": "MCP authentication",
    "mcp-header": "Custom MCP header",
    "mcp-secret": "MCP secret",
    "mcp-engines": "Choose MCP Engines",
    "mcp-testing": "Testing MCP connection",
    "mcp-result": "MCP connection result",
    "mcp-more": "MCP configuration",
    permissions: "Tool approval preference",
    "project-choice": "Optional first launch",
    project: "Choose a one-time launch folder",
    review: "Review and save",
    saving: "Saving configuration",
    complete: "Setup complete",
    "save-error": "Configuration was not saved",
  };
  return titles[step];
}

function pageDescription(step: SetupStep): string {
  if (step === "welcome") return "No YAML editing is required. Existing configuration is merged and backed up.";
  if (step === "models") return "The provider returned model ids. Select only the models you want Vesicle to offer.";
  if (step === "tavily-choice") return "Tavily enables web_search and related research tools. It is not required for the first conversation.";
  if (step === "mcp-choice") return "MCP servers add external tools. Each server can be limited to selected Prism Engines.";
  if (step === "permissions") return "Permission presets change approval friction; they never weaken path, process, or tool guards.";
  if (step === "project-choice") return "Vesicle never stores one global project. Optionally choose a folder for this first launch only.";
  if (step === "complete") return "Configuration validated successfully. Project selection remains local to each launch.";
  return "Follow the prompt below. Nothing is written until the final review step.";
}

function progressLabel(step: SetupStep): string {
  const order: SetupStep[] = ["welcome", "base-url", "api-key", "models", "default-model", "tavily-choice", "mcp-choice", "permissions", "project-choice", "review", "complete"];
  const aliases: Partial<Record<SetupStep, SetupStep>> = {
    discovering: "api-key",
    "discovery-error": "api-key",
    "add-model": "models",
    "tavily-key": "tavily-choice",
    "mcp-name": "mcp-choice",
    "mcp-url": "mcp-choice",
    "mcp-auth": "mcp-choice",
    "mcp-header": "mcp-choice",
    "mcp-secret": "mcp-choice",
    "mcp-engines": "mcp-choice",
    "mcp-testing": "mcp-choice",
    "mcp-result": "mcp-choice",
    "mcp-more": "mcp-choice",
    project: "project-choice",
    saving: "review",
    "save-error": "review",
  };
  const current = aliases[step] ?? step;
  const index = Math.max(0, order.indexOf(current));
  return `Step ${index + 1} of ${order.length}`;
}

function visibleWindow<T>(items: T[], selected: number, maximum: number): { start: number; visible: T[] } {
  if (items.length <= maximum) return { start: 0, visible: items };
  const start = Math.max(0, Math.min(selected - Math.floor(maximum / 2), items.length - maximum));
  return { start, visible: items.slice(start, start + maximum) };
}

function wrapIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return ((value % length) + length) % length;
}

function consumeKey(key: { preventDefault?: () => void; stopPropagation?: () => void }): void {
  key.preventDefault?.();
  key.stopPropagation?.();
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}
