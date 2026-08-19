import type { ToolCall, ToolDefinition } from "../../core/tools";
import type { ProviderStateEnvelope } from "./state";

export type { ProviderStateEnvelope } from "./state";

export const reasoningTiers = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningTier = typeof reasoningTiers[number];

export type ModelRef = {
  provider: string;
  model: string;
};

export type ProviderThinkingBlock = {
  type: string;
  [key: string]: unknown;
};

export type ImageDetail = "auto" | "high" | "original";

/**
 * A durable image reference carried by conversation/session messages.
 * `data` is populated only on the in-memory provider request copy; session
 * records retain the content-addressed file reference instead of base64.
 */
export type VesicleImageAttachment = {
  id: string;
  path: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  bytes: number;
  sha256: string;
  filename?: string;
  source: "clipboard" | "project" | "mcp";
  sourcePath?: string;
  detail?: ImageDetail;
  data?: string;
};

/**
 * Normalized citation from a provider-native web search. Field set is the
 * union across supported protocols; every field beyond url/title is optional
 * because providers differ (OpenAI/Interactions carry span indexes, MiMo's
 * dialect would carry summary/site metadata, DeepSeek emits none).
 */
export type WebSearchCitation = {
  url: string;
  title: string;
  startIndex?: number;
  endIndex?: number;
  summary?: string;
  siteName?: string;
  publishTime?: string;
};

/**
 * Replay record for one provider-native `web_search_call` item. Only the
 * openai-responses protocol produces and consumes these; status/action are
 * kept verbatim (union-tolerant across OpenAI/DeepSeek enum drift) so the
 * item can be replayed on later turns without host reinterpretation.
 */
export type WebSearchCallRecord = {
  id: string;
  status: string;
  action: Record<string, unknown>;
};

/**
 * Normalized report of server-side search executed inside a provider turn.
 * `queries` is the audit floor and is always present; `citations` is absent
 * when the provider injects results server-side without returning them
 * (DeepSeek — audit-degraded by contract); `calls` carries the replay payload
 * where the protocol requires echoing native items back.
 */
export type WebSearchReport = {
  provider: string;
  queries: string[];
  citations?: WebSearchCitation[];
  calls?: WebSearchCallRecord[];
};

export type VesicleMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Host-only lifecycle classification; provider adapters ignore it. */
  kind?: string;
  reasoningContent?: string;
  thinkingBlocks?: ProviderThinkingBlock[];
  toolCallId?: string;
  /** Host-derived tool outcome used by adapters with a native error flag. */
  toolOk?: boolean;
  toolCalls?: ToolCall[];
  /**
   * Server-side search grounding for this assistant turn (provider-native
   * built-in web search). Model capability, not a host tool call: permission
   * modes do not govern it and it never enters `toolCalls`.
   */
  webSearch?: WebSearchReport;
  /** Owner-qualified durable state. Only the matching provider adapter interprets it. */
  providerState?: ProviderStateEnvelope;
  images?: VesicleImageAttachment[];
};

/** Host-only checkpoint marker consumed only by its owning provider adapter. */
export const PROVIDER_NATIVE_CHECKPOINT_KIND = "provider-native-checkpoint";

/**
 * Transport retry notification, fired by `fetchProvider` immediately before it
 * sleeps for a retry. Runtime callback only — never serialized. Lets the host
 * UI observe the single transport-level retry loop without running its own.
 */
export type ProviderRetryInfo = {
  /** 1-based index of the retry about to happen. */
  attempt: number;
  maxRetries: number;
  delayMs: number;
  /** HTTP status that triggered the retry; absent for network errors. */
  status?: number;
};

export type VesicleRequest = {
  id: string;
  model: ModelRef;
  system: string[];
  messages: VesicleMessage[];
  tools?: ToolDefinition[];
  /**
   * Declare the selected model's provider-native web search for this turn.
   * Adapters that support it translate this into the protocol's built-in
   * search tool declaration; adapters without support leave it inert.
   */
  webSearch?: boolean;
  /** Host cancellation for the in-flight provider request. Never serialized. */
  signal?: AbortSignal;
  /** Observes transport retries (`fetchProvider`); never serialized. */
  onRetry?: (info: ProviderRetryInfo) => void;
  generation?: {
    temperature?: number;
    maxTokens?: number;
    reasoningTier?: ReasoningTier;
  };
  metadata?: Record<string, unknown>;
};

export type VesicleResponse = {
  id: string;
  content: string;
  reasoningContent?: string;
  thinkingBlocks?: ProviderThinkingBlock[];
  toolCalls?: ToolCall[];
  /** Server-side search grounding executed during this response, if any. */
  webSearch?: WebSearchReport;
  /** Validated provider-owned state published only with this completed response. */
  providerState?: ProviderStateEnvelope;
  finishReason?: string;
  raw?: unknown;
  usage?: ResponseUsage;
};

export type ProviderCompactRequest = {
  id: string;
  model: ModelRef;
  messages: VesicleMessage[];
  signal?: AbortSignal;
  onRetry?: (info: ProviderRetryInfo) => void;
};

export type ProviderCompactResult = {
  providerState: ProviderStateEnvelope;
  usage?: ResponseUsage;
};

export type ResponseUsage = {
  /**
   * Input tokens occupying the provider context window for this request.
   * Provider adapters normalize cache accounting here so UI context
   * percentages do not double-count or under-count cached input.
   */
  contextInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheHitInputTokens?: number;
  cacheMissInputTokens?: number;
  reasoningTokens?: number;
  effectiveTokens?: number;
  providerDetails?: Record<string, unknown>;
};

export type ProviderStreamEvent =
  | { type: "content_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "attempt_started"; attempt: number }
  | { type: "tool_call_candidate"; attempt: number; toolCall: ToolCall }
  | { type: "attempt_discarded"; attempt: number }
  | { type: "complete"; response: VesicleResponse; attempt?: number };

export interface ProviderAdapter {
  id: string;
  complete(request: VesicleRequest): Promise<VesicleResponse>;
  stream?(request: VesicleRequest): AsyncIterable<ProviderStreamEvent>;
  compact?(request: ProviderCompactRequest): Promise<ProviderCompactResult>;
  /** Commit provider-local lifecycle changes only after the host durably installs compact state. */
  commitCompact?(): void;
}
