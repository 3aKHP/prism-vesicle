import { describe, expect, test } from "bun:test";
import { OpenAIResponsesAdapter } from "../../../src/providers/openai-responses/adapter";
import { responsesEndpointFingerprint } from "../../../src/providers/openai-responses/owner";
import { toResponsesBody } from "../../../src/providers/openai-responses/request";
import { readResponsesStream } from "../../../src/providers/openai-responses/stream";
import {
  providerStateEnvelopeVersion,
  type ProviderStateEnvelope,
  type ProviderStateJson,
} from "../../../src/providers/shared/state";
import type { ProviderStreamEvent, VesicleRequest } from "../../../src/providers/shared/types";
import { bytesFromChunks } from "../../support/providers/sse";
import captures from "../../fixtures/openai-responses/request-captures-v1.json";
import { compareStructuredCapture, requireJsonValue } from "../../support/providers/responses-conformance";

describe("OpenAI Responses request codec", () => {
  test("matches the frozen Codex HTTP/SSE application request", () => {
    const expected = captures.captures.find((capture) => capture.id === "codex-http-sse-sanitized");
    if (!expected) throw new Error("Missing frozen HTTP/SSE capture.");
    const body = toResponsesBody({
      id: "<dynamic:prompt-cache-key>",
      model: { provider: "openai", model: "gpt-5.6" },
      system: ["fixture instructions"],
      messages: [{ role: "user", content: "fixture prompt" }],
      tools: [{ type: "function", function: {
        name: "read_fixture", description: "Read fixture data",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      } }],
      generation: { reasoningTier: "high" },
    }, context(), true);
    expect(compareStructuredCapture(
      requireJsonValue(expected.body),
      requireJsonValue(JSON.parse(JSON.stringify(body))),
    )).toEqual([]);
  });

  test("uses deterministic public-profile key order and exact call_id pairing", () => {
    const body = toResponsesBody({
      ...request(),
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call_read", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" }] },
        { role: "tool", toolCallId: "call_read", content: "{\"ok\":true}" },
      ],
      tools: [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } }],
      generation: { reasoningTier: "high", maxTokens: 1234 },
    }, context(), true);

    expect(Object.keys(body)).toEqual([
      "model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "reasoning",
      "store", "stream", "stream_options", "include", "service_tier", "prompt_cache_key", "text", "max_output_tokens",
    ]);
    expect(body).toMatchObject({
      model: "gpt-5.2-codex",
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "high", summary: "auto" },
      stream_options: { include_obfuscation: false },
      include: ["reasoning.encrypted_content"],
      store: false,
      stream: true,
      service_tier: "auto",
      prompt_cache_key: "req_1",
      text: { verbosity: "medium" },
    });
    expect(body.input).toEqual([
      { type: "function_call", call_id: "call_read", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" },
      { type: "function_call_output", call_id: "call_read", output: "{\"ok\":true}" },
    ]);
  });

  test("replays same-owner native Items without reconstructing encrypted reasoning", () => {
    const outputItems: ProviderStateJson[] = [
      { id: "rs_1", type: "reasoning", encrypted_content: "opaque-ciphertext", summary: [] },
      { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    ];
    const body = toResponsesBody({
      ...request(),
      messages: [{
        role: "assistant",
        content: "done",
        providerState: {
          version: providerStateEnvelopeVersion,
          protocol: "openai-responses",
          providerId: "openai",
          model: "gpt-5.2-codex",
          endpointFingerprint: responsesEndpointFingerprint("https://api.openai.com/v1"),
          payload: { version: 1, responseId: "resp_1", outputItems },
        },
      }],
    }, context(), false);
    expect(body.input).toEqual(outputItems);
  });

  test("rejects duplicate function outputs before network I/O", () => {
    expect(() => toResponsesBody({
      ...request(),
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: "{}" }] },
        { role: "tool", toolCallId: "call_1", content: "first" },
        { role: "tool", toolCallId: "call_1", content: "second" },
      ],
    }, context(), true)).toThrow("call_id call_1 was answered more than once");
  });

  test("rejects duplicate native calls and orphan results before network I/O", () => {
    const duplicateState: ProviderStateEnvelope = {
      version: providerStateEnvelopeVersion,
      protocol: "openai-responses",
      providerId: "openai",
      model: "gpt-5.2-codex",
      endpointFingerprint: responsesEndpointFingerprint("https://api.openai.com/v1"),
      payload: { version: 1, outputItems: [
        { type: "function_call", call_id: "dup", name: "read_file", arguments: "{}" },
        { type: "function_call", call_id: "dup", name: "read_file", arguments: "{}" },
      ] },
    };
    expect(() => toResponsesBody({
      ...request(),
      messages: [{ role: "assistant", content: "", providerState: duplicateState }],
    }, context(), true)).toThrow("repeated function call_id dup");
    expect(() => toResponsesBody({
      ...request(), messages: [{ role: "tool", toolCallId: "orphan", content: "result" }],
    }, context(), true)).toThrow("no preceding call_id orphan");
  });
});

describe("OpenAI Responses typed SSE", () => {
  test("commits final ordered Items and native state only at response.completed", async () => {
    const response = responseStream([
      event(0, "response.created"),
      event(1, "response.output_text.delta", { delta: "hi" }),
      event(2, "response.output_item.done", { item: {
        id: "call_item", type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}",
      } }),
      event(3, "response.completed", { response: {
        id: "resp_1", status: "completed",
        output: [
          { id: "rs_1", type: "reasoning", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "considered" }] },
          { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
          { id: "call_item", type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, output_tokens_details: { reasoning_tokens: 2 } },
      } }),
    ]);
    const events = await collect(readResponsesStream(response, streamContext()));
    expect(events.slice(0, 3)).toEqual([
      { type: "attempt_started", attempt: 1 },
      { type: "content_delta", delta: "hi" },
      { type: "tool_call_candidate", attempt: 1, toolCall: { id: "call_1", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" } },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "complete", attempt: 1,
      response: {
        id: "resp_1", content: "hi", reasoningContent: "considered",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" }],
        providerState: { protocol: "openai-responses", payload: { responseId: "resp_1" } },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 2 },
      },
    });
    const complete = events.at(-1);
    if (complete?.type !== "complete") throw new Error("Missing completed response.");
    expect(complete.response.providerState?.endpointFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(complete.response.providerState?.endpointFingerprint).not.toContain("api.openai.com");
  });

  test("rejects premature EOF after a complete function Item", async () => {
    const response = responseStream([
      event(0, "response.output_item.done", { item: {
        type: "function_call", call_id: "call_1", name: "write_file", arguments: "{}",
      } }),
    ]);
    const seen: ProviderStreamEvent[] = [];
    await expect((async () => {
      for await (const item of readResponsesStream(response, streamContext())) seen.push(item);
    })()).rejects.toThrow("ended before response.completed");
    expect(seen).toEqual([
      { type: "attempt_started", attempt: 1 },
      { type: "tool_call_candidate", attempt: 1, toolCall: { id: "call_1", name: "write_file", arguments: "{}" } },
    ]);
    expect(seen.some((item) => item.type === "complete")).toBe(false);
  });

  test("rejects unknown semantic output Items instead of persisting and replaying them", async () => {
    const response = responseStream([event(0, "response.completed", { response: {
      id: "resp_unknown", status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "unsafe" }] },
        { type: "computer_call", id: "computer_1" },
      ],
    } })]);
    await expect(collect(readResponsesStream(response, streamContext())))
      .rejects.toThrow("unsupported semantic Item computer_call");
  });

  test("requires streamed function arguments to match the terminal Item", async () => {
    const response = responseStream([
      event(0, "response.function_call_arguments.delta", { output_index: 0, delta: "{\"wrong\":true}" }),
      event(1, "response.completed", { response: {
        id: "resp_args", status: "completed",
        output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" }],
      } }),
    ]);
    await expect(collect(readResponsesStream(response, streamContext())))
      .rejects.toThrow("did not match the completed response Item");
  });

  test("accepts only declared non-semantic relay diagnostics", async () => {
    const events = [
      event(0, "codex.rate_limits", { limits: {} }),
      event(1, "codex.response.metadata", { metadata: {} }),
      event(2, "response.completed", { response: {
        id: "resp_relay", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      } }),
    ];
    await expect(collect(readResponsesStream(responseStream(events), {
      ...streamContext(), profile: "codex-http-relay",
    }))).resolves.toMatchObject([
      { type: "attempt_started" },
      { type: "complete", response: { content: "ok" } },
    ]);
    await expect(collect(readResponsesStream(responseStream(events), {
      ...streamContext(), profile: "openai-public",
    }))).rejects.toThrow("Unsupported semantic Responses event: codex.rate_limits");
  });

  test("uses the same final parser for non-streaming JSON", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      id: "resp_json", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "json" }] }],
    })) as unknown as typeof fetch;
    try {
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "openai", baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.2-codex", apiKey: "test-key", responsesProfile: "openai-public",
      });
      await expect(adapter.complete(request())).resolves.toMatchObject({ id: "resp_json", content: "json" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("requires explicit OpenAI capability profile before network I/O", async () => {
    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      return Response.json({});
    }) as unknown as typeof fetch;
    try {
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "unknown", baseUrl: "https://provider.test/v1",
        model: "model", apiKey: "test-key",
      });
      await expect(adapter.complete(request())).rejects.toThrow("requires an explicit supported responsesProfile");
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries an uncommitted SSE attempt without publishing its draft", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      if (fetches === 1) return responseStream([
        event(0, "response.output_text.delta", { delta: "discarded" }),
      ]);
      return responseStream([
        event(0, "response.output_text.delta", { delta: "committed" }),
        event(1, "response.completed", { response: {
          id: "resp_retry", status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "committed" }] }],
        } }),
      ]);
    }) as unknown as typeof fetch;
    const retries: number[] = [];
    try {
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "openai", baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.2-codex", apiKey: "test-key", responsesProfile: "openai-public",
      });
      const events = await collect(adapter.stream!({ ...request(), onRetry: (info) => retries.push(info.attempt) }));
      expect(events).toEqual([
        { type: "attempt_started", attempt: 1 },
        { type: "attempt_discarded", attempt: 1 },
        { type: "attempt_started", attempt: 2 },
        { type: "content_delta", delta: "committed" },
        expect.objectContaining({ type: "complete", attempt: 2, response: expect.objectContaining({ content: "committed" }) }),
      ]);
      expect(retries).toEqual([1]);
      expect(fetches).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function request(): VesicleRequest {
  return { id: "req_1", model: { provider: "openai", model: "gpt-5.2-codex" }, system: ["system"], messages: [] };
}

function context() {
  return { providerId: "openai", endpointFingerprint: responsesEndpointFingerprint("https://api.openai.com/v1") };
}

function streamContext() {
  return {
    requestId: "req_1", providerId: "openai", model: "gpt-5.2-codex",
    endpointFingerprint: responsesEndpointFingerprint("https://api.openai.com/v1"),
  };
}

function event(sequence: number, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, sequence_number: sequence, ...extra };
}

function responseStream(events: unknown[]): Response {
  return new Response(bytesFromChunks(events.map((item) => `event: message\ndata: ${JSON.stringify(item)}\n\n`)), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(iterable: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const result: ProviderStreamEvent[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}
