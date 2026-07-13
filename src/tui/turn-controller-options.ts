import type { Accessor, Setter } from "solid-js";
import type { ProviderSelection } from "../config/providers";
import type { AgentLoopEvent, RunPromptResult } from "../core/agent-loop/run";
import type { AgentManager } from "../core/agents/manager";
import type { AgentInboxEntry } from "../core/agents/types";
import type { EngineId } from "../core/engine/profile";
import type { PermissionMode, ToolPermissionBroker } from "../core/permissions";
import type { ConversationRewind } from "../core/rewind/service";
import type { ReasoningTier, VesicleImageAttachment, VesicleMessage } from "../providers/shared/types";
import type { ComposerElement, ComposerState } from "./composer";
import type { PromptHistoryEntry } from "./composer-history";
import type { GateFocusTarget } from "./GatePrompt";
import type { PendingEngineSwitchState, PendingGateState, PendingPermissionState, PendingUserQuestionState } from "./decision-interaction";
import type { ActivityEntry, AgentCardState, Message, SessionPickerState } from "./types";

type GenerationSelection = { reasoningTier: ReasoningTier } | undefined;

export type TurnControllerOptions = {
  rootDir: string;
  dangerouslySkipPermissions: boolean;
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
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
  sessionId: Accessor<string | undefined>;
  setSessionId: Setter<string | undefined>;
  sessionPath: Accessor<string>;
  setSessionPath: Setter<string>;
  conversation: Accessor<VesicleMessage[]>;
  setConversation: Setter<VesicleMessage[]>;
  nextSessionParent: Accessor<{ uuid: string | null } | null>;
  setNextSessionParent: Setter<{ uuid: string | null } | null>;
  setOutput: Setter<string>;
  setStatus: Setter<string>;
  messages: Accessor<Message[]>;
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
  pendingChildPermission: Accessor<unknown | null>;
  setQuestionSelected: Setter<number>;
  questionSelected: Accessor<number>;
  questionFreeformText: Accessor<string>;
  clearQuestionFreeform: () => void;
  setGateFocus: Setter<GateFocusTarget>;
  setGateFeedbackMode: Setter<GateFocusTarget | null>;
  clearGateFeedback: () => void;
  setSessionPicker: Setter<SessionPickerState | null>;
  pausedAgentDeliveries: Set<string>;
  agentManager: () => AgentManager;
  permissionBroker: ToolPermissionBroker;
  runCancellable: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<{ kind: "complete"; value: T } | { kind: "interrupted" }>;
  handleAgentEvent: (event: AgentLoopEvent) => void;
  beginUsageTurn: () => void;
  publishTurnUsage: () => void;
  recordIndependentAgentUsage: (usage: NonNullable<AgentInboxEntry["usage"]>) => void;
  recordActivity: (entry: ActivityEntry) => void;
  refreshArtifacts: () => Promise<unknown>;
  compactSession: (instructions?: string) => Promise<{ summary: string; messagesSummarized: number }>;
  executeLocalCommand: (prompt: string) => Promise<void>;
  recordPromptHistory: (value: string, elements: ComposerElement[], images: VesicleImageAttachment[]) => void;
  applyComposerState: (state: ComposerState) => void;
  setInputImages: Setter<VesicleImageAttachment[]>;
  setHistoryIndex: Setter<number | null>;
  setPromptHistory: Setter<PromptHistoryEntry[]>;
  applyConversationRewind: (result: ConversationRewind) => Promise<void>;
};

export type DecisionContinuationOptions = Pick<TurnControllerOptions,
  | "activeEngine"
  | "activeGeneration"
  | "activeProviderSelection"
  | "agentCards"
  | "agentManager"
  | "beginUsageTurn"
  | "busy"
  | "clearGateFeedback"
  | "clearQuestionFreeform"
  | "compactSession"
  | "handleAgentEvent"
  | "pendingChildPermission"
  | "pendingEngineSwitch"
  | "pendingGate"
  | "pendingPermission"
  | "pendingUserQuestion"
  | "permissionBroker"
  | "questionFreeformText"
  | "questionSelected"
  | "recordActivity"
  | "rootDir"
  | "runCancellable"
  | "setActiveEngine"
  | "setBusy"
  | "setConversation"
  | "setGateFeedbackMode"
  | "setMessages"
  | "setPendingEngineSwitch"
  | "setPendingGate"
  | "setPendingPermission"
  | "setPendingUserQuestion"
  | "setQuestionSelected"
  | "setSessionId"
  | "setSessionPath"
  | "setStatus"
> & {
  handleResult: (result: RunPromptResult) => void;
  handleInterruptedTurn: () => void;
  permissionContext: () => { mode: PermissionMode; dangerouslySkipPermissions?: true; shellExecEnabled: boolean };
  reportError: (error: unknown) => void;
};
