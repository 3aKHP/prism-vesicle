import { afterEach, describe, expect, test } from "bun:test";
import { OpenAIChatCompatibleAdapter } from "../../../src/providers/openai-chat/adapter";
import type { ProviderStreamEvent, VesicleRequest } from "../../../src/providers/shared/types";
import { bytesFromChunks } from "../../support/providers/sse";

const originalFetch = globalThis.fetch;

describe("OpenAI-compatible streaming adapter", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("streams assistant content deltas and returns a final response", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(sse([
        { id: "chatcmpl-stream", choices: [{ delta: { content: "hel" } }] },
        { id: "chatcmpl-stream", choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
      ]));
    }) as unknown as typeof fetch;

    const events = await collect(streamAdapter().stream!(request()));

    expect((bodies[0] as { stream: boolean }).stream).toBe(true);
    expect(events).toContainEqual({ type: "content_delta", delta: "hel" });
    expect(events).toContainEqual({ type: "content_delta", delta: "lo" });
    expect(events.at(-1)).toEqual({
      type: "complete",
      response: {
        id: "chatcmpl-stream",
        content: "hello",
        finishReason: "stop",
        toolCalls: undefined,
        usage: undefined,
      },
    });
  });

  test("captures streamed usage chunks", async () => {
    globalThis.fetch = (async () => new Response(sse([
      { id: "chatcmpl-usage", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      {
        id: "chatcmpl-usage",
        choices: [],
        usage: {
          prompt_tokens: 18000,
          completion_tokens: 1400,
          total_tokens: 19400,
          prompt_tokens_details: { cached_tokens: 12000 },
          completion_tokens_details: { reasoning_tokens: 320 },
        },
      },
    ]))) as unknown as typeof fetch;

    const events = await collect(streamAdapter().stream!(request()));

    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: {
        content: "ok",
        usage: {
          contextInputTokens: 18000,
          inputTokens: 18000,
          outputTokens: 1400,
          totalTokens: 19400,
          cacheReadInputTokens: 12000,
          cacheHitInputTokens: 12000,
          reasoningTokens: 320,
          effectiveTokens: 7400,
        },
      },
    });
  });

  test("streams and reconstructs tool call argument deltas", async () => {
    globalThis.fetch = (async () => new Response(sse([
      {
        id: "chatcmpl-tools",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-write",
              type: "function",
              function: { name: "write_file", arguments: "{\"path\":\"workspace/a.md\"," },
            }],
          },
        }],
      },
      {
        id: "chatcmpl-tools",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: "\"content\":\"hi\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    ]))) as unknown as typeof fetch;

    const events = await collect(streamAdapter().stream!(request()));
    const final = events.at(-1);

    expect(events.some((event) => event.type === "tool_call_delta" && event.name === "write_file")).toBe(true);
    expect(final).toEqual({
      type: "complete",
      response: {
        id: "chatcmpl-tools",
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "call-write",
          name: "write_file",
          arguments: "{\"path\":\"workspace/a.md\",\"content\":\"hi\"}",
        }],
        usage: undefined,
      },
    });
  });

  test("rejects a stream that ends before the [DONE] marker", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response(sse([
        { id: "chatcmpl-cut", choices: [{ delta: { content: "partial" } }] },
      ], { done: false }));
    }) as unknown as typeof fetch;

    await expect(collect(streamAdapter().stream!(request()))).rejects.toThrow("Provider stream ended before [DONE].");
    expect(attempts).toBe(1);
  });

  test("reports malformed SSE payloads with a provider-stream error", async () => {
    globalThis.fetch = (async () => new Response(bytesFromChunks([
      "data: {not-json}\n\n",
      "data: [DONE]\n\n",
    ]))) as unknown as typeof fetch;

    await expect(collect(streamAdapter().stream!(request()))).rejects.toThrow("Provider stream delivered unparseable data");
  });

  test("retries streaming without stream_options when an OpenAI-compatible provider rejects them", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return Response.json({ error: { message: "unknown field: stream_options" } }, { status: 400 });
      }
      return new Response(sse([
        { id: "chatcmpl-retry", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      ]));
    }) as unknown as typeof fetch;

    const events = await collect(streamAdapter().stream!(request()));

    expect(bodies).toHaveLength(2);
    expect(bodies[0].stream_options).toEqual({ include_usage: true });
    expect(bodies[1].stream_options).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: { id: "chatcmpl-retry", content: "ok", finishReason: "stop" },
    });
  });

  test("uses the provider delta index for fallback streamed tool-call ids", async () => {
    globalThis.fetch = (async () => new Response(sse([
      {
        id: "chatcmpl-indexed",
        choices: [{
          delta: {
            tool_calls: [{
              index: 3,
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    ]))) as unknown as typeof fetch;

    const events = await collect(streamAdapter().stream!(request()));

    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: {
        toolCalls: [{ id: "call_3", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" }],
      },
    });
  });

  test("reports the selected provider api key label when credentials are missing", async () => {
    const adapter = new OpenAIChatCompatibleAdapter({
      provider: "openai-chat-compatible",
      providerId: "deepseek",
      baseUrl: "https://provider.test/v1",
      model: "test-model",
      apiKeyLabel: "DEEPSEEK_API_KEY",
    });

    await expect(adapter.complete(request())).rejects.toThrow("DEEPSEEK_API_KEY is required");
  });
});

function streamAdapter() {
  return new OpenAIChatCompatibleAdapter({
    provider: "openai-chat-compatible",
    providerId: "test",
    baseUrl: "https://provider.test/v1",
    model: "test-model",
    apiKey: "test-key",
  });
}

function request(): VesicleRequest {
  return {
    id: "session-test",
    model: { provider: "openai-chat-compatible", model: "test-model" },
    system: ["system"],
    messages: [{ role: "user", content: "hello" }],
  };
}

async function collect(events: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const result: ProviderStreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function sse(chunks: unknown[], options: { done?: boolean } = {}): ReadableStream<Uint8Array> {
  const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
  if (options.done !== false) lines.push("data: [DONE]\n\n");
  return bytesFromChunks(lines);
}
