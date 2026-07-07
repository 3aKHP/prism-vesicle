import type { VesicleConfig } from "../../config/env";
import { ProviderError } from "../shared/errors";
import type { ProviderAdapter, ProviderThinkingBlock, ReasoningTier, VesicleRequest, VesicleResponse } from "../shared/types";
import type { ToolCall } from "../../core/tools";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

type AnthropicResponse = {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

const defaultMaxTokens = 4096;

export class AnthropicMessagesAdapter implements ProviderAdapter {
  readonly id = "anthropic-messages";

  constructor(private readonly config: VesicleConfig) {}

  async complete(request: VesicleRequest): Promise<VesicleResponse> {
    this.requireApiKey();

    const response = await fetch(`${this.config.baseUrl}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(toAnthropicMessagesBody(request)),
    });
    const body = await response.json().catch(() => undefined) as AnthropicResponse | undefined;
    if (!response.ok) {
      const providerMessage = body?.error?.message ?? response.statusText;
      throw new ProviderError(`Provider request failed (${response.status}): ${providerMessage}`, {
        kind: "http_error",
        providerId: this.config.providerId,
        status: response.status,
      });
    }

    return responseFromAnthropicBody(body, request.id, this.config.providerId);
  }

  private headers(): Record<string, string> {
    const apiKey = this.config.apiKey ?? "";
    const authMethod = this.config.authMethod ?? "x-api-key";
    return {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(authMethod === "bearer" ? { "Authorization": `Bearer ${apiKey}` } : { "x-api-key": apiKey }),
    };
  }

  private requireApiKey(): void {
    if (this.config.apiKey) return;
    throw new ProviderError(`${this.config.apiKeyLabel ?? "provider API key"} is required before making a provider request.`, {
      kind: "missing_credentials",
      providerId: this.config.providerId,
    });
  }
}

export function toAnthropicMessagesBody(request: VesicleRequest): Record<string, unknown> {
  const hasTools = Boolean(request.tools && request.tools.length > 0);
  const maxTokens = request.generation?.maxTokens ?? defaultMaxTokens;
  return {
    model: request.model.model,
    system: request.system.join("\n\n"),
    messages: toAnthropicMessages(request.messages),
    max_tokens: maxTokens,
    temperature: request.generation?.temperature,
    thinking: anthropicThinkingControl(request.generation?.reasoningTier, maxTokens),
    tools: hasTools ? request.tools?.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    })) : undefined,
    tool_choice: hasTools ? { type: "auto" } : undefined,
  };
}

function toAnthropicMessages(messages: VesicleRequest["messages"]): AnthropicMessage[] {
  const serialized: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicContentBlock[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    serialized.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content,
      });
      continue;
    }

    flushToolResults();
    if (message.role === "assistant") {
      const content: AnthropicContentBlock[] = [
        ...anthropicThinkingBlocks(message.thinkingBlocks),
        ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
        ...(message.toolCalls ?? []).map((call) => ({
          type: "tool_use" as const,
          id: call.id,
          name: call.name,
          input: parseToolArguments(call.arguments),
        })),
      ];
      serialized.push({ role: "assistant", content: content.length > 0 ? content : [{ type: "text", text: "" }] });
      continue;
    }

    serialized.push({ role: "user", content: message.content });
  }

  flushToolResults();
  return serialized;
}

function anthropicThinkingBlocks(blocks: ProviderThinkingBlock[] | undefined): AnthropicContentBlock[] {
  const result: AnthropicContentBlock[] = [];
  for (const block of blocks ?? []) {
    if (block.type === "thinking" && typeof block.thinking === "string") {
      result.push({
        type: "thinking",
        thinking: block.thinking,
        ...(typeof block.signature === "string" ? { signature: block.signature } : {}),
      });
    }
    if (block.type === "redacted_thinking" && typeof block.data === "string") {
      result.push({ type: "redacted_thinking", data: block.data });
    }
  }
  return result;
}

function responseFromAnthropicBody(
  body: AnthropicResponse | undefined,
  fallbackId: string,
  providerId?: string,
): VesicleResponse {
  const blocks = body?.content ?? [];
  const textParts: string[] = [];
  const thinkingBlocks: ProviderThinkingBlock[] = [];
  const toolCalls: ToolCall[] = [];

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "thinking") {
      thinkingBlocks.push({
        type: "thinking",
        thinking: block.thinking,
        ...(typeof block.signature === "string" ? { signature: block.signature } : {}),
      });
      continue;
    }
    if (block.type === "redacted_thinking") {
      thinkingBlocks.push({ type: "redacted_thinking", data: block.data });
      continue;
    }
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || `tool_${index + 1}`,
        name: block.name,
        arguments: jsonString(block.input),
      });
    }
  }

  const content = textParts.join("");
  if (!content && toolCalls.length === 0) {
    throw new ProviderError("Provider response did not include assistant content or tool calls.", {
      kind: "malformed_response",
      providerId,
    });
  }

  return {
    id: body?.id ?? fallbackId,
    content,
    ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: body?.stop_reason,
    raw: body,
    usage: {
      inputTokens: body?.usage?.input_tokens,
      outputTokens: body?.usage?.output_tokens,
      totalTokens: body?.usage?.input_tokens !== undefined && body?.usage?.output_tokens !== undefined
        ? body.usage.input_tokens + body.usage.output_tokens
        : undefined,
    },
  };
}

function anthropicThinkingControl(tier: ReasoningTier | undefined, maxTokens: number): Record<string, unknown> | undefined {
  if (!tier) return undefined;
  if (tier === "off") return { type: "disabled" };
  if (maxTokens <= 1024) {
    throw new ProviderError("Anthropic thinking requires maxTokens greater than 1024.", { kind: "malformed_response" });
  }
  const budget = Math.min(thinkingBudgetForTier(tier), maxTokens - 1024);
  return { type: "enabled", budget_tokens: budget };
}

function thinkingBudgetForTier(tier: "low" | "midium" | "high" | "xhigh" | "max"): number {
  switch (tier) {
    case "low":
      return 1024;
    case "midium":
      return 2048;
    case "high":
      return 4096;
    case "xhigh":
      return 8192;
    case "max":
      return 16000;
  }
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
