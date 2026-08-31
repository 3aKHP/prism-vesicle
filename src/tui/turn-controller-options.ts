import type { Accessor, Setter } from "solid-js";
import type { ProviderSelection } from "../config/providers";
import type { AgentLoopEvent } from "../core/agent-loop/run";
import type { AgentManager } from "../core/agents/manager";
import type { AgentInboxEntry } from "../core/agents/types";
import type { EngineId } from "../core/engine/profile";
import type { PermissionMode, ToolPermissionBroker } from "../core/permissions";
import type { ShellInterpreterPreference } from "../core/process/shell-profile";
import type { ConversationRewind } from "../core/rewind/service";
import type { SideQuestionContextSnapshot } from "../core/side-question/types";
import type { ReasoningTier, VesicleImageAttachment, VesicleMessage } from "../providers/shared/types";
import type { ComposerElement, ComposerState } from "./composer";
import type { PromptHistoryEntry } from "./composer-history";
import type { GateFocusTarget } from "./GatePrompt";
import type { PendingEngineSwitchState, PendingGateState, PendingPermissionState, PendingQualityDecisionState, PendingUserQuestionState } from "./decision-interaction";
import type { ActivityEntry, AgentCardState, Message, SessionPickerState } from "./types";
import type { QueuedWorkController } from "./queued-work-controller";

type GenerationSelection = { reasoningTier: ReasoningTier } | undefined;

export type PermissionContext = {
  mode: PermissionMode;
  dangerouslySkipPermissions?: true;
  shellExecEnabled: boolean;
  shellInterpreter: ShellInterpreterPreference;
};

export type TurnRunCancellable = <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<{ kind: "complete"; value: T } | { kind: "interrupted" }>;

/**
 * Named turn-domain ports (plan §4.3). `createTurnController` composes these
 * from the App-level options; every downstream owner (result controller and
 * continuation factories) declares its own slice of the ports it actually
 * consumes, so no owner depends on the full options bag. The responsibility
 * split is fixed: runtime readiness/selection, session, transcript, decision
 * accessors/setters, agents, usage, composer restore, and host actions.
 */

/** Provider/Engine/generation/permission readiness, selection, and turn gating. */
export type TurnRuntimePort = {
  dangerouslySkipPermissions: boolean;
  permissionMode: Accessor<PermissionMode>;
  shellExecEnabled: Accessor<boolean>;
  shellInterpreter: Accessor<ShellInterpreterPreference>;
  providerConfigReady: Accessor<boolean>;
  setProviderConfigReady: Setter<boolean>;
  loadProviderConfig: () => Promise<void>;
  permissionSettingsReady: Accessor<boolean>;
  loadPermissionSettings: () => Promise<void>;
  activeModelCapabilities: Accessor<{ vision?: boolean } | undefined>;
  activeEngine: Accessor<EngineId>;
  setActiveEngine: Setter<EngineId>;
  activeModel: Accessor<string>;
  activeProviderSelection: () => ProviderSelection;
  activeGeneration: () => GenerationSelection;
  permissionBroker: ToolPermissionBroker;
  /** Turn-active guard every owner checks before re-entry. */
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
};

/** Session identity, conversation, branch parent, and durable reload/rewind root. */
export type TurnSessionPort = {
  rootDir: string;
  sessionId: Accessor<string | undefined>;
  setSessionId: Setter<string | undefined>;
  setSessionPath: Setter<string>;
  conversation: Accessor<VesicleMessage[]>;
  setConversation: Setter<VesicleMessage[]>;
  nextSessionParent: Accessor<{ uuid: string | null } | null>;
  setNextSessionParent: Setter<{ uuid: string | null } | null>;
  setSessionPicker: Setter<SessionPickerState | null>;
};

/** Messages, streaming assistant/reasoning, status/output, and the activity log. */
export type TurnTranscriptPort = {
  setMessages: Setter<Message[]>;
  setStatus: Setter<string>;
  setOutput: Setter<string>;
  setStreamingAssistant: Setter<string>;
  setStreamingReasoning: Setter<string>;
  lastDisplayedToolAssistantContent: Accessor<string | null>;
  setLastDisplayedToolAssistantContent: Setter<string | null>;
  recordActivity: (entry: ActivityEntry) => void;
};

/** Pending gate/engine-switch/question/permission/quality accessors and setters. */
export type TurnDecisionPort = {
  pendingGate: Accessor<PendingGateState | null>;
  setPendingGate: Setter<PendingGateState | null>;
  pendingEngineSwitch: Accessor<PendingEngineSwitchState | null>;
  setPendingEngineSwitch: Setter<PendingEngineSwitchState | null>;
  pendingUserQuestion: Accessor<PendingUserQuestionState | null>;
  setPendingUserQuestion: Setter<PendingUserQuestionState | null>;
  pendingPermission: Accessor<PendingPermissionState | null>;
  setPendingPermission: Setter<PendingPermissionState | null>;
  pendingQualityDecision: Accessor<PendingQualityDecisionState | null>;
  setPendingQualityDecision: Setter<PendingQualityDecisionState | null>;
  pendingChildPermission: Accessor<unknown | null>;
  questionSelected: Accessor<number>;
  setQuestionSelected: Setter<number>;
  setQualitySelected: Setter<number>;
  questionFreeformText: Accessor<string>;
  clearQuestionFreeform: () => void;
  setGateFocus: Setter<GateFocusTarget>;
  setGateFeedbackMode: Setter<GateFocusTarget | null>;
  clearGateFeedback: () => void;
};

/** Agent manager, cards, paused delivery, and agent-loop event wiring. */
export type TurnAgentPort = {
  agentCards: Accessor<AgentCardState[]>;
  setAgentCards: Setter<AgentCardState[]>;
  pausedAgentDeliveries: Set<string>;
  agentManager: () => AgentManager;
  handleAgentEvent: (event: AgentLoopEvent) => void;
  onProviderContextSnapshot?: (snapshot: SideQuestionContextSnapshot) => void;
};

/** Background shell completion delivery: the two notified-flag capabilities the controller consumes, plus pause state. */
export type TurnProcessPort = {
  markNotified: (taskIds: string[]) => Promise<void>;
  resetNotified: (taskIds: string[]) => Promise<void>;
  pausedProcessDeliveries: Set<string>;
};

/** Turn / session / independent-Agent usage accounting. */
export type TurnUsagePort = {
  beginUsageTurn: () => void;
  publishTurnUsage: () => void;
  recordIndependentAgentUsage: (usage: NonNullable<AgentInboxEntry["usage"]>) => void;
};

/** Composer draft/history/image restore for failed or interrupted turns. */
export type TurnComposerPort = {
  recordPromptHistory: (value: string, elements: ComposerElement[], images: VesicleImageAttachment[]) => void;
  applyComposerState: (state: ComposerState) => void;
  composerValue: Accessor<string>;
  setInputImages: Setter<VesicleImageAttachment[]>;
  setHistoryIndex: Setter<number | null>;
  setPromptHistory: Setter<PromptHistoryEntry[]>;
  applyConversationRewind: (result: ConversationRewind) => Promise<void>;
};

/** Host actions the turn controller actually calls (artifact/quality/compact/command). */
export type TurnHostActionPort = {
  refreshArtifacts: () => Promise<unknown>;
  refreshQualityWarnings: (sessionId?: string) => Promise<unknown>;
  resumeQualitySession: (sessionId: string) => Promise<void>;
  compactSession: (instructions?: string) => Promise<{ summary: string; messagesSummarized: number }>;
  executeLocalCommand: (prompt: string) => Promise<void>;
};

export type TurnControllerOptions = {
  rootDir: string;
  dangerouslySkipPermissions: boolean;
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
  queuedWork: QueuedWorkController;
  providerConfigReady: Accessor<boolean>;
  setProviderConfigReady: Setter<boolean>;
  loadProviderConfig: () => Promise<void>;
  permissionSettingsReady: Accessor<boolean>;
  loadPermissionSettings: () => Promise<void>;
  activeModelCapabilities: Accessor<{ vision?: boolean } | undefined>;
  activeEngine: Accessor<EngineId>;
  setActiveEngine: Setter<EngineId>;
  activeModel: Accessor<string>;
  activeProviderSelection: () => ProviderSelection;
  activeGeneration: () => GenerationSelection;
  permissionMode: Accessor<PermissionMode>;
  shellExecEnabled: Accessor<boolean>;
  shellInterpreter: Accessor<ShellInterpreterPreference>;
  sessionId: Accessor<string | undefined>;
  setSessionId: Setter<string | undefined>;
  setSessionPath: Setter<string>;
  conversation: Accessor<VesicleMessage[]>;
  setConversation: Setter<VesicleMessage[]>;
  nextSessionParent: Accessor<{ uuid: string | null } | null>;
  setNextSessionParent: Setter<{ uuid: string | null } | null>;
  setOutput: Setter<string>;
  setStatus: Setter<string>;
  setMessages: Setter<Message[]>;
  agentCards: Accessor<AgentCardState[]>;
  setAgentCards: Setter<AgentCardState[]>;
  setStreamingAssistant: Setter<string>;
  setStreamingReasoning: Setter<string>;
  lastDisplayedToolAssistantContent: Accessor<string | null>;
  setLastDisplayedToolAssistantContent: Setter<string | null>;
  pendingGate: Accessor<PendingGateState | null>;
  setPendingGate: Setter<PendingGateState | null>;
  pendingEngineSwitch: Accessor<PendingEngineSwitchState | null>;
  setPendingEngineSwitch: Setter<PendingEngineSwitchState | null>;
  pendingUserQuestion: Accessor<PendingUserQuestionState | null>;
  setPendingUserQuestion: Setter<PendingUserQuestionState | null>;
  pendingPermission: Accessor<PendingPermissionState | null>;
  setPendingPermission: Setter<PendingPermissionState | null>;
  pendingQualityDecision: Accessor<PendingQualityDecisionState | null>;
  setPendingQualityDecision: Setter<PendingQualityDecisionState | null>;
  pendingChildPermission: Accessor<unknown | null>;
  setQuestionSelected: Setter<number>;
  questionSelected: Accessor<number>;
  setQualitySelected: Setter<number>;
  questionFreeformText: Accessor<string>;
  clearQuestionFreeform: () => void;
  setGateFocus: Setter<GateFocusTarget>;
  setGateFeedbackMode: Setter<GateFocusTarget | null>;
  clearGateFeedback: () => void;
  setSessionPicker: Setter<SessionPickerState | null>;
  pausedAgentDeliveries: Set<string>;
  markProcessNotified: (taskIds: string[]) => Promise<void>;
  resetProcessNotified: (taskIds: string[]) => Promise<void>;
  pausedProcessDeliveries: Set<string>;
  agentManager: () => AgentManager;
  permissionBroker: ToolPermissionBroker;
  runCancellable: TurnRunCancellable;
  handleAgentEvent: (event: AgentLoopEvent) => void;
  onProviderContextSnapshot?: (snapshot: SideQuestionContextSnapshot) => void;
  onSessionTitleChanged?: (title: string, sessionId: string) => void;
  beginUsageTurn: () => void;
  publishTurnUsage: () => void;
  recordIndependentAgentUsage: (usage: NonNullable<AgentInboxEntry["usage"]>) => void;
  recordActivity: (entry: ActivityEntry) => void;
  refreshArtifacts: () => Promise<unknown>;
  refreshQualityWarnings: (sessionId?: string) => Promise<unknown>;
  resumeQualitySession: (sessionId: string) => Promise<void>;
  compactSession: (instructions?: string) => Promise<{ summary: string; messagesSummarized: number }>;
  executeLocalCommand: (prompt: string) => Promise<void>;
  recordPromptHistory: (value: string, elements: ComposerElement[], images: VesicleImageAttachment[]) => void;
  applyComposerState: (state: ComposerState) => void;
  composerValue: Accessor<string>;
  setInputImages: Setter<VesicleImageAttachment[]>;
  setHistoryIndex: Setter<number | null>;
  setPromptHistory: Setter<PromptHistoryEntry[]>;
  applyConversationRewind: (result: ConversationRewind) => Promise<void>;
};
