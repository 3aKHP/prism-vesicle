import { ProviderError } from "../shared/errors";
import type { ProviderStreamEvent, VesicleResponse } from "../shared/types";
import type { ChatCompletionStreamChunk } from "./types";

type StreamAccumulator = {
  id: string;
  content: string;
  reasoningContent: string;
  finishReason?: string;
  toolCalls: Map<number, { index: number; id?: string; name?: string; arguments: string }>;
  usage?: VesicleResponse["usage"];
};

export function isRetryableStreamRequestFailure(status: number): boolean {
  return status === 400 || status === 404 || status === 422;
}

export async function* readChatCompletionStream(
  response: Response,
  fallbackId: string,
  providerId?: string,
): AsyncIterable<ProviderStreamEvent> {
  if (!response.body) {
    throw new ProviderError("Provider streaming response did not include a body.", { kind: "stream_error", providerId });
  }

  const state = createStreamAccumulator(fallbackId);
  let sawDone = false;
  for await (const payload of readSseData(response.body)) {
    if (payload === "[DONE]") {
      sawDone = true;
      break;
    }
    const chunk = parseStreamChunk(payload, providerId);
    if (chunk.error?.message) {
      throw new ProviderError(`Provider stream failed: ${chunk.error.message}`, { kind: "stream_error", providerId });
    }
    for (const event of absorbStreamChunk(state, chunk)) {
      yield event;
    }
  }
  if (!sawDone) {
    throw new ProviderError("Provider stream ended before [DONE].", { kind: "stream_error", providerId });
  }

  yield { type: "complete", response: finalizeStream(state, providerId) };
}

function createStreamAccumulator(fallbackId: string): StreamAccumulator {
  return {
    id: fallbackId,
    content: "",
    reasoningContent: "",
    toolCalls: new Map(),
  };
}

function absorbStreamChunk(state: StreamAccumulator, chunk: ChatCompletionStreamChunk): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];
  if (chunk.id) state.id = chunk.id;
  if (chunk.usage) {
    state.usage = {
      inputTokens: chunk.usage.prompt_tokens,
      outputTokens: chunk.usage.completion_tokens,
      totalTokens: chunk.usage.total_tokens,
    };
  }

  const choice = chunk.choices?.[0];
  if (!choice) return events;
  if (choice.finish_reason) state.finishReason = choice.finish_reason;

  const contentDelta = choice.delta?.content ?? "";
  if (contentDelta) {
    state.content += contentDelta;
    events.push({ type: "content_delta", delta: contentDelta });
  }

  const reasoningDelta = choice.delta?.reasoning_content ?? "";
  if (reasoningDelta) {
    state.reasoningContent += reasoningDelta;
    events.push({ type: "reasoning_delta", delta: reasoningDelta });
  }

  for (const delta of choice.delta?.tool_calls ?? []) {
    const current = state.toolCalls.get(delta.index) ?? { index: delta.index, arguments: "" };
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) current.name = delta.function.name;
    if (delta.function?.arguments) current.arguments += delta.function.arguments;
    state.toolCalls.set(delta.index, current);
    events.push({
      type: "tool_call_delta",
      index: delta.index,
      id: delta.id,
      name: delta.function?.name,
      argumentsDelta: delta.function?.arguments,
    });
  }

  return events;
}

function finalizeStream(state: StreamAccumulator, providerId?: string): VesicleResponse {
  const toolCalls = [...state.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id ?? `call_${call.index}`,
      name: call.name ?? "",
      arguments: call.arguments,
    }))
    .filter((call) => call.name);

  if (!state.content && toolCalls.length === 0) {
    throw new ProviderError("Provider response did not include assistant content or tool calls.", {
      kind: "malformed_response",
      providerId,
    });
  }

  return {
    id: state.id,
    content: state.content,
    ...(state.reasoningContent ? { reasoningContent: state.reasoningContent } : {}),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: state.finishReason,
    usage: state.usage,
  };
}

async function* readSseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const data = parseSseDataBlock(part);
        if (data) yield data;
      }
    }

    buffer += decoder.decode();
    const trailing = parseSseDataBlock(buffer);
    if (trailing) yield trailing;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Streams that error can auto-release the reader lock; preserve the
      // original stream failure instead of replacing it with a release error.
    }
  }
}

function parseStreamChunk(payload: string, providerId?: string): ChatCompletionStreamChunk {
  try {
    return JSON.parse(payload) as ChatCompletionStreamChunk;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`Provider stream delivered unparseable data: ${detail}`, {
      kind: "malformed_response",
      providerId,
      cause: error,
    });
  }
}

function parseSseDataBlock(block: string): string | undefined {
  const lines = block.split(/\r?\n/);
  const dataLines = lines
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (dataLines.length === 0) return undefined;
  return dataLines.join("\n");
}
