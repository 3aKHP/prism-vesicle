import type { VesicleConfig } from "../../config/env";
import { ProviderError } from "../shared/errors";
import { readSseEvents } from "../shared/sse";
import { displayTextFromThinkingBlocks } from "../shared/thinking";
import type { ProviderAdapter, ProviderStreamEvent, ProviderThinkingBlock, ReasoningTier, VesicleRequest, VesicleResponse } from "../shared/types";
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

type AnthropicStreamEvent = {
  type?: string;
  index?: number;
  message?: {
    id?: string;
    model?: string;
    usage?: AnthropicResponse["usage"];
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
  usage?: AnthropicResponse["usage"];
  error?: {
    message?: string;
  };
};

type AnthropicStreamState = {
  id: string;
  model: string;
  textParts: string[];
  thinkingBlocks: Map<number, { thinking: string; signature?: string } | { redactedData: string }>;
  toolCalls: Map<number, { id: string; name: string; inputJson: string }>;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
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

  async *stream(request: VesicleRequest): AsyncIterable<ProviderStreamEvent> {
    this.requireApiKey();

    const response = await fetch(`${this.config.baseUrl}/messages`, {
      method: "POST",
      headers: { ...this.headers(), "Accept": "text/event-stream" },
      body: JSON.stringify({ ...toAnthropicMessagesBody(request), stream: true }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as AnthropicResponse | undefined;
      const providerMessage = body?.error?.message ?? response.statusText;
      throw new ProviderError(`Provider request failed (${response.status}): ${providerMessage}`, {
        kind: "http_error",
        providerId: this.config.providerId,
        status: response.status,
      });
    }

    yield* readAnthropicMessagesStream(response, request.id, request.model.model, this.config.providerId);
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

  const flushToolResults = (): AnthropicMessage | undefined => {
    if (pendingToolResults.length === 0) return undefined;
    const message: AnthropicMessage = { role: "user", content: pendingToolResults };
    serialized.push(message);
    pendingToolResults = [];
    return message;
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

    const flushedToolResults = flushToolResults();
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

    if (flushedToolResults && Array.isArray(flushedToolResults.content)) {
      if (message.content) flushedToolResults.content.push({ type: "text", text: message.content });
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
      if (!block.id || !block.name) {
        throw new ProviderError("Provider response included a tool_use block without id or name.", {
          kind: "malformed_response",
          providerId,
        });
      }
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: jsonString(block.input),
      });
    }
  }

  const content = textParts.join("");
  const reasoningContent = displayTextFromThinkingBlocks(thinkingBlocks);
  if (!content && toolCalls.length === 0) {
    throw new ProviderError("Provider response did not include assistant content or tool calls.", {
      kind: "malformed_response",
      providerId,
    });
  }

  return {
    id: body?.id ?? fallbackId,
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
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

async function* readAnthropicMessagesStream(
  response: Response,
  fallbackId: string,
  fallbackModel: string,
  providerId?: string,
): AsyncIterable<ProviderStreamEvent> {
  if (!response.body) {
    throw new ProviderError("Provider streaming response did not include a body.", { kind: "stream_error", providerId });
  }

  const state: AnthropicStreamState = {
    id: fallbackId,
    model: fallbackModel,
    textParts: [],
    thinkingBlocks: new Map(),
    toolCalls: new Map(),
  };
  let sawStop = false;

  for await (const event of readSseEvents(response.body)) {
    const data = parseStreamEvent(event.data, providerId);
    if (event.event === "error" || data.error?.message) {
      throw new ProviderError(`Provider stream failed: ${data.error?.message ?? event.data}`, {
        kind: "stream_error",
        providerId,
      });
    }
    for (const emitted of absorbAnthropicStreamEvent(state, event.event, data, providerId)) {
      yield emitted;
    }
    if (event.event === "message_stop") sawStop = true;
  }

  if (!sawStop) {
    throw new ProviderError("Provider stream ended before message_stop.", { kind: "stream_error", providerId });
  }

  yield { type: "complete", response: finalizeAnthropicStream(state, providerId) };
}

function absorbAnthropicStreamEvent(
  state: AnthropicStreamState,
  eventName: string,
  data: AnthropicStreamEvent,
  providerId?: string,
): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];

  if (eventName === "message_start") {
    if (data.message?.id) state.id = data.message.id;
    if (data.message?.model) state.model = data.message.model;
    if (data.message?.usage?.input_tokens !== undefined) state.inputTokens = data.message.usage.input_tokens;
    return events;
  }

  if (eventName === "content_block_start") {
    const index = data.index ?? 0;
    const block = data.content_block;
    if (!block) return events;
    if (block.type === "tool_use") {
      if (!block.id || !block.name) {
        throw new ProviderError("Provider stream included a tool_use block without id or name.", {
          kind: "malformed_response",
          providerId,
        });
      }
      state.toolCalls.set(index, { id: block.id, name: block.name, inputJson: "" });
      events.push({ type: "tool_call_delta", index, id: block.id, name: block.name });
      return events;
    }
    if (block.type === "thinking") {
      state.thinkingBlocks.set(index, { thinking: block.thinking ?? "", ...(block.signature ? { signature: block.signature } : {}) });
      return events;
    }
    if (block.type === "redacted_thinking") {
      state.thinkingBlocks.set(index, { redactedData: block.data });
    }
    return events;
  }

  if (eventName === "content_block_delta") {
    const index = data.index ?? 0;
    const delta = data.delta;
    if (!delta) return events;
    if (delta.type === "text_delta" && delta.text) {
      state.textParts.push(delta.text);
      events.push({ type: "content_delta", delta: delta.text });
      return events;
    }
    if (delta.type === "input_json_delta" && delta.partial_json) {
      const current = state.toolCalls.get(index);
      if (current) {
        current.inputJson += delta.partial_json;
        events.push({ type: "tool_call_delta", index, argumentsDelta: delta.partial_json });
      }
      return events;
    }
    if (delta.type === "thinking_delta" && delta.thinking) {
      const current = state.thinkingBlocks.get(index);
      if (current && !("thinking" in current)) return events;
      const next = current && "thinking" in current
        ? { ...current, thinking: `${current.thinking}${delta.thinking}` }
        : { thinking: delta.thinking };
      state.thinkingBlocks.set(index, next);
      events.push({ type: "reasoning_delta", delta: delta.thinking });
      return events;
    }
    if (delta.type === "signature_delta" && delta.signature) {
      const current = state.thinkingBlocks.get(index);
      if (current && "thinking" in current) {
        state.thinkingBlocks.set(index, { ...current, signature: delta.signature });
      }
    }
    return events;
  }

  if (eventName === "message_delta") {
    if (data.delta?.stop_reason) state.finishReason = data.delta.stop_reason;
    if (data.usage?.output_tokens !== undefined) state.outputTokens = data.usage.output_tokens;
  }

  return events;
}

function finalizeAnthropicStream(state: AnthropicStreamState, providerId?: string): VesicleResponse {
  const content = state.textParts.join("");
  const thinkingBlocks: ProviderThinkingBlock[] = [...state.thinkingBlocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => (
      "thinking" in block
        ? { type: "thinking", thinking: block.thinking, ...(block.signature ? { signature: block.signature } : {}) }
        : { type: "redacted_thinking", data: block.redactedData }
    ));
  const toolCalls: ToolCall[] = [...state.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id,
      name: call.name,
      arguments: call.inputJson || "{}",
    }));
  const reasoningContent = displayTextFromThinkingBlocks(thinkingBlocks);

  if (!content && toolCalls.length === 0) {
    throw new ProviderError("Provider response did not include assistant content or tool calls.", {
      kind: "malformed_response",
      providerId,
    });
  }

  return {
    id: state.id,
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: state.finishReason,
    usage: {
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      totalTokens: state.inputTokens !== undefined && state.outputTokens !== undefined
        ? state.inputTokens + state.outputTokens
        : undefined,
    },
  };
}

function parseStreamEvent(data: string, providerId?: string): AnthropicStreamEvent {
  try {
    return JSON.parse(data) as AnthropicStreamEvent;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`Provider stream delivered unparseable data: ${detail}`, {
      kind: "malformed_response",
      providerId,
      cause: error,
    });
  }
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
    // Keep the existing shared `midium` spelling until ReasoningTier is migrated.
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
    throw new ProviderError("Cannot serialize malformed tool-call arguments for Anthropic Messages.", {
      kind: "malformed_response",
    });
  }
}

function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
