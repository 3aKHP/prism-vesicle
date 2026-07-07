import type { ToolCall, ToolDefinition } from "../../core/tools";

export type ModelRef = {
  provider: string;
  model: string;
};

export type VesicleMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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
  };
  metadata?: Record<string, unknown>;
};

export type VesicleResponse = {
  id: string;
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  raw?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

export interface ProviderAdapter {
  id: string;
  complete(request: VesicleRequest): Promise<VesicleResponse>;
}
