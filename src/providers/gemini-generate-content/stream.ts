import { ProviderError } from "../shared/errors";
import { readSseEvents } from "../shared/sse";
import type { ProviderStreamEvent } from "../shared/types";
import { responseFromGeminiParts } from "./response";
import type { GeminiPart, GeminiResponse } from "./types";

type GeminiStreamState = {
  parts: GeminiPart[];
  finishReason?: string;
  usage?: GeminiResponse["usageMetadata"];
  chunks: GeminiResponse[];
};

export async function* readGeminiGenerateContentStream(
  response: Response,
  fallbackId: string,
  providerId?: string,
): AsyncIterable<ProviderStreamEvent> {
  if (!response.body) {
    throw new ProviderError("Provider streaming response did not include a body.", { kind: "stream_error", providerId });
  }

  const state: GeminiStreamState = {
    parts: [],
    chunks: [],
  };

  for await (const event of readSseEvents(response.body)) {
    if (event.data === "[DONE]") break;
    const chunk = parseStreamChunk(event.data, providerId);
    if (event.event === "error" || chunk.error?.message) {
      throw new ProviderError(`Provider stream failed: ${chunk.error?.message ?? event.data}`, {
        kind: "stream_error",
        providerId,
      });
    }
    for (const emitted of absorbGeminiStreamChunk(state, chunk, providerId)) {
      yield emitted;
    }
  }

  yield {
    type: "complete",
    response: responseFromGeminiParts({
      parts: state.parts,
      finishReason: state.finishReason,
      usage: state.usage,
      fallbackId,
      raw: state.chunks,
      providerId,
    }),
  };
}

function absorbGeminiStreamChunk(
  state: GeminiStreamState,
  chunk: GeminiResponse,
  providerId?: string,
): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];
  state.chunks.push(chunk);

  const candidate = chunk.candidates?.[0];
  const chunkParts = candidate?.content?.parts ?? [];
  const newParts = hasProcessedPrefix(state.parts, chunkParts)
    ? chunkParts.slice(state.parts.length)
    : chunkParts;
  for (const part of newParts) {
    const index = state.parts.length;
    state.parts.push(part);
    if (part.text) {
      events.push({
        type: part.thought === true ? "reasoning_delta" : "content_delta",
        delta: part.text,
      });
      continue;
    }
    if (part.functionCall) {
      const name = part.functionCall.name?.trim();
      if (!name) {
        throw new ProviderError("Provider stream included a functionCall without name.", {
          kind: "malformed_response",
          providerId,
        });
      }
      events.push({
        type: "tool_call_delta",
        index,
        id: part.functionCall.id || `gemini_tool_${index + 1}`,
        name,
        // Gemini functionCall parts are atomic. Consumers still receive them
        // through argumentsDelta so the provider-neutral stream event stays
        // compatible with OpenAI/Anthropic accumulation.
        argumentsDelta: jsonString(part.functionCall.args),
      });
    }
  }

  if (candidate?.finishReason) state.finishReason = candidate.finishReason;
  if (chunk.usageMetadata) state.usage = chunk.usageMetadata;
  return events;
}

function parseStreamChunk(data: string, providerId?: string): GeminiResponse {
  try {
    return JSON.parse(data) as GeminiResponse;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`Provider stream delivered unparseable data: ${detail}`, {
      kind: "malformed_response",
      providerId,
      cause: error,
    });
  }
}

function hasProcessedPrefix(processed: GeminiPart[], incoming: GeminiPart[]): boolean {
  if (processed.length === 0) return true;
  if (incoming.length < processed.length) return false;
  for (let index = 0; index < processed.length; index++) {
    if (jsonString(incoming[index]) !== jsonString(processed[index])) return false;
  }
  return true;
}

function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
