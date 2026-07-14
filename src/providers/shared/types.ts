import type { ToolCall, ToolDefinition } from "../../core/tools";

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
  source: "clipboard" | "project";
  sourcePath?: string;
  detail?: ImageDetail;
  data?: string;
};

export type VesicleMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Host-only lifecycle classification; provider adapters ignore it. */
  kind?: string;
  reasoningContent?: string;
  thinkingBlocks?: ProviderThinkingBlock[];
  toolCallId?: string;
  toolCalls?: ToolCall[];
  images?: VesicleImageAttachment[];
};

export type VesicleRequest = {
  id: string;
  model: ModelRef;
  system: string[];
  messages: VesicleMessage[];
  tools?: ToolDefinition[];
  /** Host cancellation for the in-flight provider request. Never serialized. */
  signal?: AbortSignal;
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
  finishReason?: string;
  raw?: unknown;
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
  | { type: "complete"; response: VesicleResponse };

export interface ProviderAdapter {
  id: string;
  complete(request: VesicleRequest): Promise<VesicleResponse>;
  stream?(request: VesicleRequest): AsyncIterable<ProviderStreamEvent>;
}
