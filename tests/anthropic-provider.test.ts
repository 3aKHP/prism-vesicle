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
});

function request(): VesicleRequest {
  return {
    id: "session-test",
    model: { provider: "anthropic", model: "claude-test" },
    system: ["system"],
    messages: [{ role: "user", content: "hello" }],
  };
}
