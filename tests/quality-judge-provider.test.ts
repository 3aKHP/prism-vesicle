import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicMessagesAdapter } from "../src/providers/anthropic-messages/adapter";
import { GeminiGenerateContentAdapter } from "../src/providers/gemini-generate-content/adapter";
import { OpenAIChatCompatibleAdapter } from "../src/providers/openai-chat/adapter";
import type { ProviderAdapter } from "../src/providers/shared/types";
import { runQualityJudge, type QualityJudgeContract } from "../src/core/quality";

const originalFetch = globalThis.fetch;
const pass = JSON.stringify({
  schema: "quality-judge-result/v1",
  verdict: "pass",
  confidence: 0.9,
  findings: [],
});
const contract: QualityJudgeContract = {
  rubric: "Judge only the supplied candidate.",
  rules: [{
    id: "zh-f1-pov-leak",
    title: "POV leak",
    severity: "tier2",
    maturity: "stable",
    targets: ["narrative-prose"],
    source: "self",
    evidence: { mode: "exact-substring", minCodePoints: 1, maxCodePoints: 240 },
  }],
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Semantic Judge provider adapters", () => {
  test("uses isolated tool-free requests across all protocols and transport modes", async () => {
    for (const protocol of ["openai", "anthropic", "gemini"] as const) {
      for (const streaming of [false, true]) {
        let body: Record<string, unknown> | undefined;
        globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return providerResponse(protocol, streaming);
        }) as unknown as typeof fetch;
        const adapter = providerAdapter(protocol);
        const provider: ProviderAdapter = streaming ? adapter : {
          id: adapter.id,
          complete: (request) => adapter.complete(request),
        };
        const result = await runQualityJudge({
          provider,
          providerId: protocol,
          model: `${protocol}-model`,
          contract,
          candidateType: "runtime.prose",
          targetKind: "assistant-response",
          content: "雨水敲在铁皮棚上。",
        });

        expect(result, `${protocol}/${streaming ? "stream" : "complete"}`).toMatchObject({
          status: "valid",
          requestCount: 1,
          findings: [],
        });
        expect(body, `${protocol}/${streaming ? "stream" : "complete"}`).toBeDefined();
        expect(body?.tools, `${protocol}/${streaming ? "stream" : "complete"}`).toBeUndefined();
        if (protocol === "openai") {
          expect(body?.messages).toMatchObject([
            { role: "system" },
            { role: "user" },
          ]);
        } else if (protocol === "anthropic") {
          expect(body?.system).toContain("Never call tools");
          expect(body?.messages).toMatchObject([{ role: "user" }]);
        } else {
          expect(body?.systemInstruction).toMatchObject({ parts: [{ text: expect.stringContaining("Never call tools") }] });
          expect(body?.contents).toMatchObject([{ role: "user" }]);
        }
      }
    }
  });
});

function providerAdapter(protocol: "openai" | "anthropic" | "gemini"): ProviderAdapter {
  if (protocol === "openai") {
    return new OpenAIChatCompatibleAdapter({
      provider: "openai-chat-compatible",
      providerId: "openai",
      baseUrl: "https://openai.test/v1",
      model: "openai-model",
      apiKey: "test-key",
    });
  }
  if (protocol === "anthropic") {
    return new AnthropicMessagesAdapter({
      provider: "anthropic-messages",
      providerId: "anthropic",
      baseUrl: "https://anthropic.test/v1",
      model: "anthropic-model",
      apiKey: "test-key",
    });
  }
  return new GeminiGenerateContentAdapter({
    provider: "gemini-generate-content",
    providerId: "gemini",
    baseUrl: "https://gemini.test/v1beta",
    model: "gemini-model",
    apiKey: "test-key",
  });
}

function providerResponse(protocol: "openai" | "anthropic" | "gemini", streaming: boolean): Response {
  if (protocol === "openai") {
    if (!streaming) return Response.json({ id: "judge", choices: [{ message: { content: pass }, finish_reason: "stop" }] });
    return sse([
      `data: ${JSON.stringify({ id: "judge", choices: [{ delta: { content: pass }, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ]);
  }
  if (protocol === "anthropic") {
    if (!streaming) return Response.json({
      id: "judge",
      content: [{ type: "text", text: pass }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    return sse([
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "judge", usage: { input_tokens: 10 } } })}`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: pass } })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
    ]);
  }
  if (!streaming) return Response.json({
    candidates: [{ content: { role: "model", parts: [{ text: pass }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  });
  return sse([
    `data: ${JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: pass }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    })}`,
  ]);
}

function sse(blocks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(`${block}\n\n`));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
