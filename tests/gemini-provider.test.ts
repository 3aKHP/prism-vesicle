import { afterEach, describe, expect, test } from "bun:test";
import { GeminiGenerateContentAdapter, toGeminiGenerateContentBody } from "../src/providers/gemini-generate-content/adapter";
import type { VesicleRequest } from "../src/providers/shared/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Gemini generateContent request shaping", () => {
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
      generation: { reasoningTier: "midium" },
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
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
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
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
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
      expect(init.headers).toMatchObject({ "Authorization": "Bearer test-key" });
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
});

function request(): VesicleRequest {
  return {
    id: "session-test",
    model: { provider: "google", model: "gemini-test" },
    system: ["system"],
    messages: [{ role: "user", content: "hello" }],
  };
}
