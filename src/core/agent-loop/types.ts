import type { ProviderSelection } from "../../config/providers";
import type { ProviderThinkingBlock, ResponseUsage, VesicleImageAttachment, VesicleMessage, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import type { AgentManager } from "../agents/manager";
import type { AgentRuntimeEvent } from "../agents/types";
import type { EngineId, EngineProfile } from "../engine/profile";
import type { EngineSwitchRequest } from "../engine/switch";
import type { GateRequest, GateResolution } from "../gate/types";
import type { PermissionRequest, PermissionResolution, PermissionRuntimeOptions, ToolPermissionBroker } from "../permissions";
import type { FileToolEvent, McpToolEvent, ProcessToolEvent, ToolCall, WebToolEvent } from "../tools";
import type { UserQuestionRequest } from "../user-question/types";
import type { ValidationResult } from "../validators/registry";

export type RunPromptOptions = {
  input: string;
  engine?: EngineId;
  rootDir?: string;
  sessionId?: string;
  sessionParentUuid?: string | null;
  messages?: VesicleMessage[];
  images?: VesicleImageAttachment[];
  inputMetadata?: Record<string, unknown>;
  prePersistedInputUuid?: string;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  agentManager?: AgentManager;
  permission?: PermissionRuntimeOptions;
  permissionBroker?: ToolPermissionBroker;
};

export type AgentLoopEvent =
  | AgentRuntimeEvent
  | { type: "asset_drift"; fingerprint: string; changedPaths: string[] }
  | { type: "provider_request"; iteration: number }
  | { type: "assistant_delta"; delta: string }
  | { type: "assistant_reasoning_delta"; delta: string }
  | { type: "tool_call_delta"; name?: string; argumentsDelta?: string }
  | {
      type: "assistant_response";
      content: string;
      reasoningContent?: string;
      thinkingBlocks?: ProviderThinkingBlock[];
      usage?: ResponseUsage;
      toolCalls: Array<{ id: string; name: string; arguments: string }>;
    }
  | { type: "tool_call"; name: string; callId: string; arguments: string }
  | { type: "tool_result"; name: string; callId: string; ok: boolean; content: string; fileEvent?: FileToolEvent; webEvent?: WebToolEvent; mcpEvent?: McpToolEvent; processEvent?: ProcessToolEvent; images?: VesicleImageAttachment[] }
  | { type: "process_update"; callId: string; processEvent: ProcessToolEvent }
  | { type: "permission_pending"; request: PermissionRequest }
  | { type: "gate_pending"; gate: string }
  | { type: "engine_switch_pending"; targetEngine: EngineId }
  | { type: "user_question_pending"; header: string }
  | { type: "validation"; ok: boolean };

export type ValidatorOutcome = {
  ok: boolean;
  results: Array<{ name: string; result: ValidationResult }>;
};

export type DeferredAgentPermission = {
  request: PermissionRequest;
  resolution: PermissionResolution;
};

export type RunPromptResult =
  | {
      kind: "complete";
      sessionId: string;
      sessionPath: string;
      response: VesicleResponse;
      profile: EngineProfile;
      validation?: ValidatorOutcome;
      messages: VesicleMessage[];
    }
  | {
      kind: "needs_user";
      sessionId: string;
      sessionPath: string;
      profile: EngineProfile;
      gate: GateRequest;
      toolCallId: string;
      assistantContent: string;
      messages: VesicleMessage[];
    }
  | {
      kind: "needs_engine_switch";
      sessionId: string;
      sessionPath: string;
      profile: EngineProfile;
      request: EngineSwitchRequest;
      toolCallId: string;
      assistantContent: string;
      messages: VesicleMessage[];
    }
  | {
      kind: "needs_user_question";
      sessionId: string;
      sessionPath: string;
      profile: EngineProfile;
      question: UserQuestionRequest;
      toolCallId: string;
      assistantContent: string;
      messages: VesicleMessage[];
    }
  | {
      kind: "needs_permission";
      sessionId: string;
      sessionPath: string;
      profile: EngineProfile;
      request: PermissionRequest;
      remainingToolCalls: ToolCall[];
      deferredAgentPermissions?: DeferredAgentPermission[];
      assistantContent: string;
      messages: VesicleMessage[];
    };

export type EngineSwitchConfirmedResult = {
  kind: "engine_switched";
  sessionId: string;
  sessionPath: string;
  messages: VesicleMessage[];
  request: EngineSwitchRequest;
  resolution: GateResolution;
  engine: EngineId;
};

export type ResolveEngineSwitchResult = EngineSwitchConfirmedResult | RunPromptResult;
