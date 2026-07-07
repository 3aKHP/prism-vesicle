import type { ToolCall, ToolDefinition } from "../../core/tools";

export const reasoningTiers = ["off", "low", "midium", "high", "xhigh", "max"] as const;
export type ReasoningTier = typeof reasoningTiers[number];

export type ModelRef = {
  provider: string;
  model: string;
};

export type ProviderThinkingBlock = {
  type: string;
  [key: string]: unknown;
};

export type VesicleMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoningContent?: string;
  thinkingBlocks?: ProviderThinkingBlock[];
  toolCallId?: string;
  toolCalls?: ToolCall[];
};

export type VesicleRequest = {
  id: string;
  model: ModelRef;
  system: string[];
  messages: VesicleMessage[];
  tools?: ToolDefinition[];
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
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
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
