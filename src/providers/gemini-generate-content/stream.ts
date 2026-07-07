import { ProviderError } from "../shared/errors";
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
  for (const part of candidate?.content?.parts ?? []) {
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
        argumentsDelta: jsonString(part.functionCall.args),
      });
    }
  }

  if (candidate?.finishReason) state.finishReason = candidate.finishReason;
  if (chunk.usageMetadata) state.usage = chunk.usageMetadata;
  return events;
}

async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<{ event: string; data: string }> {
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
        const event = parseSseBlock(part);
        if (event) yield event;
      }
    }

    buffer += decoder.decode();
    const trailing = parseSseBlock(buffer);
    if (trailing) yield trailing;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Preserve original stream errors if the reader lock was already released.
    }
  }
}

function parseSseBlock(block: string): { event: string; data: string } | undefined {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("event:")) event = trimmed.slice("event:".length).trimStart();
    if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice("data:".length).trimStart());
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
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

function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
