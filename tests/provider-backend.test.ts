import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenAIChatCompatibleAdapter } from "../src/providers/openai-chat/adapter";
import { toChatCompletionBody } from "../src/providers/openai-chat/request";
import { readChatCompletionStream, readSseData } from "../src/providers/openai-chat/stream";
import type { VesicleRequest } from "../src/providers/shared/types";

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

    await expect(collect(readSseResponse(response))).rejects.toMatchObject({
      name: "ProviderError",
      kind: "malformed_response",
    });
  });
});

describe("SSE parsing", () => {
  test("reads CRLF, comments, multiline data, and chunk boundaries", async () => {
    const body = chunkedSse([
      ": keepalive\r\n",
      "data: {\"a\":\r\n",
      "data: 1}\r\n\r\n",
      "data: [DONE]\r\n\r\n",
    ]);

    await expect(collect(readSseData(body))).resolves.toEqual(["{\"a\":\n1}", "[DONE]"]);
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
      const source = await readFile(join(process.cwd(), file), "utf8");
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

async function* readSseResponse(response: Response) {
  yield* readChatCompletionStream(response, "fallback");
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
