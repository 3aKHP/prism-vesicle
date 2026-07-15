export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean };

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type AnthropicResponse = {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: AnthropicUsage;
  error?: {
    message?: string;
  };
};

export type AnthropicStreamEvent = {
  type?: string;
  index?: number;
  message?: {
    id?: string;
    model?: string;
    usage?: AnthropicUsage;
  };
  content_block?: AnthropicContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: AnthropicUsage;
  error?: {
    message?: string;
  };
};

export type AnthropicThinkingStreamBlock =
  | { thinking: string; signature?: string }
  | { redactedData: string };

export type AnthropicStreamState = {
  id: string;
  model: string;
  textParts: string[];
  thinkingBlocks: Map<number, AnthropicThinkingStreamBlock>;
  toolCalls: Map<number, { id: string; name: string; inputJson: string }>;
  finishReason?: string;
  usage: AnthropicUsage;
};
