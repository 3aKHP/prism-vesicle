import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicMessagesAdapter, toAnthropicMessagesBody } from "../src/providers/anthropic-messages/adapter";
import type { VesicleRequest } from "../src/providers/shared/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Anthropic Messages request shaping", () => {
  test("serializes messages, thinking blocks, tools, and tool results", () => {
    const body = toAnthropicMessagesBody({
      ...request(),
      generation: { temperature: 0.3, maxTokens: 4096, reasoningTier: "low" },
      messages: [
        { role: "user", content: "read a file" },
        {
          role: "assistant",
          content: "I will inspect it.",
          thinkingBlocks: [{ type: "thinking", thinking: "Need the file.", signature: "sig" }],
          toolCalls: [{ id: "toolu_1", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" }],
        },
        { role: "tool", toolCallId: "toolu_1", content: "{\"ok\":true}" },
      ],
      tools: [{
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      }],
    });

    expect(body).toMatchObject({
      model: "claude-test",
      system: "system",
      max_tokens: 4096,
      temperature: 0.3,
      thinking: { type: "enabled", budget_tokens: 1024 },
      tool_choice: { type: "auto" },
    });
    expect(body.messages).toEqual([
      { role: "user", content: "read a file" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need the file.", signature: "sig" },
          { type: "text", text: "I will inspect it." },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "workspace/a.md" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{\"ok\":true}" }],
      },
    ]);
    expect(body.tools).toEqual([{
      name: "read_file",
      description: "Read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    }]);
  });

  test("merges user follow-up text into the tool_result user message", () => {
    const body = toAnthropicMessagesBody({
      ...request(),
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "toolu_gate", name: "request_confirmation", arguments: "{\"gate\":\"phase\"}" }],
        },
        { role: "tool", toolCallId: "toolu_gate", content: "{\"ok\":true}" },
        { role: "user", content: "[gate:phase resolved as confirm]" },
      ],
    });

    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_gate", name: "request_confirmation", input: { gate: "phase" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_gate", content: "{\"ok\":true}" },
          { type: "text", text: "[gate:phase resolved as confirm]" },
        ],
      },
    ]);
  });
});

describe("Anthropic Messages adapter", () => {
  test("parses text, thinking blocks, tool use, and usage", async () => {
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      expect(init?.headers).toMatchObject({
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
      });
      return Response.json({
        id: "msg_123",
        model: "claude-test",
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "Think first.", signature: "sig" },
          { type: "text", text: "I need a file." },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "workspace/a.md" } },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      });
    }) as unknown as typeof fetch;

    const adapter = new AnthropicMessagesAdapter({
      provider: "anthropic-messages",
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-test",
      apiKey: "test-key",
      apiKeyLabel: "ANTHROPIC_API_KEY",
    });

    await expect(adapter.complete(request())).resolves.toMatchObject({
      id: "msg_123",
      content: "I need a file.",
      reasoningContent: "Think first.",
      thinkingBlocks: [{ type: "thinking", thinking: "Think first.", signature: "sig" }],
      toolCalls: [{ id: "toolu_1", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" }],
      finishReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
  });

  test("rejects malformed tool_use blocks clearly", async () => {
    globalThis.fetch = (async () => Response.json({
      id: "msg_bad_tool",
      content: [{ type: "tool_use", id: "toolu_1", input: {} }],
    })) as unknown as typeof fetch;

    const adapter = new AnthropicMessagesAdapter({
      provider: "anthropic-messages",
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-test",
      apiKey: "test-key",
    });

    await expect(adapter.complete(request())).rejects.toMatchObject({
      name: "ProviderError",
      kind: "malformed_response",
      providerId: "anthropic",
    });
  });

  test("supports bearer auth for Anthropic-compatible relays", async () => {
    globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
      expect(init.headers).toMatchObject({ "Authorization": "Bearer test-key" });
      return Response.json({
        id: "msg_bearer",
        content: [{ type: "text", text: "ok" }],
      });
    }) as unknown as typeof fetch;

    const adapter = new AnthropicMessagesAdapter({
      provider: "anthropic-messages",
      providerId: "relay",
      baseUrl: "https://relay.test/v1",
      model: "claude-test",
      apiKey: "test-key",
      apiKeyLabel: "RELAY_API_KEY",
      authMethod: "bearer",
    });

    await expect(adapter.complete(request())).resolves.toMatchObject({ content: "ok" });
  });

  test("uses a structured missing-credentials error", async () => {
    const adapter = new AnthropicMessagesAdapter({
      provider: "anthropic-messages",
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-test",
      apiKeyLabel: "ANTHROPIC_API_KEY",
    });

    await expect(adapter.complete(request())).rejects.toMatchObject({
      name: "ProviderError",
      kind: "missing_credentials",
      providerId: "anthropic",
    });
  });

  test("streams text, thinking, tool deltas, and a final response", async () => {
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ stream: true });
      return new Response(rawSse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream","model":"claude-test","usage":{"input_tokens":11}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello"}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"workspace/a.md\\"}"}}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":22}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ]), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const adapter = new AnthropicMessagesAdapter({
      provider: "anthropic-messages",
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-test",
      apiKey: "test-key",
    });

    const events = await collect(adapter.stream!(request()));

    expect(events).toContainEqual({ type: "reasoning_delta", delta: "think" });
    expect(events).toContainEqual({ type: "content_delta", delta: "hello" });
    expect(events).toContainEqual({ type: "tool_call_delta", index: 2, id: "toolu_1", name: "read_file" });
    expect(events).toContainEqual({ type: "tool_call_delta", index: 2, argumentsDelta: "{\"path\":" });
    expect(events.at(-1)).toEqual({
      type: "complete",
      response: {
        id: "msg_stream",
        content: "hello",
        reasoningContent: "think",
        thinkingBlocks: [{ type: "thinking", thinking: "think", signature: "sig" }],
        toolCalls: [{ id: "toolu_1", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" }],
        finishReason: "tool_use",
        usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
      },
    });
  });

  test("rejects streams that end before message_stop", async () => {
    globalThis.fetch = (async () => new Response(rawSse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream"}}',
    ]))) as unknown as typeof fetch;

    const adapter = new AnthropicMessagesAdapter({
      provider: "anthropic-messages",
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-test",
      apiKey: "test-key",
    });

    await expect(collect(adapter.stream!(request()))).rejects.toMatchObject({
      name: "ProviderError",
      kind: "stream_error",
      providerId: "anthropic",
    });
  });

  test("streams redacted thinking blocks into the final response", async () => {
    globalThis.fetch = (async () => new Response(rawSse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_redacted","model":"claude-test"}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque"}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"done"}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]))) as unknown as typeof fetch;

    const adapter = new AnthropicMessagesAdapter({
      provider: "anthropic-messages",
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-test",
      apiKey: "test-key",
    });

    const events = await collect(adapter.stream!(request()));

    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: {
        content: "done",
        reasoningContent: "[redacted thinking]",
        thinkingBlocks: [{ type: "redacted_thinking", data: "opaque" }],
      },
    });
  });
});

function request(): VesicleRequest {
  return {
    id: "session-test",
    model: { provider: "anthropic", model: "claude-test" },
    system: ["system"],
    messages: [{ role: "user", content: "hello" }],
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function rawSse(blocks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(`${block}\n\n`));
      controller.close();
    },
  });
}
