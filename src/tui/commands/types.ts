// Command subsystem types. A slash command is a data object with a `run`
// handler that receives a CommandContext (the TUI state + callbacks the old
// handleCommand closure depended on) plus its parsed arguments and the raw
// input (echoed into the transcript). Command definitions can add focused host
// interactions such as provider/model completion without moving state into
// the dispatch layer.

import type { ProviderRegistry, ProviderSelection } from "../../config/providers";
import type { ModelLimits } from "../../config/env";
import type { EngineId } from "../../core/engine/profile";
import type { EngineTransition } from "../../core/engine/transition";
import type { ReasoningTier, VesicleMessage } from "../../providers/shared/types";
import type { ReasoningDisplayMode, SessionSummary } from "../../core/session/store";
import type { ArtifactEntry } from "../../core/artifacts/workbench";
import type {
  ActivityEntry,
  Message,
  SelectedArtifact,
  SessionPickerState,
} from "../types";

export type UsageTelemetrySummary = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  contextInputTokens: number;
};

/**
 * Everything a slash command handler needs from the TUI. The App component
 * constructs one instance and passes it to executeCommand. Fields group by
 * concern to keep the ~30 dependencies scannable.
 */
export type CommandContext = {
  // —— transcript ——
  setMessages: (updater: (prev: Message[]) => Message[]) => void;

  // —— provider / model ——
  activeProvider: () => string;
  activeModel: () => string;
  activeModelLimits: () => ModelLimits | undefined;
  ensureProviderRegistry: () => Promise<ProviderRegistry>;
  applyProviderSelection: (selection: Partial<ProviderSelection>) => Promise<ProviderSelection>;
  persistProviderSwitch: (selection: ProviderSelection) => Promise<void>;

  // —— engine ——
  activeEngine: () => EngineId;
  setActiveEngine: (engine: EngineId) => void;
  persistEngineSwitch: (transition: EngineTransition) => Promise<void>;

  // —— thinking effort / reasoning display ——
  thinkingTier: () => ReasoningTier | undefined;
  setThinkingTier: (tier: ReasoningTier | undefined) => void;
  persistThinkingSwitch: (tier: ReasoningTier | undefined) => Promise<void>;
  reasoningDisplayMode: () => ReasoningDisplayMode;
  setReasoningDisplayMode: (mode: ReasoningDisplayMode) => void;
  persistReasoningSwitch: (mode: ReasoningDisplayMode) => Promise<void>;

  // —— artifacts ——
  artifacts: () => ArtifactEntry[];
  refreshArtifacts: () => Promise<ArtifactEntry[]>;
  loadArtifactPreview: (artifact: ArtifactEntry, opts?: { validate?: boolean }) => Promise<SelectedArtifact>;
  setSelectedArtifact: (artifact: SelectedArtifact) => void;

  // —— status / activity ——
  setStatus: (status: string) => void;
  recordActivity: (event: ActivityEntry) => void;

  // —— session ——
  setSessionId: (id: string | undefined) => void;
  setSessionPath: (path: string) => void;
  setConversation: (messages: VesicleMessage[]) => void;
  setOutput: (text: string) => void;
  lastTurnUsage: () => UsageTelemetrySummary | undefined;
  sessionUsage: () => UsageTelemetrySummary;
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
  openRewindPicker: () => Promise<void>;
  resetRewindState: () => void;
  agentCommand: (args: string) => Promise<string>;

  // —— model picker (used by /model with no args) ——
  openModelPicker: () => Promise<void>;
};

export type Command = {
  name: string;
  aliases?: string[];
  /** One-line summary shown in /help and the popup. */
  description: string;
  /** Usage hint, e.g. "/engine <id>". */
  usage?: string;
  /**
   * Execute the command. `args` is the raw text after the command name
   * (trimmed, whitespace-normalised); `raw` is the full input including the
   * leading slash, echoed into the transcript as the user turn.
   */
  run: (ctx: CommandContext, args: string, raw: string) => Promise<void>;
};
