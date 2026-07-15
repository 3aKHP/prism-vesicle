import { ProviderError } from "../shared/errors";
import { readSseEvents } from "../shared/sse";
import { displayTextFromThinkingBlocks } from "../shared/thinking";
import type { ProviderStreamEvent, ProviderThinkingBlock, VesicleResponse } from "../shared/types";
import type { AnthropicStreamEvent, AnthropicStreamState, AnthropicUsage } from "./types";
import { usageFromAnthropicUsage } from "./usage";

export async function* readAnthropicMessagesStream(
  response: Response,
  fallbackId: string,
  fallbackModel: string,
  providerId?: string,
): AsyncIterable<ProviderStreamEvent> {
  if (!response.body) {
    throw new ProviderError("Provider streaming response did not include a body.", { kind: "stream_error", providerId });
  }

  const state = createAnthropicStreamState(fallbackId, fallbackModel);
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

function createAnthropicStreamState(fallbackId: string, fallbackModel: string): AnthropicStreamState {
  return {
    id: fallbackId,
    model: fallbackModel,
    textParts: [],
    thinkingBlocks: new Map(),
    toolCalls: new Map(),
    usage: {},
  };
}

function absorbAnthropicStreamEvent(
  state: AnthropicStreamState,
  eventName: string,
  data: AnthropicStreamEvent,
  providerId?: string,
): ProviderStreamEvent[] {
  switch (eventName) {
    case "message_start":
      absorbMessageStart(state, data);
      return [];
    case "content_block_start":
      return absorbContentBlockStart(state, data, providerId);
    case "content_block_delta":
      return absorbContentBlockDelta(state, data);
    case "message_delta":
      absorbMessageDelta(state, data);
      return [];
    default:
      return [];
  }
}

function absorbMessageStart(state: AnthropicStreamState, data: AnthropicStreamEvent): void {
  if (data.message?.id) state.id = data.message.id;
  if (data.message?.model) state.model = data.message.model;
  applyInputUsage(state.usage, data.message?.usage);
}

function absorbContentBlockStart(
  state: AnthropicStreamState,
  data: AnthropicStreamEvent,
  providerId?: string,
): ProviderStreamEvent[] {
  const index = data.index ?? 0;
  const block = data.content_block;
  if (!block) return [];
  if (block.type === "tool_use") {
    if (!block.id || !block.name) {
      throw new ProviderError("Provider stream included a tool_use block without id or name.", {
        kind: "malformed_response",
        providerId,
      });
    }
    state.toolCalls.set(index, { id: block.id, name: block.name, inputJson: "" });
    return [{ type: "tool_call_delta", index, id: block.id, name: block.name }];
  }
  if (block.type === "thinking") {
    state.thinkingBlocks.set(index, {
      thinking: block.thinking ?? "",
      ...(block.signature ? { signature: block.signature } : {}),
    });
  } else if (block.type === "redacted_thinking") {
    state.thinkingBlocks.set(index, { redactedData: block.data });
  }
  return [];
}

function absorbContentBlockDelta(
  state: AnthropicStreamState,
  data: AnthropicStreamEvent,
): ProviderStreamEvent[] {
  const index = data.index ?? 0;
  const delta = data.delta;
  if (!delta) return [];
  if (delta.type === "text_delta" && delta.text) return absorbTextDelta(state, delta.text);
  if (delta.type === "input_json_delta" && delta.partial_json) {
    return absorbToolArgumentsDelta(state, index, delta.partial_json);
  }
  if (delta.type === "thinking_delta" && delta.thinking) {
    return absorbThinkingDelta(state, index, delta.thinking);
  }
  if (delta.type === "signature_delta" && delta.signature) {
    absorbSignatureDelta(state, index, delta.signature);
  }
  return [];
}

function absorbTextDelta(state: AnthropicStreamState, delta: string): ProviderStreamEvent[] {
  state.textParts.push(delta);
  return [{ type: "content_delta", delta }];
}

function absorbToolArgumentsDelta(
  state: AnthropicStreamState,
  index: number,
  delta: string,
): ProviderStreamEvent[] {
  const current = state.toolCalls.get(index);
  if (!current) return [];
  current.inputJson += delta;
  return [{ type: "tool_call_delta", index, argumentsDelta: delta }];
}

function absorbThinkingDelta(
  state: AnthropicStreamState,
  index: number,
  delta: string,
): ProviderStreamEvent[] {
  const current = state.thinkingBlocks.get(index);
  if (current && !("thinking" in current)) return [];
  const next = current && "thinking" in current
    ? { ...current, thinking: `${current.thinking}${delta}` }
    : { thinking: delta };
  state.thinkingBlocks.set(index, next);
  return [{ type: "reasoning_delta", delta }];
}

function absorbSignatureDelta(state: AnthropicStreamState, index: number, signature: string): void {
  const current = state.thinkingBlocks.get(index);
  if (current && "thinking" in current) {
    state.thinkingBlocks.set(index, { ...current, signature });
  }
}

function absorbMessageDelta(state: AnthropicStreamState, data: AnthropicStreamEvent): void {
  if (data.delta?.stop_reason) state.finishReason = data.delta.stop_reason;
  applyUsage(state.usage, data.usage);
}

function applyUsage(target: AnthropicUsage, source: AnthropicUsage | undefined): void {
  if (!source) return;
  applyInputUsage(target, source);
  if (source.output_tokens !== undefined) target.output_tokens = source.output_tokens;
}

function applyInputUsage(target: AnthropicUsage, source: AnthropicUsage | undefined): void {
  if (!source) return;
  if (source.input_tokens !== undefined) target.input_tokens = source.input_tokens;
  if (source.cache_creation_input_tokens !== undefined) {
    target.cache_creation_input_tokens = source.cache_creation_input_tokens;
  }
  if (source.cache_read_input_tokens !== undefined) target.cache_read_input_tokens = source.cache_read_input_tokens;
}

function finalizeAnthropicStream(state: AnthropicStreamState, providerId?: string): VesicleResponse {
  const content = state.textParts.join("");
  const thinkingBlocks = orderedThinkingBlocks(state);
  const toolCalls = orderedToolCalls(state);
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
    usage: usageFromAnthropicUsage(state.usage),
  };
}

function orderedThinkingBlocks(state: AnthropicStreamState): ProviderThinkingBlock[] {
  return [...state.thinkingBlocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => (
      "thinking" in block
        ? { type: "thinking", thinking: block.thinking, ...(block.signature ? { signature: block.signature } : {}) }
        : { type: "redacted_thinking", data: block.redactedData }
    ));
}

function orderedToolCalls(state: AnthropicStreamState): NonNullable<VesicleResponse["toolCalls"]> {
  return [...state.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id,
      name: call.name,
      arguments: call.inputJson || "{}",
    }));
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
