import { afterEach, describe, expect, test } from "bun:test";
import { GeminiGenerateContentAdapter, toGeminiGenerateContentBody } from "../src/providers/gemini-generate-content/adapter";
import type { VesicleRequest } from "../src/providers/shared/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Gemini generateContent request shaping", () => {
  test("serializes image attachments as inlineData parts", () => {
    const body = toGeminiGenerateContentBody({
      ...request(),
      messages: [{ role: "user", content: "inspect", images: [image()] }],
    });
    expect(body.contents).toEqual([{
      role: "user",
      parts: [
        { text: "inspect" },
        { text: "[Image #1: capture.png]" },
        { inlineData: { mimeType: "image/png", data: "cG5n" } },
      ],
    }]);
  });
  test("serializes system, messages, tools, tool results, and thinking config", () => {
    const body = toGeminiGenerateContentBody({
      ...request(),
      generation: { temperature: 0.2, maxTokens: 2048, reasoningTier: "low" },
      messages: [
        { role: "user", content: "read a file" },
        {
          role: "assistant",
          content: "I will inspect it.",
          thinkingBlocks: [
            {
              type: "gemini_part",
              part: {
                text: "Need the file.",
                thought: true,
                thoughtSignature: "thought-sig",
              },
            },
            {
              type: "gemini_part",
              part: {
                functionCall: {
                  id: "call_1",
                  name: "read_file",
                  args: { path: "workspace/a.md" },
                },
                thoughtSignature: "call-sig",
              },
            },
          ],
          toolCalls: [{ id: "call_1", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" }],
        },
        { role: "tool", toolCallId: "call_1", content: "{\"ok\":true}" },
        { role: "user", content: "[gate:phase resolved as confirm]" },
      ],
      tools: [{
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      }],
    });

    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: "system" }] },
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
      },
    });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "read a file" }] },
      {
        role: "model",
        parts: [
          { text: "Need the file.", thought: true, thoughtSignature: "thought-sig" },
          {
            functionCall: {
              id: "call_1",
              name: "read_file",
              args: { path: "workspace/a.md" },
            },
            thoughtSignature: "call-sig",
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call_1",
              name: "read_file",
              response: { content: "{\"ok\":true}" },
            },
          },
          { text: "[gate:phase resolved as confirm]" },
        ],
      },
    ]);
    expect(body.tools).toEqual([{
      functionDeclarations: [{
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
    }]);
  });

  test("maps Gemini 3 thinking tiers to thinking levels", () => {
    const body = toGeminiGenerateContentBody({
      ...request(),
      model: { provider: "google", model: "gemini-3-pro-preview" },
      generation: { reasoningTier: "medium" },
    });

    expect(body.generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: "medium", includeThoughts: true },
    });
  });
});

describe("Gemini generateContent adapter", () => {
  test("parses text, thought parts, tool calls, signatures, and usage", async () => {
    globalThis.fetch = (async (input: unknown, init: RequestInit & { body?: unknown }) => {
      expect(String(input)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
      expect(init.headers).toMatchObject({ "x-goog-api-key": "test-key" });
      return Response.json({
        candidates: [{
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [
              { text: "Think first.", thought: true, thoughtSignature: "thought-sig" },
              { text: "I need a file." },
              {
                functionCall: {
                  id: "call_1",
                  name: "read_file",
                  args: { path: "workspace/a.md" },
                },
                thoughtSignature: "call-sig",
              },
            ],
          },
        }],
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 200,
          totalTokenCount: 1200,
          cachedContentTokenCount: 400,
          thoughtsTokenCount: 80,
          toolUsePromptTokenCount: 25,
          promptTokensDetails: [{ modality: "TEXT", tokenCount: 900 }],
          cacheTokensDetails: [{ modality: "TEXT", tokenCount: 400 }],
        },
      });
    }) as unknown as typeof fetch;

    const adapter = new GeminiGenerateContentAdapter({
      provider: "gemini-generate-content",
      providerId: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-test",
      apiKey: "test-key",
      apiKeyLabel: "GEMINI_API_KEY",
    });

    await expect(adapter.complete(request())).resolves.toMatchObject({
      id: "session-test",
      content: "I need a file.",
      reasoningContent: "Think first.",
      thinkingBlocks: [
        { type: "gemini_part", part: { text: "Think first.", thought: true, thoughtSignature: "thought-sig" } },
        { type: "gemini_part", part: { text: "I need a file." } },
        {
          type: "gemini_part",
          part: {
            functionCall: { id: "call_1", name: "read_file", args: { path: "workspace/a.md" } },
            thoughtSignature: "call-sig",
          },
        },
      ],
      toolCalls: [{ id: "call_1", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" }],
      finishReason: "STOP",
      usage: {
        contextInputTokens: 1000,
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        cacheReadInputTokens: 400,
        cacheHitInputTokens: 400,
        reasoningTokens: 80,
        effectiveTokens: 800,
        providerDetails: {
          promptTokensDetails: [{ modality: "TEXT", tokenCount: 900 }],
          cacheTokensDetails: [{ modality: "TEXT", tokenCount: 400 }],
          toolUsePromptTokenCount: 25,
        },
      },
    });
  });

  test("rejects malformed functionCall blocks clearly", async () => {
    globalThis.fetch = (async () => Response.json({
      candidates: [{ content: { parts: [{ functionCall: { args: {} } }] } }],
    })) as unknown as typeof fetch;

    const adapter = new GeminiGenerateContentAdapter({
      provider: "gemini-generate-content",
      providerId: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-test",
      apiKey: "test-key",
    });

    await expect(adapter.complete(request())).rejects.toMatchObject({
      name: "ProviderError",
      kind: "malformed_response",
      providerId: "google",
    });
  });

  test("uses bearer auth for compatible relays", async () => {
    globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-key");
      return Response.json({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
      });
    }) as unknown as typeof fetch;

    const adapter = new GeminiGenerateContentAdapter({
      provider: "gemini-generate-content",
      providerId: "relay",
      baseUrl: "https://relay.test/v1beta",
      model: "gemini-test",
      apiKey: "test-key",
      authMethod: "bearer",
    });

    await expect(adapter.complete(request())).resolves.toMatchObject({ content: "ok" });
  });

  test("uses a structured missing-credentials error", async () => {
    const adapter = new GeminiGenerateContentAdapter({
      provider: "gemini-generate-content",
      providerId: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-test",
      apiKeyLabel: "GEMINI_API_KEY",
    });

    await expect(adapter.complete(request())).rejects.toMatchObject({
      name: "ProviderError",
      kind: "missing_credentials",
      providerId: "google",
    });
  });

  test("streams text, thought parts, tool calls, and a final response", async () => {
    globalThis.fetch = (async (input: unknown, init: RequestInit & { body?: unknown }) => {
      expect(String(input)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
      const headers = new Headers(init.headers);
      expect(headers.get("x-goog-api-client")).toBe(`google-genai-sdk/1.30.0 gl-node/${process.version}`);
      expect(headers.get("accept")).toBeNull();
      expect(JSON.parse(String(init.body))).toMatchObject({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      });
      return new Response(rawSse([
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"think","thought":true,"thoughtSignature":"thought-sig"}]}}]}',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]}}]}',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"call_1","name":"read_file","args":{"path":"workspace/a.md"}},"thoughtSignature":"call-sig"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3000,"candidatesTokenCount":500,"totalTokenCount":3500,"cachedContentTokenCount":1000,"thoughtsTokenCount":120}}',
      ]), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const adapter = new GeminiGenerateContentAdapter({
      provider: "gemini-generate-content",
      providerId: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-test",
      apiKey: "test-key",
    });

    const events = await collect(adapter.stream!(request()));

    expect(events).toContainEqual({ type: "reasoning_delta", delta: "think" });
    expect(events).toContainEqual({ type: "content_delta", delta: "hello" });
    expect(events).toContainEqual({
      type: "tool_call_delta",
      index: 2,
      id: "call_1",
      name: "read_file",
      argumentsDelta: "{\"path\":\"workspace/a.md\"}",
    });
    expect(events.at(-1)).toEqual({
      type: "complete",
      response: {
        id: "session-test",
        content: "hello",
        reasoningContent: "think",
        thinkingBlocks: [
          { type: "gemini_part", part: { text: "think", thought: true, thoughtSignature: "thought-sig" } },
          { type: "gemini_part", part: { text: "hello" } },
          {
            type: "gemini_part",
            part: {
              functionCall: { id: "call_1", name: "read_file", args: { path: "workspace/a.md" } },
              thoughtSignature: "call-sig",
            },
          },
        ],
        toolCalls: [{ id: "call_1", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" }],
        finishReason: "STOP",
        raw: [
          {
            candidates: [{
              content: {
                role: "model",
                parts: [{ text: "think", thought: true, thoughtSignature: "thought-sig" }],
              },
            }],
          },
          {
            candidates: [{
              content: {
                role: "model",
                parts: [{ text: "hello" }],
              },
            }],
          },
          {
            candidates: [{
              content: {
                role: "model",
                parts: [{
                  functionCall: { id: "call_1", name: "read_file", args: { path: "workspace/a.md" } },
                  thoughtSignature: "call-sig",
                }],
              },
              finishReason: "STOP",
            }],
            usageMetadata: {
              promptTokenCount: 3000,
              candidatesTokenCount: 500,
              totalTokenCount: 3500,
              cachedContentTokenCount: 1000,
              thoughtsTokenCount: 120,
            },
          },
        ],
        usage: {
          contextInputTokens: 3000,
          inputTokens: 3000,
          outputTokens: 500,
          totalTokens: 3500,
          cacheReadInputTokens: 1000,
          cacheHitInputTokens: 1000,
          reasoningTokens: 120,
          effectiveTokens: 2500,
        },
      },
    });
  });

  test("deduplicates cumulative stream parts", async () => {
    globalThis.fetch = (async () => new Response(rawSse([
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]}}]}',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hello"},{"text":" world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":2,"totalTokenCount":4}}',
    ]), {
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

    const adapter = new GeminiGenerateContentAdapter({
      provider: "gemini-generate-content",
      providerId: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-test",
      apiKey: "test-key",
    });

    const events = await collect(adapter.stream!(request()));

    expect(events.filter((event) => event.type === "content_delta")).toEqual([
      { type: "content_delta", delta: "hello" },
      { type: "content_delta", delta: " world" },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: { content: "hello world" },
    });
  });

  test("falls back to non-stream parsing when a stream request returns JSON", async () => {
    globalThis.fetch = (async () => Response.json({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
    })) as unknown as typeof fetch;

    const adapter = new GeminiGenerateContentAdapter({
      provider: "gemini-generate-content",
      providerId: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-test",
      apiKey: "test-key",
    });

    await expect(collect(adapter.stream!(request()))).resolves.toEqual([
      { type: "complete", response: expect.objectContaining({ content: "ok" }) },
    ]);
  });
});

function request(): VesicleRequest {
  return {
    id: "session-test",
    model: { provider: "google", model: "gemini-test" },
    system: ["system"],
    messages: [{ role: "user", content: "hello" }],
  };
}

function image(): NonNullable<VesicleRequest["messages"][number]["images"]>[number] {
  return {
    id: "img_test",
    path: ".vesicle/attachments/test.png",
    mediaType: "image/png",
    bytes: 3,
    sha256: "0".repeat(64),
    source: "clipboard",
    filename: "capture.png",
    data: "cG5n",
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
