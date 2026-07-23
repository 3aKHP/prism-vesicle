import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { engineIds, type EngineId } from "../core/engine/profile";
import type { PermissionMode } from "../core/permissions";
import type { ComposerState } from "../tui/composer";
import type { SetupConfiguration, SetupMcpServer, SetupWriteResult } from "./config-writer";
import type { McpTestResult } from "./mcp-test";
import { normalizeOpenAIBaseUrl, type ModelDiscoveryResult } from "./model-discovery";

export type SetupStep =
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

export type SetupInputStep = Extract<SetupStep,
  "base-url" | "api-key" | "add-model" | "tavily-key" | "mcp-name" | "mcp-url" | "mcp-header" | "mcp-secret" | "project"
>;

export type SetupCompletion = {
  launch: boolean;
  projectDirectory?: string;
  writeResult?: SetupWriteResult;
};

export type SetupState = {
  step: SetupStep;
  selectedIndex: number;
  input: ComposerState;
  status: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  selectedModels: string[];
  defaultModel: string;
  tavilyApiKey: string;
  mcpServers: SetupMcpServer[];
  mcpDraft: SetupMcpServer;
  mcpTestResult: McpTestResult | null;
  mcpTestError: string;
  permissionMode: Exclude<PermissionMode, "YOLO">;
  projectDirectory: string;
  projectInputReturnStep: "project-choice" | "review";
  writeResult?: SetupWriteResult;
};

export type SetupEffect =
  | { kind: "discover-models"; baseUrl: string; apiKey: string }
  | { kind: "test-mcp"; server: SetupMcpServer }
  | { kind: "save-configuration"; configuration: SetupConfiguration };

export type SetupEffectResult =
  | { kind: "discovery-succeeded"; result: ModelDiscoveryResult }
  | { kind: "discovery-failed"; error: string }
  | { kind: "mcp-test-succeeded"; result: McpTestResult }
  | { kind: "mcp-test-failed"; error: string }
  | { kind: "save-succeeded"; result: SetupWriteResult }
  | { kind: "save-failed"; error: string };

export type SetupAction =
  | { type: "set-input"; input: ComposerState }
  | { type: "move-selection"; delta: number }
  | { type: "back" }
  | { type: "submit-input"; value: string }
  | { type: "choose" }
  | { type: "toggle-multi" }
  | { type: "add-model-input" }
  | { type: "continue-multi" }
  | { type: "effect-result"; result: SetupEffectResult };

export type SetupTransition = {
  state: SetupState;
  effect?: SetupEffect;
  completion?: SetupCompletion;
};

export type SetupChoiceItem = { label: string; detail?: string };

export const permissionOptions: Array<{ mode: Exclude<PermissionMode, "YOLO">; label: string; detail: string }> = [
  { mode: "MOMENTUM", label: "Recommended", detail: "Reads and ordinary workspace changes proceed; shell stays off" },
  { mode: "INERTIA", label: "More cautious", detail: "Reads proceed; changes ask first" },
  { mode: "MANUAL", label: "Ask every time", detail: "Every model-visible tool asks first" },
];

const explicitBackSteps: SetupStep[] = [
  "discovery-error", "default-model", "tavily-choice", "mcp-choice", "mcp-auth", "mcp-result",
  "mcp-more", "permissions", "project-choice", "review",
];

export type SetupMultiSelectChoice<T> =
  | { kind: "value"; value: T }
  | { kind: "back" };

export function createInitialSetupState(
  env: NodeJS.ProcessEnv = process.env,
  initialStep: SetupStep = "welcome",
): SetupState {
  return {
    step: initialStep,
    selectedIndex: 0,
    input: { value: "", cursor: 0 },
    status: "Use arrow keys and Enter. Ctrl+Q exits Setup.",
    baseUrl: "",
    apiKey: "",
    models: [],
    selectedModels: [],
    defaultModel: "",
    tavilyApiKey: "",
    mcpServers: [],
    mcpDraft: emptyMcpDraft(),
    mcpTestResult: null,
    mcpTestError: "",
    permissionMode: "MOMENTUM",
    projectDirectory: defaultProjectDirectory(env),
    projectInputReturnStep: "project-choice",
  };
}

export function transitionSetup(
  state: SetupState,
  action: SetupAction,
  env: NodeJS.ProcessEnv = process.env,
): SetupTransition {
  switch (action.type) {
    case "set-input":
      return unchanged({ ...state, input: action.input });
    case "move-selection":
      return unchanged({ ...state, selectedIndex: wrapIndex(state.selectedIndex + action.delta, setupSelectionCount(state)) });
    case "back":
      return unchanged(goBack(state));
    case "submit-input":
      return submitInput(state, action.value, env);
    case "choose":
      return chooseCurrent(state, env);
    case "toggle-multi":
      return unchanged(toggleMultiValue(state));
    case "add-model-input":
      return unchanged(state.step === "models" ? enterInput(state, "add-model", "") : state);
    case "continue-multi":
      return continueMultiSelect(state);
    case "effect-result":
      return unchanged(applyEffectResult(state, action.result));
  }
}

function setupSelectionCount(state: SetupState): number {
  if (state.step === "models") return setupMultiSelectChoices(state.models).length;
  if (state.step === "mcp-engines") return setupMultiSelectChoices(engineIds).length;
  return setupChoiceItems(state).length;
}

export function setupChoiceItems(state: SetupState): SetupChoiceItem[] {
  const items = baseChoiceItems(state);
  return setupChoiceSupportsBack(state.step)
    ? [...items, { label: "Back", detail: "Return to the previous step" }]
    : items;
}

function baseChoiceItems(state: SetupState): SetupChoiceItem[] {
  switch (state.step) {
    case "welcome": return [
      { label: "Begin guided setup", detail: "No configuration files to edit" },
      { label: "Exit", detail: "You can reopen Setup from the Start Menu" },
    ];
    case "discovery-error": return [
      { label: "Retry model discovery" },
      { label: "Edit Base URL" },
      { label: "Add a model manually", detail: "Continue even when /models is unavailable" },
    ];
    case "default-model": return state.selectedModels.map((model) => ({ label: model }));
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
      { label: state.mcpTestError ? "Save server anyway" : "Save server and continue", detail: state.mcpTestError ? "The failed connection is recorded only after this choice" : undefined },
      { label: "Retry test" },
      { label: "Edit server URL" },
    ];
    case "mcp-more": return [
      { label: "Continue", detail: `${state.mcpServers.length} MCP server(s) ready` },
      { label: "Add another MCP server" },
    ];
    case "permissions": return permissionOptions.map((option) => ({ label: option.label, detail: option.detail }));
    case "project-choice": return [
      { label: "Skip project selection", detail: "Launch projects later with vesicle ." },
      { label: "Choose a folder for the first launch", detail: "Used once; never pinned" },
    ];
    case "review": return [
      { label: "Save configuration", detail: "Existing files receive timestamped backups" },
      { label: state.projectDirectory ? "Change one-time launch folder" : "Choose a one-time launch folder" },
      ...(state.projectDirectory ? [{ label: "Skip the one-time launch", detail: "No project is saved globally" }] : []),
    ];
    case "complete": return state.projectDirectory
      ? [
          { label: "Launch this folder once", detail: state.projectDirectory },
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

function submitInput(state: SetupState, value: string, env: NodeJS.ProcessEnv): SetupTransition {
  switch (state.step) {
    case "base-url": {
      try {
        const normalized = normalizeOpenAIBaseUrl(value);
        return unchanged(enterInput({ ...state, baseUrl: normalized }, "api-key", "", `Models will be requested from ${normalized}/models.`));
      } catch (error) {
        return unchanged({ ...state, status: errorMessage(error) });
      }
    }
    case "api-key":
      if (!value) return unchanged({ ...state, status: "API key is required." });
      return beginDiscovery({ ...state, apiKey: value });
    case "add-model": {
      if (!value) return unchanged({ ...state, status: "Enter an exact model id." });
      const models = [...new Set([...state.models, value])].sort((a, b) => a.localeCompare(b));
      return unchanged({
        ...state,
        models,
        selectedModels: [...new Set([...state.selectedModels, value])],
        step: "models",
        selectedIndex: Math.max(0, models.indexOf(value)),
        status: `Added and selected ${value}.`,
      });
    }
    case "tavily-key":
      if (!value) return unchanged({ ...state, status: "Enter a Tavily API key, or press Esc to skip." });
      return unchanged({ ...state, tavilyApiKey: value, step: "mcp-choice", selectedIndex: 0, status: "Tavily will be available to the ETL and Evaluate engines." });
    case "mcp-name":
      if (!value) return unchanged({ ...state, status: "Enter a short name for this MCP server." });
      return unchanged(enterInput({ ...state, mcpDraft: { ...state.mcpDraft, name: value } }, "mcp-url", ""));
    case "mcp-url": {
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("MCP URL must use http:// or https://.");
        return unchanged({
          ...state,
          mcpDraft: { ...state.mcpDraft, url: url.toString() },
          step: "mcp-auth",
          selectedIndex: 0,
          status: "Choose how this MCP server authenticates.",
        });
      } catch (error) {
        return unchanged({ ...state, status: errorMessage(error) });
      }
    }
    case "mcp-header":
      if (!/^[A-Za-z0-9-]+$/.test(value)) return unchanged({ ...state, status: "Header name may contain letters, numbers, and hyphens." });
      return unchanged(enterInput({ ...state, mcpDraft: { ...state.mcpDraft, headerName: value } }, "mcp-secret", ""));
    case "mcp-secret":
      if (!value) return unchanged({ ...state, status: "Authentication secret is required." });
      return unchanged({
        ...state,
        mcpDraft: { ...state.mcpDraft, secret: value },
        step: "mcp-engines",
        selectedIndex: 0,
        status: "Space toggles Engines; Enter tests the server.",
      });
    case "project": {
      if (!value) return unchanged({ ...state, status: "Enter a folder for the one-time launch, or press Esc to skip it." });
      return unchanged({
        ...state,
        projectDirectory: resolveProjectPath(value, env),
        step: "review",
        selectedIndex: 0,
        status: "Review the choices, then save them together.",
      });
    }
    default:
      return unchanged(state);
  }
}

function chooseCurrent(state: SetupState, env: NodeJS.ProcessEnv): SetupTransition {
  const index = state.selectedIndex;
  if (setupChoiceSupportsBack(state.step) && index === setupChoiceItems(state).length - 1) return unchanged(goBack(state));
  switch (state.step) {
    case "welcome":
      return index === 0 ? unchanged(enterInput(state, "base-url", "")) : { state, completion: { launch: false } };
    case "discovery-error":
      if (index === 0) return beginDiscovery(state);
      if (index === 1) return unchanged(enterInput(state, "base-url", state.baseUrl));
      return unchanged(enterInput({ ...state, models: [], selectedModels: [] }, "add-model", ""));
    case "default-model": {
      const model = state.selectedModels[index];
      if (!model) return unchanged(state);
      return unchanged({ ...state, defaultModel: model, step: "tavily-choice", selectedIndex: 0, status: "Tavily web research is optional and can be configured later." });
    }
    case "tavily-choice":
      return index === 0
        ? unchanged({ ...state, tavilyApiKey: "", step: "mcp-choice", selectedIndex: 0 })
        : unchanged(enterInput(state, "tavily-key", ""));
    case "mcp-choice":
      return index === 0
        ? unchanged({ ...state, step: "permissions", selectedIndex: 0, status: "Choose how often Vesicle should ask before using tools." })
        : unchanged(enterInput({ ...state, mcpDraft: emptyMcpDraft() }, "mcp-name", ""));
    case "mcp-auth": {
      const auth = (["none", "bearer", "custom-header"] as const)[index] ?? "none";
      const next = { ...state, mcpDraft: { ...state.mcpDraft, auth } };
      if (auth === "none") return unchanged({ ...next, step: "mcp-engines", selectedIndex: 0, status: "Space toggles Engines; Enter tests the server." });
      return unchanged(enterInput(next, auth === "custom-header" ? "mcp-header" : "mcp-secret", auth === "custom-header" ? "X-API-Key" : ""));
    }
    case "mcp-result":
      if (index === 0) return unchanged({
        ...state,
        mcpServers: [...state.mcpServers, state.mcpDraft],
        step: "mcp-more",
        selectedIndex: 0,
        status: "The server will be written when Setup saves all configuration.",
      });
      if (index === 1) return beginMcpTest(state);
      return unchanged(enterInput(state, "mcp-url", state.mcpDraft.url));
    case "mcp-more":
      return index === 0
        ? unchanged({ ...state, step: "permissions", selectedIndex: 0, status: "Choose how often Vesicle should ask before using tools." })
        : unchanged(enterInput({ ...state, mcpDraft: emptyMcpDraft() }, "mcp-name", ""));
    case "permissions": {
      const option = permissionOptions[index] ?? permissionOptions[0];
      return unchanged({ ...state, permissionMode: option.mode, step: "project-choice", selectedIndex: 0, status: "Project selection is optional and is never saved as a global default." });
    }
    case "project-choice":
      if (index === 0) return unchanged({ ...state, projectDirectory: "", step: "review", selectedIndex: 0, status: "No project will be pinned. Launch Vesicle from any folder with vesicle ." });
      return unchanged(enterInput({ ...state, projectInputReturnStep: "project-choice" }, "project", state.projectDirectory || defaultProjectDirectory(env), "This folder is used for the first launch only and is not saved globally."));
    case "review":
      if (index === 0) return beginSave(state);
      if (index === 1) return unchanged(enterInput({ ...state, projectInputReturnStep: "review" }, "project", state.projectDirectory || defaultProjectDirectory(env)));
      return unchanged({ ...state, projectDirectory: "", selectedIndex: 0, status: "The one-time first launch was removed; no project will be pinned." });
    case "complete": {
      const launch = Boolean(state.projectDirectory) && index === 0;
      return {
        state,
        completion: {
          launch,
          ...(launch ? { projectDirectory: state.projectDirectory } : {}),
          writeResult: state.writeResult,
        },
      };
    }
    case "save-error":
      if (index === 0) return beginSave(state);
      if (index === 1) return unchanged({ ...state, step: "review", selectedIndex: 0 });
      return { state, completion: { launch: false } };
    default:
      return unchanged(state);
  }
}

function continueMultiSelect(state: SetupState): SetupTransition {
  const choices = setupMultiSelectChoices(state.step === "models" ? state.models : [...engineIds]);
  if (setupMultiSelectBackAt(choices, state.selectedIndex)) return unchanged(goBack(state));
  if (state.step === "models") {
    if (state.selectedModels.length === 0) return unchanged({ ...state, status: "Select at least one model with Space, or press A to add one." });
    return unchanged({ ...state, selectedIndex: 0, step: "default-model", status: "Choose the model Vesicle should use by default." });
  }
  if (state.step === "mcp-engines") {
    if (state.mcpDraft.enabledEngines.length === 0) return unchanged({ ...state, status: "Select at least one Engine with Space." });
    return beginMcpTest(state);
  }
  return unchanged(state);
}

function toggleMultiValue(state: SetupState): SetupState {
  const choices = setupMultiSelectChoices(state.step === "models" ? state.models : [...engineIds]);
  const value = setupMultiSelectValueAt(choices, state.selectedIndex);
  if (!value) return state;
  if (state.step === "models") {
    const model = value as string;
    return {
      ...state,
      selectedModels: state.selectedModels.includes(model)
        ? state.selectedModels.filter((entry) => entry !== model)
        : [...state.selectedModels, model],
    };
  }
  if (state.step === "mcp-engines") {
    const engine = value as EngineId;
    return {
      ...state,
      mcpDraft: {
        ...state.mcpDraft,
        enabledEngines: state.mcpDraft.enabledEngines.includes(engine)
          ? state.mcpDraft.enabledEngines.filter((entry) => entry !== engine)
          : [...state.mcpDraft.enabledEngines, engine],
      },
    };
  }
  return state;
}

function beginDiscovery(state: SetupState): SetupTransition {
  return {
    state: { ...state, step: "discovering", status: "Contacting the provider without saving the API key yet..." },
    effect: { kind: "discover-models", baseUrl: state.baseUrl, apiKey: state.apiKey },
  };
}

function beginMcpTest(state: SetupState): SetupTransition {
  return {
    state: {
      ...state,
      step: "mcp-testing",
      mcpTestResult: null,
      mcpTestError: "",
      status: "Initializing the MCP server and requesting its tool list...",
    },
    effect: { kind: "test-mcp", server: state.mcpDraft },
  };
}

function beginSave(state: SetupState): SetupTransition {
  return {
    state: { ...state, step: "saving", status: "Validating and saving user configuration with backups..." },
    effect: {
      kind: "save-configuration",
      configuration: {
        baseUrl: state.baseUrl,
        apiKey: state.apiKey,
        modelIds: state.selectedModels,
        defaultModel: state.defaultModel,
        ...(state.tavilyApiKey ? { tavilyApiKey: state.tavilyApiKey } : {}),
        ...(state.mcpServers.length ? { mcpServers: state.mcpServers } : {}),
        permissionMode: state.permissionMode,
        ...(state.projectDirectory ? { projectDirectory: state.projectDirectory } : {}),
      },
    },
  };
}

function applyEffectResult(state: SetupState, result: SetupEffectResult): SetupState {
  switch (result.kind) {
    case "discovery-succeeded":
      return {
        ...state,
        baseUrl: result.result.baseUrl,
        models: result.result.models,
        selectedModels: result.result.models[0] ? [result.result.models[0]] : [],
        selectedIndex: 0,
        step: "models",
        status: `Found ${result.result.models.length} models. Space toggles; A adds an exact model id.`,
      };
    case "discovery-failed":
      return { ...state, step: "discovery-error", selectedIndex: 0, status: result.error };
    case "mcp-test-succeeded":
      return {
        ...state,
        mcpTestResult: result.result,
        mcpTestError: "",
        step: "mcp-result",
        selectedIndex: 0,
        status: `Connected successfully; discovered ${result.result.toolCount} tools.`,
      };
    case "mcp-test-failed":
      return {
        ...state,
        mcpTestResult: null,
        mcpTestError: result.error,
        step: "mcp-result",
        selectedIndex: 0,
        status: "The MCP test failed. You may edit, retry, or explicitly save it anyway.",
      };
    case "save-succeeded":
      return {
        ...state,
        writeResult: result.result,
        step: "complete",
        selectedIndex: 0,
        status: result.result.backups.length > 0
          ? `Saved successfully and created ${result.result.backups.length} backups.`
          : "Saved successfully. Prism Vesicle is ready to launch.",
      };
    case "save-failed":
      return { ...state, step: "save-error", selectedIndex: 0, status: result.error };
  }
}

function goBack(state: SetupState): SetupState {
  switch (state.step) {
    case "base-url": return { ...state, step: "welcome" };
    case "api-key": return enterInput(state, "base-url", state.baseUrl);
    case "add-model": return { ...state, step: "models" };
    case "tavily-key": return { ...state, step: "tavily-choice" };
    case "mcp-name": return { ...state, step: "mcp-choice" };
    case "mcp-url": return enterInput(state, "mcp-name", state.mcpDraft.name);
    case "mcp-header":
    case "mcp-secret": return { ...state, step: "mcp-auth" };
    case "project": return { ...state, step: state.projectInputReturnStep };
    case "discovery-error": return enterInput(state, "api-key", "");
    case "models": return enterInput(state, "api-key", "");
    case "default-model": return returnToChoice(state, "models", Math.max(0, state.selectedModels.indexOf(state.defaultModel)));
    case "tavily-choice": return returnToChoice(state, "default-model", Math.max(0, state.selectedModels.indexOf(state.defaultModel)));
    case "mcp-choice": return returnToChoice(state, "tavily-choice", state.tavilyApiKey ? 1 : 0);
    case "mcp-auth": return enterInput(state, "mcp-url", state.mcpDraft.url);
    case "mcp-engines": return returnToChoice(state, "mcp-auth", Math.max(0, ["none", "bearer", "custom-header"].indexOf(state.mcpDraft.auth)));
    case "mcp-result": return enterInput(state, "mcp-url", state.mcpDraft.url);
    case "mcp-more":
    case "permissions": return returnToChoice(state, "mcp-choice");
    case "project-choice": return returnToChoice(state, "permissions", Math.max(0, permissionOptions.findIndex((option) => option.mode === state.permissionMode)));
    case "review": return returnToChoice(state, "project-choice", setupReviewBackIndex(state.projectDirectory));
    case "save-error": return returnToChoice(state, "review");
    default: return state;
  }
}

function enterInput(state: SetupState, step: SetupInputStep, value: string, status = inputHint(step)): SetupState {
  return { ...state, input: { value, cursor: value.length }, step, status };
}

function returnToChoice(state: SetupState, step: SetupStep, selectedIndex = 0): SetupState {
  return { ...state, step, selectedIndex };
}

function unchanged(state: SetupState): SetupTransition {
  return { state };
}

export function setupMultiSelectChoices<T>(values: readonly T[]): Array<SetupMultiSelectChoice<T>> {
  return [...values.map((value) => ({ kind: "value" as const, value })), { kind: "back" }];
}

export function setupMultiSelectValueAt<T>(choices: Array<SetupMultiSelectChoice<T>>, index: number): T | undefined {
  const choice = choices[index];
  return choice?.kind === "value" ? choice.value : undefined;
}

export function setupMultiSelectBackAt<T>(choices: Array<SetupMultiSelectChoice<T>>, index: number): boolean {
  return choices[index]?.kind === "back";
}

export function setupChoiceSupportsBack(step: SetupStep): boolean {
  return explicitBackSteps.includes(step);
}

export function setupReviewBackIndex(projectDirectory: string): number {
  return projectDirectory ? 1 : 0;
}

export function setupIsBusy(step: SetupStep): boolean {
  return step === "discovering" || step === "mcp-testing" || step === "saving";
}

export function isSetupInputStep(step: SetupStep): step is SetupInputStep {
  return ["base-url", "api-key", "add-model", "tavily-key", "mcp-name", "mcp-url", "mcp-header", "mcp-secret", "project"].includes(step);
}

export function isSetupSecretStep(step: SetupStep): boolean {
  return step === "api-key" || step === "tavily-key" || step === "mcp-secret";
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

function inputHint(step: SetupInputStep): string {
  if (isSetupSecretStep(step)) return "Input is masked. Enter continues; Esc goes back without saving.";
  if (step === "base-url") return "Enter the API base. A missing /v1 suffix is added automatically.";
  if (step === "project") return "The folder is created when Setup saves; it is never saved as a global project.";
  return "Enter continues; Esc goes back.";
}

function wrapIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return ((value % length) + length) % length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}
