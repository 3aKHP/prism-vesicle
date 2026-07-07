import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAIChatCompatibleAdapter } from "../src/providers/openai-chat/adapter";
import { toChatCompletionBody } from "../src/providers/openai-chat/request";
import { readChatCompletionStream } from "../src/providers/openai-chat/stream";
import type { VesicleRequest } from "../src/providers/shared/types";

const originalFetch = globalThis.fetch;
const testDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(testDir, "..");

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAI-compatible request shaping", () => {
  test("omits tool fields when no tools are available", () => {
    const body = JSON.parse(JSON.stringify(toChatCompletionBody(request(), false))) as Record<string, unknown>;

    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  test("serializes assistant tool calls and tool results for Chat Completions", () => {
    const body = toChatCompletionBody({
      ...request(),
      messages: [
        {
          role: "assistant",
          content: "",
          reasoningContent: "Need to read the file first.",
          toolCalls: [{ id: "call-read", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" }],
        },
        { role: "tool", toolCallId: "call-read", content: "{\"ok\":true}" },
      ],
    }, true, true);

    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "Need to read the file first.",
        tool_calls: [{
          id: "call-read",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call-read", content: "{\"ok\":true}" },
    ]);
  });
});

describe("Provider backend errors", () => {
  test("uses a structured missing-credentials error", async () => {
    const adapter = new OpenAIChatCompatibleAdapter({
      provider: "openai-chat-compatible",
      providerId: "deepseek",
      baseUrl: "https://provider.test/v1",
      model: "test-model",
      apiKeyLabel: "DEEPSEEK_API_KEY",
    });

    await expect(adapter.complete(request())).rejects.toMatchObject({
      name: "ProviderError",
      kind: "missing_credentials",
      providerId: "deepseek",
    });
  });

  test("uses a structured malformed-response error for bad SSE JSON", async () => {
    const response = new Response(rawSse(["data: {not-json}\n\n", "data: [DONE]\n\n"]));

    await expect(collect(readSseResponse(response, "deepseek"))).rejects.toMatchObject({
      name: "ProviderError",
      kind: "malformed_response",
      providerId: "deepseek",
    });
  });
});

describe("OpenAI-compatible response parsing", () => {
  test("preserves non-stream reasoning_content", async () => {
    globalThis.fetch = (async () => Response.json({
      id: "chatcmpl-reasoning",
      choices: [{
        finish_reason: "stop",
        message: {
          reasoning_content: "Think before answering.",
          content: "final answer",
        },
      }],
    })) as unknown as typeof fetch;

    const adapter = new OpenAIChatCompatibleAdapter({
      provider: "openai-chat-compatible",
      providerId: "deepseek",
      baseUrl: "https://provider.test/v1",
      model: "test-model",
      apiKey: "test-key",
    });

    await expect(adapter.complete(request())).resolves.toMatchObject({
      id: "chatcmpl-reasoning",
      content: "final answer",
      reasoningContent: "Think before answering.",
    });
  });
});

describe("SSE parsing", () => {
  test("reads CRLF, comments, multiline data, and chunk boundaries", async () => {
    const body = chunkedSse([
      ": keepalive\r\n",
      "data: {\"id\":\"chatcmpl-crlf\",\"choices\":[{\"delta\":{\"content\":\r\n",
      "data: \"ok\"},\"finish_reason\":\"stop\"}]}\r\n\r\n",
      "data: [DONE]\r\n\r\n",
    ]);

    const events = await collect(readChatCompletionStream(new Response(body), "fallback", "deepseek"));

    expect(events).toContainEqual({ type: "content_delta", delta: "ok" });
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: { id: "chatcmpl-crlf", content: "ok" },
    });
  });
});

describe("Chat Completions stream integration", () => {
  test("emits content deltas and a final complete event", async () => {
    const response = new Response(rawSse([
      "data: {\"id\":\"chatcmpl-stream\",\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n",
      "data: {\"id\":\"chatcmpl-stream\",\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}\n\n",
      "data: {\"id\":\"chatcmpl-stream\",\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n",
      "data: [DONE]\n\n",
    ]));

    const events = await collect(readChatCompletionStream(response, "fallback"));

    expect(events).toContainEqual({ type: "content_delta", delta: "hel" });
    expect(events).toContainEqual({ type: "reasoning_delta", delta: "think" });
    expect(events).toContainEqual({ type: "content_delta", delta: "lo" });
    expect(events.at(-1)).toEqual({
      type: "complete",
      response: {
        id: "chatcmpl-stream",
        content: "hello",
        reasoningContent: "think",
        finishReason: "stop",
        toolCalls: undefined,
        usage: undefined,
      },
    });
  });

  test("accumulates streamed tool call deltas into the final response", async () => {
    const response = new Response(rawSse([
      "data: {\"id\":\"chatcmpl-tools\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-read\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n",
      "data: {\"id\":\"chatcmpl-tools\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"read_file\",\"arguments\":\"\\\"workspace/a.md\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]\n\n",
    ]));

    const events = await collect(readChatCompletionStream(response, "fallback"));

    expect(events.filter((event) => event.type === "tool_call_delta")).toHaveLength(2);
    expect(events.at(-1)).toEqual({
      type: "complete",
      response: {
        id: "chatcmpl-tools",
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "call-read",
          name: "read_file",
          arguments: "{\"path\":\"workspace/a.md\"}",
        }],
        usage: undefined,
      },
    });
  });

  test("uses the latest streamed tool call function name instead of concatenating", async () => {
    const response = new Response(rawSse([
      "data: {\"id\":\"chatcmpl-tools\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-read\",\"type\":\"function\",\"function\":{\"name\":\"stale_name\",\"arguments\":\"{}\"}}]}}]}\n\n",
      "data: {\"id\":\"chatcmpl-tools\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"read_file\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]\n\n",
    ]));

    const events = await collect(readChatCompletionStream(response, "fallback", "deepseek"));

    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: {
        toolCalls: [{
          id: "call-read",
          name: "read_file",
          arguments: "{}",
        }],
      },
    });
  });

  test("adapter stream accepts an OK JSON response fallback", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: "chatcmpl-json",
        choices: [{ finish_reason: "stop", message: { content: "json fallback" } }],
      }, { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const adapter = new OpenAIChatCompatibleAdapter({
      provider: "openai-chat-compatible",
      providerId: "test",
      baseUrl: "https://provider.test/v1",
      model: "test-model",
      apiKey: "test-key",
    });

    const events = await collect(adapter.stream!(request()));

    expect((bodies[0] as { stream: boolean }).stream).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: { id: "chatcmpl-json", content: "json fallback", finishReason: "stop" },
    });
  });
});

describe("Provider backend boundaries", () => {
  test("provider modules do not import filesystem, session, or TUI modules", async () => {
    const providerFiles = [
      "src/providers/openai-chat/adapter.ts",
      "src/providers/openai-chat/request.ts",
      "src/providers/openai-chat/response.ts",
      "src/providers/openai-chat/stream.ts",
      "src/providers/openai-chat/types.ts",
    ];

    for (const file of providerFiles) {
      const source = await readFile(join(repoRoot, file), "utf8");
      expect(source).not.toMatch(/from\s+["']node:fs/);
      expect(source).not.toMatch(/from\s+["'][^"']*core\/session/);
      expect(source).not.toMatch(/from\s+["'][^"']*tui/);
    }
  });
});

function request(): VesicleRequest {
  return {
    id: "session-test",
    model: { provider: "openai-chat-compatible", model: "test-model" },
    system: ["system"],
    messages: [{ role: "user", content: "hello" }],
  };
}

async function* readSseResponse(response: Response, providerId?: string) {
  yield* readChatCompletionStream(response, "fallback", providerId);
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function chunkedSse(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function rawSse(lines: string[]): ReadableStream<Uint8Array> {
  return chunkedSse(lines);
}
