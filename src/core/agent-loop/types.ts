import type { ProviderSelection } from "../../config/providers";
import type { ProviderThinkingBlock, ResponseUsage, VesicleImageAttachment, VesicleMessage, VesicleRequest, VesicleResponse, WebSearchReport } from "../../providers/shared/types";
import type { SideQuestionContextSnapshot } from "../side-question/types";
import type { AgentManager } from "../agents/manager";
import type { AgentRuntimeEvent } from "../agents/types";
import type { EngineId, EngineProfile } from "../engine/profile";
import type { EngineSwitchRequest } from "../engine/switch";
import type { GateRequest, GateResolution } from "../gate/types";
import type { PermissionRequest, PermissionResolution, PermissionRuntimeOptions, ToolPermissionBroker } from "../permissions";
import type { FileToolEvent, McpToolEvent, ProcessToolEvent, ToolCall, WebToolEvent } from "../tools";
import type { UserQuestionRequest } from "../user-question/types";
import type { HarnessDelegationDecision, HarnessRuntimeContext } from "../harness/driver";
import type { AssetResolver } from "../runtime/assets";
import type { ValidationResult } from "../validators/registry";
import type { InstructionDiagnostic } from "../instructions";
import type { QualityDecisionRequest, QualityFindingSummary, QualityOutcome, QualityTargetWarningReason } from "../quality";
import type { ExperimentalQualityProfile } from "../../config/quality";

export type RunPromptOptions = {
  input: string;
  engine?: EngineId;
  rootDir?: string;
  sessionId?: string;
  sessionParentUuid?: string | null;
  /**
   * Snapshot branch head. When set, bootstrap loads the session snapshot ending
   * at this record (via loadSessionSnapshot's headUuid) instead of the physical
   * tail, so harness-identity assertion, Skill hydration, and the round-0
   * message list derive from the fork-point branch (used by regenerate). The
   * append-chain fork is still controlled by sessionParentUuid; this field only
   * scopes the snapshot READ. Pre-turn compaction is skipped while it is set
   * (the compaction service appends to the physical tail and is not
   * branch-fork-aware — see turn-bootstrap.ts).
   */
  branchHeadUuid?: string | null;
  messages?: VesicleMessage[];
  images?: VesicleImageAttachment[];
  inputMetadata?: Record<string, unknown>;
  prePersistedInputUuid?: string;
  /**
   * Logical-turn identity for a deliberately reused input record. Regenerate
   * supplies the shared user record's identity so its sibling candidate cannot
   * be separated from that prompt by compaction. Other pre-persisted inputs
   * retain the normal fresh-turn behavior unless they opt in explicitly.
   */
  prePersistedInputLogicalTurnId?: string;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  onProviderContextSnapshot?: (snapshot: SideQuestionContextSnapshot) => void;
  agentManager?: AgentManager;
  permission?: PermissionRuntimeOptions;
  permissionBroker?: ToolPermissionBroker;
  harness?: HarnessRuntimeContext;
  assets?: AssetResolver;
  experimentalQuality?: ExperimentalQualityProfile;
  takePendingUserInputs?: () => PendingUserInput[];
  runToolBoundaryCommands?: () => Promise<void>;
  onSessionReady?: (sessionId: string, sessionPath: string) => void;
  onSessionTitleChanged?: (title: string, sessionId: string) => void;
};

export type PendingUserInput = {
  content: string;
  images?: VesicleImageAttachment[];
};

export type AgentLoopEvent =
  | AgentRuntimeEvent
  | { type: "asset_drift"; fingerprint: string; changedPaths: string[] }
  | {
      type: "instruction_warning";
      sessionId: string;
      engine: EngineId;
      diagnostics: InstructionDiagnostic[];
    }
  | { type: "provider_request"; iteration: number }
  | { type: "provider_retry"; attempt: number; maxRetries: number; delayMs: number; status?: number; iteration: number; scope?: "quality-judge" }
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
      webSearch?: WebSearchReport;
    }
  | { type: "tool_call"; name: string; callId: string; arguments: string }
  | { type: "tool_result"; name: string; callId: string; ok: boolean; content: string; fileEvent?: FileToolEvent; webEvent?: WebToolEvent; mcpEvent?: McpToolEvent; processEvent?: ProcessToolEvent; instructionEvent?: import("../instructions/types").InstructionToolEvent; skillEvent?: import("../skills/types").SkillToolEvent; images?: VesicleImageAttachment[] }
  | { type: "process_update"; callId: string; processEvent: ProcessToolEvent }
  | { type: "permission_pending"; request: PermissionRequest }
  | { type: "gate_pending"; gate: string }
  | { type: "engine_switch_pending"; targetEngine: EngineId }
  | { type: "user_question_pending"; header: string }
  | {
      type: "quality_status";
      phase: "checking" | "rewriting" | "clean" | "findings" | "inconclusive" | "observed" | "exhausted";
      attempt: number;
      findingCount: number;
      findings?: Array<QualityFindingSummary & { targetPath?: string }>;
      warningReasons?: QualityTargetWarningReason[];
    }
  | { type: "validation"; ok: boolean }
  | {
      type: "compact_check";
      phase: "pre-turn" | "mid-turn";
      result: "below" | "soft-trigger" | "hard-ceiling" | "inactive" | "degraded";
      projectedTokens?: number;
      usageSource?: "provider" | "estimated" | "unknown";
      softTriggerTokens?: number;
      hardInputCeilingTokens?: number;
      inactiveReason?: string;
    }
  | { type: "compact_started"; phase: "pre-turn" | "mid-turn" | "manual"; trigger: "manual" | "auto"; reason: "requested" | "soft-threshold" | "hard-ceiling" | "model-switch" }
  | {
      type: "compact_completed";
      phase: "pre-turn" | "mid-turn" | "manual";
      trigger: "manual" | "auto";
      reason: "requested" | "soft-threshold" | "hard-ceiling" | "model-switch";
      checkpointUuid: string;
      evictedUnits: number;
      retainedUnits: number;
      durationMs: number;
      usageSource?: "provider" | "estimated" | "unknown";
      beforeTokens?: number;
      projectedAfterTokens?: number;
    }
  | { type: "compact_failed"; phase: "pre-turn" | "mid-turn" | "manual"; trigger: "manual" | "auto"; reason: "requested" | "soft-threshold" | "hard-ceiling" | "model-switch"; durationMs: number; errorMessage: string }
  | { type: "compact_cancelled"; phase: "pre-turn" | "mid-turn" | "manual"; trigger: "manual" | "auto"; reason: "requested" | "soft-threshold" | "hard-ceiling" | "model-switch"; durationMs: number }
  | { type: "compact_deferred"; phase: "pre-turn" | "mid-turn"; reason: string };

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
      quality?: { outcome: QualityOutcome; findingCount: number };
      /** Durable assistant record ID when the response did not contain tools. */
      assistantRecordUuid?: string;
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
      delegationDecision?: HarnessDelegationDecision;
      toolCallId: string;
      assistantContent: string;
      messages: VesicleMessage[];
    }
  | {
      kind: "needs_quality_decision";
      sessionId: string;
      sessionPath: string;
      profile: EngineProfile;
      decision: QualityDecisionRequest;
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

export type QualityDecisionResolution = "retry" | "accept" | "stop";

export type QualityResolvedResult = {
  kind: "quality_resolved";
  sessionId: string;
  resolution: Exclude<QualityDecisionResolution, "retry">;
};

export type ResolveQualityDecisionResult = RunPromptResult | QualityResolvedResult;

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
