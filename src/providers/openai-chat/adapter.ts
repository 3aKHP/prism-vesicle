import type { VesicleConfig } from "../../config/env";
import type { ProviderAdapter, ProviderStreamEvent, VesicleRequest, VesicleResponse } from "../shared/types";

type ChatCompletionChoice = {
  finish_reason?: string | null;
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
};

type ChatCompletionResponse = {
  id?: string;
  choices?: ChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

type ChatCompletionStreamChunk = {
  id?: string;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

export class OpenAIChatCompatibleAdapter implements ProviderAdapter {
  readonly id = "openai-chat-compatible";

  constructor(private readonly config: VesicleConfig) {}

  async complete(request: VesicleRequest): Promise<VesicleResponse> {
    if (!this.config.apiKey) {
      throw new Error("VESICLE_API_KEY is required before making a provider request.");
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(toChatCompletionBody(request, false)),
    });

    const body = await response.json().catch(() => undefined) as ChatCompletionResponse | undefined;
    if (!response.ok) {
      const providerMessage = body?.error?.message ?? response.statusText;
      throw new Error(`Provider request failed (${response.status}): ${providerMessage}`);
    }

    return responseFromChatCompletionBody(body, request.id);
  }

  async *stream(request: VesicleRequest): AsyncIterable<ProviderStreamEvent> {
    if (!this.config.apiKey) {
      throw new Error("VESICLE_API_KEY is required before making a provider request.");
    }

    const response = await this.fetchChatCompletion(request, true, true);
    const retryWithoutStreamOptions = !response.ok && isRetryableStreamRequestFailure(response.status);
    const streamResponse = retryWithoutStreamOptions
      ? await this.fetchChatCompletion(request, true, false)
      : response;

    if (!streamResponse.ok && isRetryableStreamRequestFailure(streamResponse.status)) {
      yield { type: "complete", response: await this.complete(request) };
      return;
    }

    if (!streamResponse.ok) {
      const providerMessage = await readProviderErrorMessage(streamResponse);
      throw new Error(`Provider request failed (${streamResponse.status}): ${providerMessage}`);
    }
    if (!streamResponse.body) {
      throw new Error("Provider streaming response did not include a body.");
    }
    if (streamResponse.headers.get("content-type")?.includes("application/json")) {
      const body = await streamResponse.json().catch(() => undefined) as ChatCompletionResponse | undefined;
      yield { type: "complete", response: responseFromChatCompletionBody(body, request.id) };
      return;
    }

    const state = createStreamAccumulator(request.id);
    let sawDone = false;
    for await (const payload of readSseData(streamResponse.body)) {
      if (payload === "[DONE]") {
        sawDone = true;
        break;
      }
      const chunk = parseStreamChunk(payload);
      if (chunk.error?.message) {
        throw new Error(`Provider stream failed: ${chunk.error.message}`);
      }
      for (const event of absorbStreamChunk(state, chunk)) {
        yield event;
      }
    }
    if (!sawDone) {
      throw new Error("Provider stream ended before [DONE].");
    }

    const final = finalizeStream(state);
    yield { type: "complete", response: final };
  }

  private fetchChatCompletion(request: VesicleRequest, stream: boolean, includeUsage: boolean): Promise<Response> {
    return fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(toChatCompletionBody(request, stream, includeUsage)),
    });
  }
}

function responseFromChatCompletionBody(body: ChatCompletionResponse | undefined, fallbackId: string): VesicleResponse {
  const choice = body?.choices?.[0];
  const content = choice?.message?.content ?? "";
  const toolCalls = choice?.message?.tool_calls?.map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
  }));

  if (!content && (!toolCalls || toolCalls.length === 0)) {
    throw new Error("Provider response did not include assistant content or tool calls.");
  }

  return {
    id: body?.id ?? fallbackId,
    content,
    toolCalls,
    finishReason: choice?.finish_reason ?? undefined,
    raw: body,
    usage: {
      inputTokens: body?.usage?.prompt_tokens,
      outputTokens: body?.usage?.completion_tokens,
      totalTokens: body?.usage?.total_tokens,
    },
  };
}

async function readProviderErrorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => undefined) as ChatCompletionResponse | undefined;
  return body?.error?.message ?? response.statusText;
}

function isRetryableStreamRequestFailure(status: number): boolean {
  return status === 400 || status === 404 || status === 422;
}

function toChatCompletionBody(request: VesicleRequest, stream: boolean, includeUsage = false): Record<string, unknown> {
  return {
    model: request.model.model,
    messages: [
      ...request.system.map((content) => ({ role: "system", content })),
      ...request.messages.map((message) => {
        if (message.role === "tool") {
          return {
            role: "tool",
            tool_call_id: message.toolCallId,
            content: message.content,
          };
        }

        if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
          return {
            role: "assistant",
            content: message.content || null,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: call.arguments,
              },
            })),
          };
        }

        return {
          role: message.role,
          content: message.content,
        };
      }),
    ],
    tools: request.tools && request.tools.length > 0 ? request.tools : undefined,
    tool_choice: request.tools && request.tools.length > 0 ? "auto" : undefined,
    temperature: request.generation?.temperature ?? 0.7,
    max_tokens: request.generation?.maxTokens,
    stream,
    stream_options: stream && includeUsage ? { include_usage: true } : undefined,
  };
}

type StreamAccumulator = {
  id: string;
  content: string;
  finishReason?: string;
  toolCalls: Map<number, { index: number; id?: string; name?: string; arguments: string }>;
  usage?: VesicleResponse["usage"];
};

function createStreamAccumulator(fallbackId: string): StreamAccumulator {
  return {
    id: fallbackId,
    content: "",
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

  for (const delta of choice.delta?.tool_calls ?? []) {
    const current = state.toolCalls.get(delta.index) ?? { index: delta.index, arguments: "" };
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) current.name = `${current.name ?? ""}${delta.function.name}`;
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

function finalizeStream(state: StreamAccumulator): VesicleResponse {
  const toolCalls = [...state.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id ?? `call_${call.index}`,
      name: call.name ?? "",
      arguments: call.arguments,
    }))
    .filter((call) => call.name);

  if (!state.content && toolCalls.length === 0) {
    throw new Error("Provider response did not include assistant content or tool calls.");
  }

  return {
    id: state.id,
    content: state.content,
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
    reader.releaseLock();
  }
}

function parseStreamChunk(payload: string): ChatCompletionStreamChunk {
  try {
    return JSON.parse(payload) as ChatCompletionStreamChunk;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Provider stream delivered unparseable data: ${detail}`);
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
