import { TextAttributes } from "@opentui/core";
import { For, Match, Show, Switch, createMemo } from "solid-js";
import { engineIds, type EngineId } from "../core/engine/profile";
import { PromptComposer } from "../tui/PromptComposer";
import { truncateLine } from "../tui/format";
import { palette } from "../tui/theme";
import {
  isSetupInputStep,
  isSetupSecretStep,
  setupChoiceItems,
  setupMultiSelectChoices,
  type SetupChoiceItem,
  type SetupInputStep,
  type SetupState,
  type SetupStep,
} from "./setup-state";

export type SetupViewProps = {
  state: SetupState;
  width: number;
  height: number;
};

export function SetupView(props: SetupViewProps) {
  const compact = () => setupUsesCompactHeight(props.height, props.state.step);
  const rootPaddingX = () => props.width < 64 ? 1 : 2;
  const panelPaddingX = () => props.width < 64 ? 1 : 2;
  const panelTextWidth = () => Math.max(8, props.width - (rootPaddingX() * 2) - (panelPaddingX() * 2) - 2);
  const statusWidth = () => Math.max(8, props.width - (rootPaddingX() * 2));

  return (
    <box flexDirection="column" width="100%" height="100%" paddingX={rootPaddingX()} paddingY={compact() ? 0 : 1} overflow="hidden" backgroundColor={palette.bg}>
      <box height={compact() ? 1 : 2} flexDirection="column" overflow="hidden">
        <text content={truncateLine("Prism Vesicle Setup", panelTextWidth())} wrapMode="none" fg={palette.brand} attributes={TextAttributes.BOLD} />
        <text content={compact() ? "" : progressLabel(props.state.step)} height={compact() ? 0 : 1} wrapMode="none" fg={palette.textDim} />
      </box>
      <box marginTop={compact() ? 0 : 1} flexGrow={1} flexDirection="column" border borderColor={palette.panelBorder} paddingX={panelPaddingX()} paddingY={compact() ? 0 : 1} overflow="hidden">
        <text content={truncateLine(pageTitle(props.state.step), panelTextWidth())} wrapMode="none" fg={palette.textPrimary} attributes={TextAttributes.BOLD} />
        <text content={compact() ? "" : truncateLine(pageDescription(props.state.step), panelTextWidth())} height={compact() ? 0 : 1} wrapMode="none" fg={palette.textSecondary} />
        <box marginTop={compact() ? 0 : 1} flexDirection="column" flexGrow={1} overflow="hidden">
          <Show when={isSetupInputStep(props.state.step)} fallback={
            <ChoicePageView state={props.state} width={panelTextWidth()} height={props.height} compact={compact()} />
          }>
            <InputPageView state={props.state} width={panelTextWidth()} />
          </Show>
        </box>
      </box>
      <box height={compact() ? 1 : 3} marginTop={compact() ? 0 : 1} flexDirection="column" overflow="hidden">
        <text content={truncateLine(props.state.status, statusWidth())} wrapMode="none" fg={statusIsError(props.state.status) ? palette.error : palette.textSecondary} />
        <text content={compact() ? "" : truncateLine("Secrets stay in .env; Setup never writes them to YAML or logs.", statusWidth())} height={compact() ? 0 : 1} wrapMode="none" fg={palette.textDim} />
      </box>
    </box>
  );
}

function InputPageView(props: { state: SetupState; width: number }) {
  const step = () => props.state.step as SetupInputStep;
  return (
    <>
      <text content={truncateLine(inputLabel(step()), props.width)} wrapMode="none" fg={palette.textSecondary} />
      <box marginTop={1} border borderColor={palette.brandDim} paddingX={1} height={3}>
        <PromptComposer
          value={isSetupSecretStep(step()) ? maskValue(props.state.input.value) : props.state.input.value}
          cursor={props.state.input.cursor}
          placeholder={inputPlaceholder(step())}
          width={Math.max(4, props.width - 4)}
          maxLines={1}
        />
      </box>
      <text content={truncateLine("Enter continues · Esc goes back", props.width)} wrapMode="none" fg={palette.textDim} />
    </>
  );
}

function ChoicePageView(props: { state: SetupState; width: number; height: number; compact: boolean }) {
  return (
    <Switch fallback={
      <box flexDirection="column"><OptionList items={setupChoiceItems(props.state)} selectedIndex={props.state.selectedIndex} width={props.width} /></box>
    }>
      <Match when={props.state.step === "discovering" || props.state.step === "mcp-testing" || props.state.step === "saving"}>
        <text content="Working..." fg={palette.warn} />
      </Match>
      <Match when={props.state.step === "models" || props.state.step === "mcp-engines"}>
        <MultiSelectPageView state={props.state} width={props.width} height={props.height} />
      </Match>
      <Match when={props.state.step === "review"}>
        <ReviewPageView state={props.state} width={props.width} compact={props.compact} />
      </Match>
      <Match when={props.state.step === "mcp-result"}>
        <McpResultPageView state={props.state} width={props.width} />
      </Match>
    </Switch>
  );
}

function MultiSelectPageView(props: { state: SetupState; width: number; height: number }) {
  const window = createMemo(() => {
    const values = props.state.step === "models" ? props.state.models : [...engineIds];
    return visibleWindow(setupMultiSelectChoices(values), props.state.selectedIndex, setupMultiSelectVisibleRowLimit(props.height));
  });
  return (
    <box flexDirection="column">
      <For each={window().visible}>{(item, index) => {
        const absolute = () => window().start + index();
        const selected = () => absolute() === props.state.selectedIndex;
        const checked = () => item.kind === "value" && (props.state.step === "models"
          ? props.state.selectedModels.includes(item.value as string)
          : props.state.mcpDraft.enabledEngines.includes(item.value as EngineId));
        const content = () => item.kind === "back"
          ? `${selected() ? ">" : " "} Back  — Return to the previous step`
          : `${selected() ? ">" : " "} [${checked() ? "x" : " "}] ${item.value}`;
        return <text
          content={truncateLine(content(), props.width)}
          wrapMode="none"
          fg={selected() ? palette.textPrimary : palette.textSecondary}
          attributes={selected() ? TextAttributes.BOLD : TextAttributes.NONE}
        />;
      }}</For>
      <text content={truncateLine(props.state.step === "models" ? "Space toggles · A adds a model · Enter continues · Esc goes back" : "Space toggles · Enter tests connection · Esc goes back", props.width)} wrapMode="none" fg={palette.textDim} />
    </box>
  );
}

function ReviewPageView(props: { state: SetupState; width: number; compact: boolean }) {
  return (
    <box flexDirection="column">
      <text content={truncateLine(`Provider  ${props.state.baseUrl}`, props.width)} wrapMode="none" fg={palette.textSecondary} />
      <text content={truncateLine(`Models    ${props.state.selectedModels.length} selected · default ${props.state.defaultModel}`, props.width)} wrapMode="none" fg={palette.textSecondary} />
      <Show when={!props.compact} fallback={
        <text content={truncateLine(`Permission ${props.state.permissionMode} · Tavily ${props.state.tavilyApiKey ? "on" : "off"} · MCP ${props.state.mcpServers.length}`, props.width)} wrapMode="none" fg={palette.textSecondary} />
      }>
        <text content={truncateLine(`Tavily    ${props.state.tavilyApiKey ? "configured" : "skipped"}`, props.width)} wrapMode="none" fg={palette.textSecondary} />
        <text content={truncateLine(`MCP       ${props.state.mcpServers.length} server(s)`, props.width)} wrapMode="none" fg={palette.textSecondary} />
        <text content={truncateLine(`Permission ${props.state.permissionMode} · shell default off / existing setting preserved`, props.width)} wrapMode="none" fg={palette.textSecondary} />
      </Show>
      <text content={truncateLine(`First run ${props.state.projectDirectory || "skipped; no project is pinned"}`, props.width)} wrapMode="none" fg={palette.textSecondary} />
      <box marginTop={1} flexDirection="column">
        <OptionList items={setupChoiceItems(props.state)} selectedIndex={props.state.selectedIndex} width={props.width} />
      </box>
    </box>
  );
}

function McpResultPageView(props: { state: SetupState; width: number }) {
  const result = () => props.state.mcpTestResult;
  return (
    <box flexDirection="column">
      <text content={truncateLine(props.state.mcpTestError || `Connected${result()?.serverName ? ` to ${result()!.serverName}` : ""}; ${result()?.toolCount ?? 0} tools found.`, props.width)} wrapMode="none" fg={props.state.mcpTestError ? palette.error : palette.success} />
      <box marginTop={1} flexDirection="column">
        <OptionList items={setupChoiceItems(props.state)} selectedIndex={props.state.selectedIndex} width={props.width} />
      </box>
    </box>
  );
}

function OptionList(props: { items: SetupChoiceItem[]; selectedIndex: number; width: number }) {
  return <For each={props.items}>{(item, index) => {
    const selected = () => index() === props.selectedIndex;
    return <text
      content={truncateLine(`${selected() ? ">" : " "} ${item.label}${item.detail ? `  — ${item.detail}` : ""}`, props.width)}
      wrapMode="none"
      fg={selected() ? palette.textPrimary : palette.textSecondary}
      attributes={selected() ? TextAttributes.BOLD : TextAttributes.NONE}
    />;
  }}</For>;
}

export function setupUsesCompactHeight(height: number, currentStep?: SetupStep): boolean {
  return height < (currentStep === "review" ? 27 : 24);
}

export function setupMultiSelectVisibleRowLimit(height: number): number {
  const structuralRows = setupUsesCompactHeight(height, "models") ? 6 : 17;
  return Math.max(5, Math.min(14, height - structuralRows));
}

export function maskValue(value: string): string {
  return value.replace(/[\s\S]/g, "•");
}

function inputLabel(step: SetupInputStep): string {
  const labels: Record<SetupInputStep, string> = {
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
  return labels[step];
}

function inputPlaceholder(step: SetupInputStep): string {
  const placeholders: Record<SetupInputStep, string> = {
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
  return placeholders[step];
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

function statusIsError(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized.includes("failed") || normalized.includes("required");
}
