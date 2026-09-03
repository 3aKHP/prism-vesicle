// Command subsystem types. A slash command is a data object with a `run`
// handler that closes over a domain-specific context (the narrow TUI state
// its family reads) and receives its parsed arguments plus the raw input
// (echoed into the transcript). Command definitions can add focused host
// interactions such as provider/model completion without moving state into
// the dispatch layer.

import type { ProviderRegistry, ProviderSelection } from "../../config/providers";
import type { GenerationDefaults, ModelLimits } from "../../config/env";
import type { EngineId } from "../../core/engine/profile";
import type { EngineTransition } from "../../core/engine/transition";
import type { ReasoningTier, VesicleMessage } from "../../providers/shared/types";
import type { ReasoningDisplayMode, SessionSummary } from "../../core/session/store";
import type { SessionTitleSource } from "../../core/session/store";
import type { PermissionMode } from "../../core/permissions";
import type { ArtifactEntry } from "../../core/artifacts/workbench";
import type { ThemePreference } from "../theme";
import type { ProjectPathEntry } from "../../core/project/path-index";
import type { WebSearchOverrideResult } from "../web-search-controller";
import type {
  ActivityEntry,
  Message,
  OptionItem,
  SelectedArtifact,
  SessionPickerState,
} from "../types";

export type UsageTelemetrySummary = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  contextInputTokens: number;
};

/** One session-catalog entry offered to `/skill` name completion. */
export type SkillCatalogCompletionEntry = {
  name: string;
  scope: string;
  description: string;
};

/**
 * Host-owned data sources available to command argument completion. Command
 * definitions describe their grammar; the TUI controller owns async loading,
 * filtering, and keyboard interaction.
 */
export type CommandCompletionContext = {
  rootDir: string;
  activeEngine: () => string;
  providerRegistry: () => ProviderRegistry | null;
  activeProvider: () => string;
  refreshArtifacts: () => Promise<ArtifactEntry[]>;
  listWorkspaceTargets: () => Promise<ProjectPathEntry[]>;
  listSessions: () => Promise<SessionSummary[]>;
  agentOptions: () => OptionItem[];
  /**
   * The session's activatable Skill catalog (#312): the same read-only
   * freeze-then-snapshot resolution the `/skill` picker and activation use,
   * so completion never suggests a name that would fail with `Unknown skill`.
   */
  skillCatalogEntries: () => Promise<readonly SkillCatalogCompletionEntry[]>;
};

export type CommandArgumentCompletion = {
  /** Stable while only the filter query changes; used to discard stale loads. */
  sourceKey: string;
  /** Changes for every editable draft so selection resets predictably. */
  selectionKey: string;
  query: string;
  hint: string;
  items: OptionItem[] | (() => Promise<OptionItem[]>);
  complete: (item: OptionItem) => string;
};

export type CommandCompletion = {
  resolve: (draft: string, context: CommandCompletionContext) => CommandArgumentCompletion | null;
};

export type CommandQueueBoundary = "tool-round" | "agent-loop";

export type CommandBusyBehavior =
  | { kind: "immediate" }
  | { kind: "queue"; boundary: CommandQueueBoundary }
  | { kind: "reject"; reason: string };

export type CommandBusyBehaviorResolver = CommandBusyBehavior | ((args: string) => CommandBusyBehavior);

// Each command family declares its own narrow context — the fields its
// commands actually read. A family factory closes over its context at
// registration time (see src/tui/commands/*.ts), so adding a field for one
// family never touches the others. The App builds these slices separately
// rather than one flat host bag; createBuiltinCommands composes the registry.

/** Transcript writes every command family may need. */
export type CommandEchoPort = {
  setMessages: (updater: (prev: Message[]) => Message[]) => void;
};

/** Echo plus the status/activity log mutating commands share. */
export type CommandActivityPort = CommandEchoPort & {
  setStatus: (status: string) => void;
  recordActivity: (event: ActivityEntry) => void;
};

/** Theme surface owned by the theme controller; /theme reads all of it. */
export type CommandThemePort = {
  statusText: () => string;
  applyOverride: (pref: ThemePreference) => void;
  clearOverride: () => void;
  persistProject: (pref: ThemePreference) => Promise<void>;
  unsetProject: () => Promise<void>;
};

/** Built-in web search surface owned by the web-search controller. */
export type CommandWebSearchPort = {
  statusText: () => Promise<string>;
  applyOverride: (enabled: boolean) => Promise<WebSearchOverrideResult>;
  clearOverride: () => void;
};

/** /model, /effort, /reasoning, /context — provider/model configuration. */
export type ProviderCommandContext = CommandActivityPort & {
  activeProvider: () => string;
  activeModel: () => string;
  activeModelGeneration: () => GenerationDefaults | undefined;
  activeModelLimits: () => ModelLimits | undefined;
  ensureProviderRegistry: () => Promise<ProviderRegistry>;
  applyProviderSelection: (selection: Partial<ProviderSelection>) => Promise<ProviderSelection>;
  persistProviderSwitch: (selection: ProviderSelection) => Promise<void>;
  openModelPicker: () => Promise<void>;
  thinkingTier: () => ReasoningTier | undefined;
  setThinkingTier: (tier: ReasoningTier | undefined) => void;
  persistThinkingSwitch: (tier: ReasoningTier | undefined) => Promise<void>;
  reasoningDisplayMode: () => ReasoningDisplayMode;
  setReasoningDisplayMode: (mode: ReasoningDisplayMode) => void;
  persistReasoningSwitch: (mode: ReasoningDisplayMode) => Promise<void>;
  lastTurnUsage: () => UsageTelemetrySummary | undefined;
  sessionUsage: () => UsageTelemetrySummary;
};

/** /engine, /instructions — Prism engine switch and instruction resolution. */
export type EngineCommandContext = CommandActivityPort & {
  activeEngine: () => EngineId;
  setActiveEngine: (engine: EngineId) => void;
  persistEngineSwitch: (transition: EngineTransition) => Promise<void>;
  compactSession: (instructions?: string) => Promise<{ summary: string; messagesSummarized: number }>;
};

/** /new, /resume, /rewind, /compact, /init — session lifecycle. */
export type SessionCommandContext = CommandActivityPort & {
  activeEngine: () => EngineId;
  setActiveEngine: (engine: EngineId) => void;
  setSessionId: (id: string | undefined) => void;
  setSessionPath: (path: string) => void;
  setConversation: (messages: VesicleMessage[]) => void;
  setOutput: (text: string) => void;
  setLastTurnUsage: (usage: UsageTelemetrySummary | undefined) => void;
  setSessionUsage: (usage: UsageTelemetrySummary) => void;
  setPendingGate: (value: null) => void;
  setPendingEngineSwitch: (value: null) => void;
  setPendingUserQuestion: (value: null) => void;
  setResumableSessions: (sessions: SessionSummary[]) => void;
  setSessionPicker: (state: SessionPickerState | null) => void;
  listSessions: () => Promise<SessionSummary[]>;
  resumeSession: (target: SessionSummary, commandEcho?: string) => Promise<void>;
  compactSession: (instructions?: string) => Promise<{ summary: string; messagesSummarized: number }>;
  initProject: (options?: { notes?: string; force?: boolean }) => Promise<{ path: string; overwritten: boolean }>;
  openRewindPicker: () => Promise<void>;
  openBranchPicker: () => Promise<void>;
  resetRewindState: () => void;
  theme: { clearOverride: () => void };
  webSearch: { clearOverride: () => void };
  title?: {
    sessionId: () => string | undefined;
    current: () => Promise<{ title?: string; source?: SessionTitleSource }>;
    rename: (title: string) => Promise<void>;
    regenerate: () => Promise<void>;
  };
};

/** /quality — experimental Semantic Judge configuration. */
export type QualityCommandContext = CommandActivityPort & {
  openQualityPicker: (focusMode?: "observe" | "rewrite") => Promise<void>;
  openQualityRewriteConfirm: (candidate: { providerAlias: string; modelId: string; judgeTimeoutMs: number }) => Promise<void>;
  ensureProviderRegistry: () => Promise<ProviderRegistry>;
  activeProvider: () => string;
  activeModel: () => string;
};

/** /skill — skill picker, activation, and explicit catalog re-freeze. */
export type SkillCommandContext = CommandEchoPort & {
  openSkillPicker: () => Promise<void>;
  activateSkill: (name: string, options: { mode: "invoke" | "context-only"; taskText?: string }) => Promise<void>;
  /** `/skill refresh` (#308): re-freeze the session catalog at current installation content. */
  refreshSkillCatalog: () => Promise<void>;
};

/** /workspace, /artifact, /validate — Workspace page and artifact preview. */
export type WorkspaceCommandContext = CommandActivityPort & {
  openWorkspaceTarget: (relPath?: string) => Promise<"file" | "dir" | null>;
  refreshArtifacts: () => Promise<ArtifactEntry[]>;
  loadArtifactPreview: (artifact: ArtifactEntry, opts?: { validate?: boolean }) => Promise<SelectedArtifact>;
  setSelectedArtifact: (artifact: SelectedArtifact) => void;
};

/** /theme — colour theme status, override, and project persistence. */
export type ThemeCommandContext = CommandActivityPort & {
  theme: CommandThemePort;
};

/** /websearch — provider-native built-in web search status and session override. */
export type WebSearchCommandContext = CommandActivityPort & {
  webSearch: CommandWebSearchPort;
};

/** /agents, /stage, /btw — SubAgent control, Stage startup, side questions. */
export type AgentsCommandContext = CommandEchoPort & {
  agentCommand: (args: string) => Promise<string>;
  startStage?: (characterPath: string, scenarioPath: string, commandEcho: string) => Promise<void>;
  openSideQuestion: (args: string) => Promise<void>;
};

/** /permissions — tool approval mode. */
export type PermissionsCommandContext = CommandEchoPort & {
  permissionMode: () => PermissionMode;
  changePermissionMode: (mode: PermissionMode) => Promise<void>;
};

/** /help — static help text. */
export type HelpCommandContext = CommandEchoPort;

/** All domain context slices the App builds and hands to createBuiltinCommands. */
export type BuiltinCommandContexts = {
  provider: ProviderCommandContext;
  engine: EngineCommandContext;
  session: SessionCommandContext;
  quality: QualityCommandContext;
  skills: SkillCommandContext;
  workspace: WorkspaceCommandContext;
  theme: ThemeCommandContext;
  webSearch: WebSearchCommandContext;
  agents: AgentsCommandContext;
  permissions: PermissionsCommandContext;
  help: HelpCommandContext;
};

export type Command = {
  name: string;
  aliases?: string[];
  /** Required scheduling contract when the Agent Loop is busy. */
  busyBehavior: CommandBusyBehaviorResolver;
  /** One-line summary shown in /help and the popup. */
  description: string;
  /** Usage hint, e.g. "/engine <id>". */
  usage?: string;
  /** Command-owned argument grammar and candidate sources, or explicit null when none apply. */
  completion: CommandCompletion | null;
  /**
   * Execute the command. `args` is the raw text after the command name
   * (trimmed, whitespace-normalised); `raw` is the full input including the
   * leading slash, echoed into the transcript as the user turn. Each command
   * family closes over its own narrow context at registration time, so `run`
   * receives only the parsed arguments, not a shared host bag.
   */
  run: (args: string, raw: string) => Promise<void>;
};
