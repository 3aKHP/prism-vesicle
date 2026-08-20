import { describe, expect, test } from "bun:test";
import { OpenAIResponsesAdapter } from "../../../src/providers/openai-responses/adapter";
import { responsesEndpointFingerprint } from "../../../src/providers/openai-responses/owner";
import { findResponsesContinuation, toResponsesBody, toResponsesCompactBody } from "../../../src/providers/openai-responses/request";
import { readResponsesStream } from "../../../src/providers/openai-responses/stream";
import { responseFromResponsesBody } from "../../../src/providers/openai-responses/response";
import {
  providerStateEnvelopeVersion,
  type ProviderStateEnvelope,
  type ProviderStateJson,
} from "../../../src/providers/shared/state";
import type { ProviderStreamEvent, ReasoningTier, VesicleRequest } from "../../../src/providers/shared/types";
import { PROVIDER_NATIVE_CHECKPOINT_KIND } from "../../../src/providers/shared/types";
import { closeResponsesWebSocketSession, responsesWebSocketSession } from "../../../src/providers/openai-responses/websocket";
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
    }, context(), true, "openai-public");
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
      generation: { reasoningTier: "high", temperature: 0.3, maxTokens: 1234 },
    }, context(), true, "openai-public");

    expect(Object.keys(body)).toEqual([
      "model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "reasoning",
      "store", "stream", "stream_options", "include", "service_tier", "prompt_cache_key", "temperature", "text", "max_output_tokens",
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
      temperature: 0.3,
      text: { verbosity: "medium" },
    });
    expect(body.input).toEqual([
      { type: "function_call", call_id: "call_read", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" },
      { type: "function_call_output", call_id: "call_read", output: "{\"ok\":true}" },
    ]);
    expect(toResponsesBody({
      ...request(), generation: { reasoningTier: "off" },
    }, context(), false, "openai-public").reasoning).toEqual({ effort: "none" });
    expect(() => toResponsesBody({
      ...request(), generation: { reasoningTier: "invalid" as ReasoningTier },
    }, context(), false, "openai-public")).toThrow("Unsupported reasoning tier: invalid");
  });

  test("omits service_tier from the codex-http-relay compatibility-tier request", () => {
    const body = toResponsesBody({
      ...request(),
      tools: [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } }],
      generation: { reasoningTier: "high", temperature: 0.3, maxTokens: 1234 },
    }, context(), true, "codex-http-relay");

    // codex-http-relay is the maximum-compatibility tier; service_tier is omitted on
    // the wire so relays that reject OpenAI tier values (e.g. sssai) stay usable,
    // while the rest of the public request surface matches openai-public.
    const wire = JSON.parse(JSON.stringify(body));
    expect(wire).not.toHaveProperty("service_tier");
    expect(wire).toMatchObject({
      store: false,
      stream: true,
      parallel_tool_calls: true,
      stream_options: { include_obfuscation: false },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "req_1",
      reasoning: { effort: "high", summary: "auto" },
    });
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
          payload: { version: 1, profile: "openai-public", responseId: "resp_1", outputItems },
        },
      }],
    }, context(), false, "openai-public");
    expect(body.input).toEqual(outputItems);
  });

  test("uses portable history when the Responses profile changes at the same endpoint", () => {
    const openAIState: ProviderStateEnvelope = {
      version: providerStateEnvelopeVersion,
      protocol: "openai-responses",
      providerId: "openai",
      model: "gpt-5.2-codex",
      endpointFingerprint: responsesEndpointFingerprint("https://api.openai.com/v1"),
      payload: { version: 1, profile: "openai-public", outputItems: [
        { type: "reasoning", encrypted_content: "opaque", summary: [] },
      ] },
    };
    const mimoState: ProviderStateEnvelope = {
      ...openAIState,
      payload: { version: 1, profile: "mimo-subset-2026-07-30", outputItems: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: "private" }] },
      ] },
    };

    expect(toResponsesBody({
      ...request(), messages: [{ role: "assistant", content: "portable OpenAI", providerState: mimoState }],
    }, context(), false, "openai-public").input).toEqual([
      { role: "assistant", content: "portable OpenAI" },
    ]);
    expect(toResponsesBody({
      ...request(), messages: [{ role: "assistant", content: "portable MiMo", providerState: openAIState }],
    }, context(), false, "mimo-subset-2026-07-30").input).toEqual([
      { role: "assistant", content: "portable MiMo" },
    ]);

    const compactMarker = {
      role: "user" as const,
      content: "",
      kind: PROVIDER_NATIVE_CHECKPOINT_KIND,
      providerState: {
        ...openAIState,
        payload: { version: 1, profile: "openai-public", compactedInput: [
          { type: "compaction", encrypted_content: "opaque" },
        ] },
      },
    };
    expect(toResponsesBody({
      ...request(),
      messages: [
        { role: "user", content: "portable checkpoint", kind: "compact-summary" },
        compactMarker,
        { role: "user", content: "continue" },
      ],
    }, context(), false, "mimo-subset-2026-07-30").input).toEqual([
      { role: "user", content: "portable checkpoint" },
      { role: "user", content: "continue" },
    ]);
  });

  test("replaces portable history with an owner-compatible compact window and starts a new chain", () => {
    const compactedInput: ProviderStateJson[] = [
      { id: "msg_compact", type: "message", role: "user", content: [{ type: "input_text", text: "canonical" }] },
      { id: "cmp_1", type: "compaction", encrypted_content: "opaque-compact" },
    ];
    const marker = {
      role: "user" as const,
      content: "",
      kind: PROVIDER_NATIVE_CHECKPOINT_KIND,
      providerState: {
        version: 1 as const,
        protocol: "openai-responses",
        providerId: "openai",
        model: "gpt-5.2-codex",
        endpointFingerprint: responsesEndpointFingerprint("https://api.openai.com/v1"),
        payload: { version: 1, profile: "openai-public", compactedInput },
      },
    };
    const compactedRequest = {
      ...request(),
      messages: [
        { role: "user" as const, content: "[conversation summary]\nportable", kind: "compact-summary" },
        { role: "assistant" as const, content: "retained" },
        marker,
        { role: "user" as const, content: "continue" },
      ],
    };

    expect(toResponsesBody(compactedRequest, context(), true, "openai-public").input).toEqual([
      ...compactedInput,
      { role: "user", content: "continue" },
    ]);
    expect(findResponsesContinuation(compactedRequest, context(), "resp_before_compact")).toBeUndefined();

    const switched = {
      ...compactedRequest,
      model: { provider: "openai", model: "different-model" },
    };
    expect(toResponsesBody(switched, context(), true, "openai-public").input).toEqual([
      { role: "user", content: "[conversation summary]\nportable" },
      { role: "assistant", content: "retained" },
      { role: "user", content: "continue" },
    ]);

    const corrupt = {
      ...compactedRequest,
      messages: compactedRequest.messages.map((message) => message === marker
        ? { ...message, providerState: { ...marker.providerState, version: 99 as 1 } }
        : message),
    };
    expect(toResponsesBody(corrupt, context(), true, "openai-public").input).toEqual([
      { role: "user", content: "[conversation summary]\nportable" },
      { role: "assistant", content: "retained" },
      { role: "user", content: "continue" },
    ]);
  });

  test("encodes and validates standalone remote compaction without a response continuation", async () => {
    const originalFetch = globalThis.fetch;
    let url = "";
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "compact_1",
        object: "response.compaction",
        output: [
          { id: "search_1", type: "web_search_call", status: "completed", action: { type: "search", query: "canonical context" } },
          { id: "msg_1", type: "message", role: "user", content: [{ type: "input_text", text: "canonical" }] },
          { id: "cmp_1", type: "compaction", encrypted_content: "opaque" },
        ],
        usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
      });
    }) as unknown as typeof fetch;
    try {
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "openai", baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.2-codex", apiKey: "test-key", responsesProfile: "openai-public",
        capabilities: { remoteCompact: true },
      });
      const compactRequest = { id: "compact-request", model: request().model, messages: request().messages };
      expect(toResponsesCompactBody(compactRequest, context())).not.toHaveProperty("previous_response_id");
      const result = await adapter.compact!(compactRequest);
      expect(url).toBe("https://api.openai.com/v1/responses/compact");
      expect(body).toEqual({ model: "gpt-5.2-codex", input: [] });
      expect(result.providerState).toMatchObject({
        protocol: "openai-responses",
        payload: { version: 1, profile: "openai-public", compactedInput: [
          { type: "web_search_call", action: { query: "canonical context" } },
          { type: "message" },
          { type: "compaction" },
        ] },
      });
      expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 4, totalTokens: 24 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a standalone compact response without its encrypted compaction Item", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      id: "compact_missing_marker",
      object: "response.compaction",
      output: [{ id: "msg_1", type: "message", role: "user", content: [{ type: "input_text", text: "not compacted" }] }],
    })) as unknown as typeof fetch;
    try {
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "openai", baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.2-codex", apiKey: "test-key", responsesProfile: "openai-public",
        capabilities: { remoteCompact: true },
      });
      await expect(adapter.compact!({ id: "compact", model: request().model, messages: [] }))
        .rejects.toThrow("exactly one encrypted compaction Item");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("committed standalone compaction invalidates the old session continuation", async () => {
    const originalFetch = globalThis.fetch;
    const sessionId = "compact-continuation";
    const session = responsesWebSocketSession({
      sessionId,
      owner: "fixture-owner",
      baseUrl: "https://api.openai.com/v1",
      providerId: "openai",
      headers: { authorization: "Bearer test-key" },
      factory: () => { throw new Error("socket should not open"); },
    });
    session.lastResponseId = "resp_before_compact";
    globalThis.fetch = (async () => Response.json({
      id: "compact_1",
      object: "response.compaction",
      output: [{ id: "cmp_1", type: "compaction", encrypted_content: "opaque" }],
    })) as unknown as typeof fetch;
    try {
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "openai", baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.2-codex", apiKey: "test-key", responsesProfile: "openai-public",
        responsesTransport: "websocket", capabilities: { remoteCompact: true },
      }, { sessionId });
      await adapter.compact!({ id: "compact", model: request().model, messages: [] });
      expect(session.lastResponseId).toBe("resp_before_compact");
      adapter.commitCompact();
      expect(session.lastResponseId).toBeUndefined();
      expect(session.needsPrewarm()).toBe(true);
    } finally {
      closeResponsesWebSocketSession(sessionId);
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects duplicate function outputs before network I/O", () => {
    expect(() => toResponsesBody({
      ...request(),
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: "{}" }] },
        { role: "tool", toolCallId: "call_1", content: "first" },
        { role: "tool", toolCallId: "call_1", content: "second" },
      ],
    }, context(), true, "openai-public")).toThrow("call_id call_1 was answered more than once");
  });

  test("falls back from corrupt native calls and rejects orphan portable results before network I/O", () => {
    const duplicateState: ProviderStateEnvelope = {
      version: providerStateEnvelopeVersion,
      protocol: "openai-responses",
      providerId: "openai",
      model: "gpt-5.2-codex",
      endpointFingerprint: responsesEndpointFingerprint("https://api.openai.com/v1"),
      payload: { version: 1, profile: "openai-public", outputItems: [
        { type: "function_call", call_id: "dup", name: "read_file", arguments: "{}" },
        { type: "function_call", call_id: "dup", name: "read_file", arguments: "{}" },
      ] },
    };
    expect(toResponsesBody({
      ...request(),
      messages: [{ role: "assistant", content: "portable", providerState: duplicateState }],
    }, context(), true, "openai-public").input).toEqual([{ role: "assistant", content: "portable" }]);
    expect(() => toResponsesBody({
      ...request(), messages: [{ role: "tool", toolCallId: "orphan", content: "result" }],
    }, context(), true, "openai-public")).toThrow("no preceding call_id orphan");
  });

  test("omits unsupported OpenAI fields from the frozen MiMo subset", () => {
    const body = toResponsesBody({
      ...request(),
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: {
        name: "echo", description: "Echo", parameters: { type: "object" },
      } }],
      generation: { reasoningTier: "high", temperature: 0.2, maxTokens: 512 },
    }, context(), true, "mimo-subset-2026-07-30");

    expect(Object.keys(body)).toEqual([
      "model", "instructions", "input", "tools", "tool_choice", "reasoning",
      "stream", "max_output_tokens", "temperature", "text",
    ]);
    expect(body).toMatchObject({
      reasoning: { effort: "high" },
      stream: true,
      max_output_tokens: 512,
      temperature: 0.2,
    });
    for (const unsupported of [
      "background", "context_management", "previous_response_id", "parallel_tool_calls",
      "store", "stream_options", "include", "service_tier", "prompt_cache_key",
    ]) expect(body).not.toHaveProperty(unsupported);

    expect(toResponsesBody({
      ...request(), generation: { reasoningTier: "off" },
    }, context(), false, "mimo-subset-2026-07-30").reasoning).toEqual({ effort: "none" });
    expect(toResponsesBody({
      ...request(), generation: { reasoningTier: "max" },
    }, context(), false, "mimo-subset-2026-07-30").reasoning).toEqual({ effort: "high" });
    expect(toResponsesBody({
      ...request(), generation: { reasoningTier: "xhigh" },
    }, context(), false, "mimo-subset-2026-07-30").reasoning).toEqual({ effort: "high" });
  });

  test("encodes the stateless DeepSeek subset with its documented reasoning efforts", () => {
    const body = toResponsesBody({
      ...request(),
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: {
        name: "echo", description: "Echo", parameters: { type: "object" },
      } }],
      generation: { reasoningTier: "max", temperature: 0.2, maxTokens: 512 },
    }, context(), true, "deepseek-subset-2026-07-31");

    expect(Object.keys(body)).toEqual([
      "model", "instructions", "input", "tools", "tool_choice", "reasoning",
      "stream", "max_output_tokens", "temperature", "text",
    ]);
    expect(body).toMatchObject({
      reasoning: { effort: "max" },
      stream: true,
      max_output_tokens: 512,
      temperature: 0.2,
    });
    for (const unsupported of [
      "background", "context_management", "previous_response_id", "parallel_tool_calls",
      "store", "stream_options", "include", "service_tier", "prompt_cache_key",
    ]) expect(body).not.toHaveProperty(unsupported);

    expect(toResponsesBody({
      ...request(), generation: { reasoningTier: "off" },
    }, context(), false, "deepseek-subset-2026-07-31").reasoning).toEqual({ effort: "none" });
    expect(toResponsesBody({
      ...request(), generation: { reasoningTier: "medium" },
    }, context(), false, "deepseek-subset-2026-07-31").reasoning).toEqual({ effort: "high" });
    expect(toResponsesBody({
      ...request(), generation: { reasoningTier: "xhigh" },
    }, context(), false, "deepseek-subset-2026-07-31").reasoning).toEqual({ effort: "high" });
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

  test("reconstructs codex-http-relay output from completed stream Items after a valid terminal", async () => {
    const events = await collect(readResponsesStream(responseStream([
      event(0, "response.created"),
      event(1, "response.output_item.done", { item: {
        id: "rs_relay", type: "reasoning", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "considered" }],
      } }),
      event(2, "response.function_call_arguments.delta", { output_index: 1, delta: "{\"path\":\"workspace/a.md\"}" }),
      event(3, "response.output_item.done", { item: {
        id: "call_relay_1", type: "function_call", call_id: "call_relay_1", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}",
      } }),
      event(4, "response.function_call_arguments.delta", { output_index: 2, delta: "{\"path\":\"workspace/b.md\"}" }),
      event(5, "response.output_item.done", { item: {
        id: "call_relay_2", type: "function_call", call_id: "call_relay_2", name: "read_file", arguments: "{\"path\":\"workspace/b.md\"}",
      } }),
      event(6, "response.completed", { response: {
        id: "resp_relay_items", status: "completed", output: [],
        usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28, output_tokens_details: { reasoning_tokens: 3 } },
      } }),
    ]), {
      ...streamContext(), profile: "codex-http-relay",
    }));

    expect(events.filter((candidate) => candidate.type === "tool_call_candidate")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: {
        id: "resp_relay_items",
        content: "",
        reasoningContent: "considered",
        toolCalls: [
          { id: "call_relay_1", name: "read_file", arguments: "{\"path\":\"workspace/a.md\"}" },
          { id: "call_relay_2", name: "read_file", arguments: "{\"path\":\"workspace/b.md\"}" },
        ],
        providerState: { payload: { profile: "codex-http-relay", outputItems: [
          { id: "rs_relay", type: "reasoning" },
          { id: "call_relay_1", type: "function_call" },
          { id: "call_relay_2", type: "function_call" },
        ] } },
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28, reasoningTokens: 3 },
      },
    });
  });

  test("keeps empty terminal output invalid outside codex-http-relay", async () => {
    const events = [
      event(0, "response.output_item.done", { output_index: 0, item: {
        type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}",
      } }),
      event(1, "response.completed", { response: { id: "resp_empty", status: "completed", output: [] } }),
    ];
    await expect(collect(readResponsesStream(responseStream(events), {
      ...streamContext(), profile: "openai-public",
    }))).rejects.toThrow("did not include assistant content or function calls");
  });

  test("reconstructs omitted relay terminal output only when completed Items exist", async () => {
    const events = await collect(readResponsesStream(responseStream([
      event(0, "response.output_item.done", { output_index: 0, item: {
        type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }],
      } }),
      event(1, "response.completed", { response: { id: "resp_omitted", status: "completed" } }),
    ]), {
      ...streamContext(), profile: "codex-http-relay",
    }));
    expect(events.at(-1)).toMatchObject({ type: "complete", response: { content: "done" } });

    await expect(collect(readResponsesStream(responseStream([
      event(0, "response.completed", { response: { id: "resp_missing", status: "completed" } }),
    ]), {
      ...streamContext(), profile: "codex-http-relay",
    }))).rejects.toThrow("did not include ordered output Items");
  });

  test("accepts codex-http-relay terminal output that strips optional fields from completed Items", async () => {
    const events = await collect(readResponsesStream(responseStream([
      event(0, "response.output_item.done", { output_index: 0, item: {
        id: "msg_strip", status: "completed", type: "message", role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", annotations: [], logprobs: [], text: "ok" }],
      } }),
      event(1, "response.completed", { response: {
        id: "resp_strip", status: "completed",
        output: [{
          type: "message", role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        }],
      } }),
    ]), {
      ...streamContext(), profile: "codex-http-relay",
    }));
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      response: {
        id: "resp_strip",
        content: "ok",
        providerState: { payload: { profile: "codex-http-relay", outputItems: [
          { id: "msg_strip", type: "message" },
        ] } },
      },
    });
  });

  test("rejects inconsistent or non-contiguous codex-http-relay completed Items", async () => {
    await expect(collect(readResponsesStream(responseStream([
      event(0, "response.output_item.done", { output_index: 1, item: {
        type: "message", role: "assistant", content: [{ type: "output_text", text: "out of order" }],
      } }),
    ]), {
      ...streamContext(), profile: "codex-http-relay",
    }))).rejects.toThrow("did not match the expected index 0");

    await expect(collect(readResponsesStream(responseStream([
      event(0, "response.output_item.done", { output_index: 0, item: {
        type: "message", role: "assistant", content: [{ type: "output_text", text: "stream Item" }],
      } }),
      event(1, "response.completed", { response: {
        id: "resp_mismatch", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "terminal Item" }] }],
      } }),
    ]), {
      ...streamContext(), profile: "codex-http-relay",
    }))).rejects.toThrow("did not match response.output_item.done Items");
  });

  test("accepts the official empty reasoning content placeholder", async () => {
    const response = responseStream([event(0, "response.completed", { response: {
      id: "resp_empty_reasoning_content", status: "completed",
      output: [
        { type: "reasoning", encrypted_content: "opaque", content: [], summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
    } })]);
    const events = await collect(readResponsesStream(response, streamContext()));
    expect(events).toMatchObject([
      { type: "attempt_started", attempt: 1 },
      { type: "complete", response: { content: "ok" } },
    ]);
    const complete = events.at(-1);
    if (complete?.type !== "complete") throw new Error("Missing completed response.");
    expect(complete.response.reasoningContent).toBeUndefined();
  });

  test("rejects premature EOF after a complete function Item", async () => {
    const response = responseStream([
      event(0, "response.output_item.done", { item: {
        type: "function_call", call_id: "call_1", name: "write_file", arguments: "{}",
      } }),
    ]);
    const seen: ProviderStreamEvent[] = [];
    await expect((async () => {
      for await (const item of readResponsesStream(response, {
        ...streamContext(), profile: "codex-http-relay",
      })) seen.push(item);
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
      event(2, "responsesapi.websocket_timing", { timing_metrics: {} }),
      event(3, "response.completed", { response: {
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
    const timingOnlyEvents = [
      event(0, "responsesapi.websocket_timing", { timing_metrics: {} }),
      event(1, "response.completed", { response: {
        id: "resp_timing", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      } }),
    ];
    await expect(collect(readResponsesStream(responseStream(timingOnlyEvents), {
      ...streamContext(), profile: "openai-public",
    }))).rejects.toThrow("Unsupported semantic Responses event: responsesapi.websocket_timing");
  });

  test("maps MiMo reasoning events and Items only under its explicit subset profile", async () => {
    const events = [
      event(0, "response.reasoning_text.delta", { delta: "thinking" }),
      event(1, "response.reasoning_text.done", { text: "thinking" }),
      event(2, "response.output_text.delta", { delta: "answer" }),
      event(3, "response.completed", { response: {
        id: "resp_mimo", status: "completed",
        output: [
          { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking" }], summary: [] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        ],
      } }),
    ];
    await expect(collect(readResponsesStream(responseStream(events), {
      ...streamContext(), profile: "mimo-subset-2026-07-30",
    }))).resolves.toMatchObject([
      { type: "attempt_started" },
      { type: "reasoning_delta", delta: "thinking" },
      { type: "content_delta", delta: "answer" },
      { type: "complete", response: { reasoningContent: "thinking", content: "answer" } },
    ]);
    await expect(collect(readResponsesStream(responseStream(events), {
      ...streamContext(), profile: "deepseek-subset-2026-07-31",
    }))).resolves.toMatchObject([
      { type: "attempt_started" },
      { type: "reasoning_delta", delta: "thinking" },
      { type: "content_delta", delta: "answer" },
      { type: "complete", response: { reasoningContent: "thinking", content: "answer" } },
    ]);
    await expect(collect(readResponsesStream(responseStream(events), {
      ...streamContext(), profile: "openai-public",
    }))).rejects.toThrow("Unsupported semantic Responses event: response.reasoning_text.delta");

    await expect(collect(readResponsesStream(responseStream([
      event(0, "response.completed", { response: {
        id: "resp_openai_mimo_item", status: "completed",
        output: [
          { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        ],
      } }),
    ]), {
      ...streamContext(), profile: "openai-public",
    }))).rejects.toThrow("unsupported reasoning content");

    await expect(collect(readResponsesStream(responseStream([
      event(0, "response.reasoning_summary_text.delta", { delta: "thinking" }),
    ]), {
      ...streamContext(), profile: "mimo-subset-2026-07-30",
    }))).rejects.toThrow("Unsupported semantic Responses event: response.reasoning_summary_text.delta");

    await expect(collect(readResponsesStream(responseStream([
      event(0, "response.completed", { response: {
        id: "resp_mimo_mixed", status: "completed",
        output: [
          {
            type: "reasoning",
            content: [{ type: "reasoning_text", text: "thinking" }],
            summary: [{ type: "summary_text", text: "OpenAI-only" }],
          },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        ],
      } }),
    ]), {
      ...streamContext(), profile: "mimo-subset-2026-07-30",
    }))).rejects.toThrow("unsupported MiMo reasoning content");
  });

  test("uses the configured MiMo x-api-key authentication header", async () => {
    const originalFetch = globalThis.fetch;
    let headers = new Headers();
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return Response.json({
        id: "resp_mimo", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      });
    }) as unknown as typeof fetch;
    try {
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "mimo", baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2.5-pro", apiKey: "test-key", authMethod: "x-api-key",
        responsesProfile: "mimo-subset-2026-07-30", responsesTransport: "http",
      });
      await expect(adapter.complete(request())).resolves.toMatchObject({ content: "ok" });
      expect(headers.get("x-api-key")).toBe("test-key");
      expect(headers.has("authorization")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects x-api-key outside the MiMo profile before network I/O", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch;
    try {
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "openai", baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.2-codex", apiKey: "test-key", authMethod: "x-api-key",
        responsesProfile: "openai-public", responsesTransport: "http",
      });
      await expect(adapter.complete(request())).rejects.toThrow(
        "x-api-key authentication requires mimo-subset-2026-07-30",
      );
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects unsupported DeepSeek models before network I/O", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch;
    try {
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "deepseek", baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat", apiKey: "test-key", responsesProfile: "deepseek-subset-2026-07-31",
        responsesTransport: "http",
      });
      await expect(adapter.complete({
        ...request(), model: { provider: "deepseek", model: "deepseek-chat" },
      })).rejects.toThrow("currently supports only deepseek-v4-flash and deepseek-v4-pro");
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("admits deepseek-v4-pro through the adapter pre-network check", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return Response.json({
        id: "resp_deepseek", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      });
    }) as unknown as typeof fetch;
    try {
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "deepseek", baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-v4-pro", apiKey: "test-key", responsesProfile: "deepseek-subset-2026-07-31",
        responsesTransport: "http",
      });
      await expect(adapter.complete(request())).resolves.toMatchObject({ content: "ok" });
      expect(fetches).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  test("retries response.failed server errors but not the frozen fatal codes", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      if (fetches === 1) return responseStream([
        event(0, "response.failed", { response: {
          id: "resp_failed", status: "failed",
          error: { code: "server_error", message: "The model failed to generate a response." },
        } }),
      ]);
      return responseStream([
        event(0, "response.completed", { response: {
          id: "resp_recovered", status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "recovered" }] }],
        } }),
      ]);
    }) as unknown as typeof fetch;
    try {
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "openai", baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.2-codex", apiKey: "test-key", responsesProfile: "openai-public",
      }, { retryDelay: async () => undefined });
      await expect(collect(adapter.stream!(request()))).resolves.toMatchObject([
        { type: "attempt_started", attempt: 1 },
        { type: "attempt_discarded", attempt: 1 },
        { type: "attempt_started", attempt: 2 },
        { type: "complete", attempt: 2, response: { content: "recovered" } },
      ]);
      expect(fetches).toBe(2);

      for (const code of [
        "context_length_exceeded",
        "insufficient_quota",
        "usage_not_included",
        "cyber_policy",
        "invalid_prompt",
        "bio_policy",
      ]) {
        fetches = 0;
        globalThis.fetch = (async () => {
          fetches += 1;
          return responseStream([
            event(0, "response.failed", { response: {
              id: `resp_fatal_${code}`, status: "failed",
              error: { code, message: `fatal ${code}` },
            } }),
          ]);
        }) as unknown as typeof fetch;
        await expect(collect(adapter.stream!(request()))).rejects.toThrow(`fatal ${code}`);
        expect(fetches).toBe(1);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back to the portable projection when native compact state is rejected", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<{ input?: unknown[] }> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { input?: unknown[] });
      if (bodies.length === 1) {
        return Response.json({ error: { message: "expired compact state" } }, { status: 400 });
      }
      return Response.json({
        id: "portable-recovery", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "recovered" }] }],
      });
    }) as unknown as typeof fetch;
    try {
      const compactedInput = [{ type: "compaction", encrypted_content: "expired" }];
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "openai", baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.2-codex", apiKey: "test-key", responsesProfile: "openai-public",
      });
      const events = await collect(adapter.stream!({
        ...request(),
        messages: [
          { role: "user", content: "[conversation summary]\nportable", kind: "compact-summary" },
          {
            role: "user", content: "", kind: PROVIDER_NATIVE_CHECKPOINT_KIND,
            providerState: {
              version: 1, protocol: "openai-responses", providerId: "openai", model: "gpt-5.2-codex",
              endpointFingerprint: responsesEndpointFingerprint("https://api.openai.com/v1"),
              payload: { version: 1, profile: "openai-public", compactedInput },
            },
          },
          { role: "user", content: "continue" },
        ],
      }));
      expect(events).toMatchObject([
        { type: "attempt_started", attempt: 1 },
        { type: "attempt_discarded", attempt: 1 },
        { type: "attempt_started", attempt: 2 },
        { type: "complete", attempt: 2, response: { content: "recovered" } },
      ]);
      expect(bodies.map((body) => body.input)).toEqual([
        [...compactedInput, { role: "user", content: "continue" }],
        [
          { role: "user", content: "[conversation summary]\nportable" },
          { role: "user", content: "continue" },
        ],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not retry a non-retryable failure when an incompatible native marker already selected portable history", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return Response.json({ error: { message: "bad portable request" } }, { status: 400 });
    }) as unknown as typeof fetch;
    try {
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "openai", baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.2-codex", apiKey: "test-key", responsesProfile: "openai-public",
      });
      await expect(adapter.complete({
        ...request(),
        messages: [
          { role: "user", content: "portable" },
          {
            role: "user", content: "", kind: PROVIDER_NATIVE_CHECKPOINT_KIND,
            providerState: {
              version: 1, protocol: "openai-responses", providerId: "openai", model: "different-model",
              endpointFingerprint: responsesEndpointFingerprint("https://api.openai.com/v1"),
              payload: { version: 1, compactedInput: [{ type: "compaction", encrypted_content: "other-owner" }] },
            },
          },
        ],
      })).rejects.toThrow("bad portable request");
      expect(fetches).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenAI Responses built-in web search", () => {
  test("declares the bare web_search tool only on admitting profiles", () => {
    const withTools = toResponsesBody({
      ...request(),
      messages: [{ role: "user", content: "hello" }],
      webSearch: true,
      tools: [{ type: "function", function: {
        name: "echo", description: "Echo", parameters: { type: "object" },
      } }],
    }, context(), false, "openai-public");
    expect(withTools.tools).toEqual([
      { type: "function", name: "echo", description: "Echo", parameters: { type: "object" } },
      { type: "web_search" },
    ]);

    const withoutFunctions = toResponsesBody({
      ...request(),
      messages: [{ role: "user", content: "hello" }],
      webSearch: true,
    }, context(), false, "deepseek-subset-2026-08-19");
    expect(withoutFunctions.tools).toEqual([{ type: "web_search" }]);
    expect(withoutFunctions.tool_choice).toBe("auto");

    for (const profile of ["codex-http-relay", "mimo-subset-2026-07-30", "deepseek-subset-2026-07-31"] as const) {
      const body = toResponsesBody({
        ...request(),
        messages: [{ role: "user", content: "hello" }],
        webSearch: true,
      }, context(), false, profile);
      expect(JSON.stringify(body.tools ?? null)).not.toContain("web_search");
    }

    const offByDefault = toResponsesBody({
      ...request(),
      messages: [{ role: "user", content: "hello" }],
    }, context(), false, "openai-public");
    expect(offByDefault.tools).toBeUndefined();
  });

  test("normalizes web_search_call Items and url_citation annotations into the report", () => {
    const response = responseFromResponsesBody({
      id: "resp_ws",
      status: "completed",
      output: [
        { type: "reasoning", summary: [] },
        { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "prism vesicle release" } },
        { id: "ws_2", type: "web_search_call", status: "completed", action: { type: "search", queries: ["second query"] } },
        {
          type: "message", role: "assistant",
          content: [{
            type: "output_text",
            text: "Cited answer.",
            annotations: [{
              type: "url_citation", url: "https://example.com/page", title: "Example Page", start_index: 2, end_index: 9,
            }],
          }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }, { ...streamContext(), profile: "openai-public" });

    expect(response.webSearch).toEqual({
      provider: "openai",
      queries: ["prism vesicle release", "second query"],
      citations: [{ url: "https://example.com/page", title: "Example Page", startIndex: 2, endIndex: 9 }],
      calls: [
        { id: "ws_1", status: "completed", action: { type: "search", query: "prism vesicle release" } },
        { id: "ws_2", status: "completed", action: { type: "search", queries: ["second query"] } },
      ],
    });
  });

  test("omits the report when no executed query is recoverable", () => {
    const response = responseFromResponsesBody({
      id: "resp_ws",
      status: "completed",
      output: [
        { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://example.com" } },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Opened the page." }] },
      ],
    }, { ...streamContext(), profile: "openai-public" });
    expect(response.webSearch).toBeUndefined();
  });

  test("admits search Items without citations on the dated DeepSeek subset profile", () => {
    const response = responseFromResponsesBody({
      id: "resp_ws",
      status: "completed",
      output: [
        { id: "ws_1", type: "web_search_call", status: "in_progress", action: { type: "search", queries: ["deepseek docs", "ws_call_id=call_00_x"] } },
        { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking" }], summary: [], encrypted_content: "bf0e4002-926f-4ae2-a45f-11880b95bfe4-0" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer without citations.", annotations: [] }] },
      ],
    }, { ...streamContext(), model: "deepseek-v4-pro", profile: "deepseek-subset-2026-08-19" });

    expect(response.webSearch).toEqual({
      provider: "openai",
      queries: ["deepseek docs"],
      calls: [{ id: "ws_1", status: "in_progress", action: { type: "search", queries: ["deepseek docs", "ws_call_id=call_00_x"] } }],
    });
  });

  test("keeps encrypted reasoning tokens fail-closed on frozen reasoning-text profiles", () => {
    const output = [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking" }], summary: [], encrypted_content: "token-1" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    ];
    for (const profile of ["mimo-subset-2026-07-30", "deepseek-subset-2026-07-31"] as const) {
      expect(() => responseFromResponsesBody({
        id: "resp_ws", status: "completed", output,
      }, { ...streamContext(), profile })).toThrow(/unsupported (MiMo|DeepSeek) reasoning content/);
    }
  });

  test("keeps frozen profiles fail-closed against search Items and events", async () => {
    const searchOutput = [
      { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "q" } },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    ];
    for (const profile of ["mimo-subset-2026-07-30", "deepseek-subset-2026-07-31"] as const) {
      expect(() => responseFromResponsesBody({
        id: "resp_ws", status: "completed", output: searchOutput,
      }, { ...streamContext(), profile })).toThrow("malformed web_search_call Item");
    }
    await expect(collect(readResponsesStream(responseStream([
      event(0, "response.created", { response: { id: "resp_ws" } }),
      event(1, "response.web_search_call.in_progress"),
      event(2, "response.completed", {
        response: { id: "resp_ws", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }] },
      }),
    ]), { ...streamContext(), profile: "codex-http-relay" }))).rejects.toThrow("Unsupported semantic Responses event");
  });

  test("commits the web search report only at response.completed", async () => {
    const events = await collect(readResponsesStream(responseStream([
      event(0, "response.created", { response: { id: "resp_ws" } }),
      event(1, "response.web_search_call.in_progress"),
      event(2, "response.web_search_call.searching"),
      event(3, "response.output_item.added", { output_index: 0, item: { id: "ws_1", type: "web_search_call", status: "searching", action: { type: "search", query: "streamed query" } } }),
      event(4, "response.web_search_call.completed"),
      event(5, "response.completed", {
        response: {
          id: "resp_ws", status: "completed",
          output: [
            { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "streamed query" } },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "grounded answer" }] },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      }),
    ]), { ...streamContext(), profile: "openai-public" }));

    const completed = events.find((item) => item.type === "complete");
    expect(completed?.type).toBe("complete");
    if (completed?.type !== "complete") throw new Error("unreachable");
    expect(completed.response.webSearch).toMatchObject({ queries: ["streamed query"], calls: [{ id: "ws_1" }] });
  });

  test("replays portable web search calls ahead of the assistant content", () => {
    const messages = [
      { role: "user" as const, content: "search please" },
      {
        role: "assistant" as const,
        content: "Grounded answer.",
        webSearch: {
          provider: "openai",
          queries: ["replayed query"],
          calls: [{ id: "ws_1", status: "completed", action: { type: "search", query: "replayed query" } }],
        },
      },
      { role: "user" as const, content: "follow-up" },
    ];
    const input = toResponsesBody({ ...request(), messages }, context(), false, "openai-public").input as Array<Record<string, unknown>>;
    const callIndex = input.findIndex((item) => item.type === "web_search_call");
    const assistantIndex = input.findIndex((item) => item.role === "assistant");
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThan(callIndex);
    expect(input[callIndex]).toEqual({ type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "replayed query" } });

    const dropped = toResponsesBody({ ...request(), messages }, context(), false, "deepseek-subset-2026-07-31").input as Array<Record<string, unknown>>;
    expect(dropped.some((item) => item.type === "web_search_call")).toBe(false);
  });

  test("replays native state including web_search_call Items for the same owner", () => {
    const native: ProviderStateEnvelope = {
      version: providerStateEnvelopeVersion,
      protocol: "openai-responses",
      providerId: "openai",
      model: "gpt-5.2-codex",
      endpointFingerprint: responsesEndpointFingerprint("https://api.openai.com/v1"),
      payload: {
        version: 1,
        profile: "openai-public",
        responseId: "resp_ws",
        outputItems: [
          { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "native query" } },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Native answer." }] },
        ],
      },
    };
    const input = toResponsesBody({
      ...request(),
      messages: [{ role: "assistant", content: "", providerState: native }, { role: "user", content: "next" }],
    }, context(), false, "openai-public").input as Array<Record<string, unknown>>;
    expect(input.some((item) => item.type === "web_search_call" && item.id === "ws_1")).toBe(true);
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
