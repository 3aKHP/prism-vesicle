import type { ResponseUsage } from "../../providers/shared/types";
import type { VesicleMessage, VesicleRequest } from "../../providers/shared/types";
import type { ProviderSelection } from "../../config/providers";
import type { EngineId } from "../engine/profile";
import type { ToolDefinition } from "../tools";
import type { AgentExecutionMode } from "./profile";
import type { PermissionRuntimeOptions, ToolPermissionBroker } from "../permissions";
import type { AssetResolver } from "../runtime/assets";
import type {
  BoundHarnessDelegation,
  HarnessAdapterErrorCategory,
  HarnessDelegationFailureInteraction,
  HarnessRuntimeContext,
} from "../harness/driver";

export type AgentStatus = "created" | "running" | "completed" | "failed" | "cancelled";

export type AgentSpec = {
  profileId: string;
  description: string;
  prompt: string;
  mode: AgentExecutionMode;
  parentSessionId: string;
  parentToolCallId: string;
  delegation?: AgentDelegationMetadata;
  delegationFailure?: HarnessDelegationFailureInteraction;
};

export type AgentDelegationMetadata = BoundHarnessDelegation & {
  attempt: number;
};

export type AgentAttemptMetadata = {
  attempt: number;
  status: "completed" | "failed" | "cancelled";
  finishedAt: string;
  childSessionId?: string;
  errorCategory?: HarnessAdapterErrorCategory;
  error?: string;
};

export type AgentMetadata = AgentSpec & {
  runId: string;
  handle: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  childSessionId?: string;
  result?: string;
  error?: string;
  usage?: ResponseUsage;
  toolUses?: number;
  recoveryComplete?: boolean;
  attempts?: AgentAttemptMetadata[];
  errorCategory?: HarnessAdapterErrorCategory;
};

export type AgentTerminalResult = {
  runId: string;
  handle: string;
  parentSessionId: string;
  profileId: string;
  description: string;
  mode: AgentExecutionMode;
  status: Extract<AgentStatus, "completed" | "failed" | "cancelled">;
  content: string;
  childSessionId?: string;
  usage?: ResponseUsage;
  toolUses?: number;
  delegation?: AgentDelegationMetadata;
  attempts?: AgentAttemptMetadata[];
  errorCategory?: HarnessAdapterErrorCategory;
};

export type AgentRuntimeEvent =
  | { type: "agent_created"; agent: AgentMetadata }
  | { type: "agent_started"; agent: AgentMetadata }
  | { type: "agent_progress"; runId: string; handle: string; parentSessionId: string; text: string }
  | { type: "agent_completed"; result: AgentTerminalResult }
  | { type: "agent_integrated"; runId: string; handle: string; parentSessionId: string };

export type AgentInboxState = "pending" | "delivered" | "acknowledged";

export type AgentInboxEntry = {
  inboxId: string;
  parentSessionId: string;
  runId: string;
  handle: string;
  profileId: string;
  description: string;
  status: AgentTerminalResult["status"];
  content: string;
  childSessionId?: string;
  usage?: ResponseUsage;
  toolUses?: number;
  delegation?: AgentDelegationMetadata;
  attempts?: AgentAttemptMetadata[];
  errorCategory?: HarnessAdapterErrorCategory;
  createdAt: string;
  state: AgentInboxState;
  deliveredAt?: string;
  acknowledgedAt?: string;
};

export type AgentRunContext = {
  runId: string;
  handle: string;
  spec: AgentSpec;
  signal: AbortSignal;
  invocation?: AgentInvocationContext;
  onProgress(text: string): void;
  takeMessages(): string[];
  claimMutation(paths: string[]): Promise<void>;
  registerChildSession(childSessionId: string): Promise<void>;
};

export type AgentInvocationContext = {
  rootDir: string;
  parentEngine: EngineId;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  parentToolDefinitions: ToolDefinition[];
  parentSystemPrompt: string;
  parentMessages: VesicleMessage[];
  parentSignal?: AbortSignal;
  beforeMutation?(paths: string[]): Promise<void>;
  permission?: PermissionRuntimeOptions;
  permissionBroker?: ToolPermissionBroker;
  assets?: AssetResolver;
  harness?: HarnessRuntimeContext;
};

export type AgentRunOutput = {
  content: string;
  childSessionId?: string;
  usage?: ResponseUsage;
  toolUses?: number;
};
