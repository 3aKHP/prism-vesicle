import { afterEach, describe, expect, test } from "bun:test";
import type { VesicleConfig } from "../../../src/config/env";
import { OpenAIResponsesAdapter } from "../../../src/providers/openai-responses/adapter";
import type { ResponsesSocket, ResponsesSocketFactory } from "../../../src/providers/openai-responses/websocket";
import {
  closeAllResponsesWebSocketSessions,
  resetResponsesWebSocketSessionsForTest,
  responsesWebSocketSession,
  responsesWebSocketUrl,
} from "../../../src/providers/openai-responses/websocket";
import type { ProviderStreamEvent, VesicleRequest, VesicleResponse } from "../../../src/providers/shared/types";
import { bytesFromChunks } from "../../support/providers/sse";

afterEach(() => resetResponsesWebSocketSessionsForTest());

describe("OpenAI Responses WebSocket transport", () => {
  test("prewarms once, reuses the session socket, and continues with only new input", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let sockets = 0;
    const factory: ResponsesSocketFactory = () => {
      sockets += 1;
      return new FakeSocket((message, socket) => {
        const payload = JSON.parse(message) as Record<string, unknown>;
        sent.push(payload);
        if (payload.generate === false) return socket.completed("resp_warm");
        socket.completed(`resp_${sent.length}`, `answer ${sent.length}`);
      });
    };
    const adapter = websocketAdapter(factory);
    const first = await complete(adapter, request([{ role: "user", content: "first" }]));
    const second = await complete(adapter, request([
      { role: "user", content: "first" },
      { role: "assistant", content: first.content, providerState: first.providerState },
      { role: "user", content: "second" },
    ], "request-2"));

    expect(sockets).toBe(1);
    expect(second.content).toBe("answer 3");
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({ generate: false, input: [{ role: "user", content: "first" }] });
    expect(sent[0]).not.toHaveProperty("stream");
    expect(sent[0]).not.toHaveProperty("background");
    expect(sent[1]).toMatchObject({ previous_response_id: "resp_warm", input: [] });
    expect(sent[1]).not.toHaveProperty("generate");
    expect(sent[2]).toMatchObject({ previous_response_id: "resp_2", input: [{ role: "user", content: "second" }] });
  });

  test("applies the frozen Codex beta header and WebSocket-only request shape", async () => {
    let headers: Record<string, string> | undefined;
    const sent: Array<Record<string, unknown>> = [];
    const factory: ResponsesSocketFactory = (_url, value) => {
      headers = value;
      return new FakeSocket((message, socket) => {
        const payload = JSON.parse(message) as Record<string, unknown>;
        sent.push(payload);
        socket.completed(payload.generate === false ? "warm_beta" : "resp_beta", "ok");
      });
    };
    const adapter = websocketAdapter(factory, { responsesProfile: "codex-beta-2026-02-06" });
    await complete(adapter, request([{ role: "user", content: "beta" }]));

    expect(headers).toMatchObject({
      authorization: "Bearer test-key",
      "openai-beta": "responses_websockets=2026-02-06",
    });
    expect(headers?.["user-agent"]).toStartWith("prism-vesicle/");
    expect(Object.keys(headers ?? {}).some((key) => key.startsWith("x-codex"))).toBe(false);
    expect(sent[1]).toMatchObject({ stream: true, stream_options: { include_obfuscation: false } });
    expect(sent[1]).not.toHaveProperty("background");
  });

  test("enforces one in-flight request and closes pending sockets on owner change", async () => {
    const sockets: FakeSocket[] = [];
    const factory: ResponsesSocketFactory = () => {
      const socket = new FakeSocket(() => undefined, false);
      sockets.push(socket);
      return socket;
    };
    const first = responsesWebSocketSession(sessionOptions("same", "owner-a", factory));
    const pending = first.request({ type: "response.create" });
    await expect(first.request({ type: "response.create" })).rejects.toThrow("only one in-flight");
    const second = responsesWebSocketSession(sessionOptions("same", "owner-b", factory));

    expect(second).not.toBe(first);
    expect(sockets[0].closeCount).toBe(1);
    await expect(pending).rejects.toThrow("connection failed before opening");
  });

  test("discards text and tool candidates from a broken attempt before retrying", async () => {
    let sockets = 0;
    const factory: ResponsesSocketFactory = () => {
      sockets += 1;
      const socketNumber = sockets;
      return new FakeSocket((message, socket) => {
        const payload = JSON.parse(message) as Record<string, unknown>;
        if (payload.generate === false) return socket.completed(`warm_${socketNumber}`);
        if (socketNumber === 1) {
          socket.message(event(0, "response.output_text.delta", { delta: "discarded" }));
          socket.message(event(1, "response.output_item.done", { item: {
            type: "function_call", call_id: "call_bad", name: "write_file", arguments: "{}",
          } }));
          socket.close();
          return;
        }
        socket.message(event(0, "response.output_text.delta", { delta: "committed" }));
        socket.completed("resp_ok", "committed", 1);
      });
    };
    const events = await collect(websocketAdapter(factory).stream(request([{ role: "user", content: "retry" }])));

    expect(sockets).toBe(2);
    expect(events).toEqual([
      { type: "attempt_started", attempt: 1 },
      { type: "attempt_discarded", attempt: 1 },
      { type: "attempt_started", attempt: 2 },
      { type: "content_delta", delta: "committed" },
      expect.objectContaining({ type: "complete", attempt: 2, response: expect.objectContaining({ content: "committed" }) }),
    ]);
    expect(events.some((item) => item.type === "tool_call_candidate")).toBe(false);
  });

  test("recovers previous_response_not_found by replaying full context on a new socket", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let sockets = 0;
    let rejectContinuation = true;
    const factory: ResponsesSocketFactory = () => {
      sockets += 1;
      return new FakeSocket((message, socket) => {
        const payload = JSON.parse(message) as Record<string, unknown>;
        sent.push(payload);
        if (payload.generate === false) return socket.completed(`warm_${sockets}`);
        if (payload.previous_response_id === "resp_first" && rejectContinuation) {
          rejectContinuation = false;
          socket.message({
            type: "error", status: 400,
            error: { code: "previous_response_not_found", message: "Previous response not found." },
          });
          return;
        }
        socket.completed(sent.length < 4 ? "resp_first" : "resp_recovered", "ok");
      });
    };
    const adapter = websocketAdapter(factory);
    const first = await complete(adapter, request([{ role: "user", content: "first" }]));
    const secondRequest = request([
      { role: "user", content: "first" },
      { role: "assistant", content: first.content, providerState: first.providerState },
      { role: "user", content: "second" },
    ], "request-2");
    await complete(adapter, secondRequest);

    expect(sockets).toBe(2);
    expect(sent[2]).toMatchObject({ previous_response_id: "resp_first", input: [{ role: "user", content: "second" }] });
    expect(sent[3]).toMatchObject({ generate: false });
    expect(sent[3].previous_response_id).toBeUndefined();
    expect(sent[3].input).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "first" }),
      expect.objectContaining({ role: "user", content: "second" }),
    ]));
    expect(sent[4]).toMatchObject({ previous_response_id: "warm_2", input: [] });
  });

  test("downgrades permanently to HTTP after five WebSocket retries", async () => {
    const originalFetch = globalThis.fetch;
    let sockets = 0;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return responseStream([event(0, "response.completed", { response: responseBody(`http_${fetches}`, "http") })]);
    }) as unknown as typeof fetch;
    try {
      const factory: ResponsesSocketFactory = () => {
        sockets += 1;
        return new FakeSocket((_message, socket) => socket.close());
      };
      const adapter = websocketAdapter(factory);
      const first = await collect(adapter.stream(request([{ role: "user", content: "fallback" }])));
      const second = await collect(adapter.stream(request([{ role: "user", content: "still-http" }], "request-2")));

      expect(sockets).toBe(6);
      expect(fetches).toBe(2);
      expect(first.filter((item) => item.type === "attempt_discarded")).toHaveLength(6);
      expect(first.at(-1)).toMatchObject({ type: "complete", attempt: 7, response: { content: "http" } });
      expect(second.at(-1)).toMatchObject({ type: "complete", attempt: 1, response: { content: "http" } });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("cancellation closes the socket without retrying", async () => {
    let sockets = 0;
    const controller = new AbortController();
    const factory: ResponsesSocketFactory = () => {
      sockets += 1;
      return new FakeSocket((message, socket) => {
        const payload = JSON.parse(message) as Record<string, unknown>;
        if (payload.generate === false) socket.completed("warm_abort");
        else queueMicrotask(() => controller.abort("stop"));
      });
    };
    const events: ProviderStreamEvent[] = [];
    await expect((async () => {
      for await (const item of websocketAdapter(factory).stream({
        ...request([{ role: "user", content: "abort" }]), signal: controller.signal,
      })) events.push(item);
    })()).rejects.toThrow("stop");
    expect(sockets).toBe(1);
    expect(events).toEqual([]);
  });

  test("derives the endpoint without query credentials and closes all sessions", async () => {
    expect(responsesWebSocketUrl("https://api.openai.com/v1")).toBe("wss://api.openai.com/v1/responses");
    expect(responsesWebSocketUrl("https://api.openai.com/v1/responses?secret=nope")).toBe("wss://api.openai.com/v1/responses");
    const sockets: FakeSocket[] = [];
    const factory: ResponsesSocketFactory = () => {
      const socket = new FakeSocket(() => undefined);
      sockets.push(socket);
      return socket;
    };
    const session = responsesWebSocketSession(sessionOptions("cleanup", "owner", factory));
    const pending = session.request({ type: "response.create" });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    closeAllResponsesWebSocketSessions();
    await expect(pending).rejects.toThrow("closed before a terminal event");
    expect(sockets[0].closeCount).toBe(1);
  });

  test("rotates before the 60-minute limit and clears connection-local continuation", async () => {
    let now = 1;
    const sockets: FakeSocket[] = [];
    const factory: ResponsesSocketFactory = () => {
      const socket = new FakeSocket((_message, current) => current.completed("resp_rotate"));
      sockets.push(socket);
      return socket;
    };
    const session = responsesWebSocketSession({
      ...sessionOptions("rotate", "owner", factory),
      now: () => now,
    });
    await session.request({ type: "response.create" });
    session.markCompleted("resp_rotate");
    now += 56 * 60 * 1_000;
    session.prepareForRequest();

    expect(sockets[0].closeCount).toBe(1);
    expect(session.lastResponseId).toBeUndefined();
    expect(session.needsPrewarm()).toBe(true);
  });
});

class FakeSocket implements ResponsesSocket {
  readyState = 0;
  closeCount = 0;
  private readonly listeners = new Map<string, Set<(event: Event & { data?: unknown }) => void>>();

  constructor(
    private readonly onSend: (message: string, socket: FakeSocket) => void,
    autoOpen = true,
  ) {
    if (autoOpen) queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  send(data: string): void {
    this.onSend(data, this);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.closeCount += 1;
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: string, listener: (event: Event & { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event & { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  message(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  completed(id: string, text = "", sequence = 0): void {
    queueMicrotask(() => this.message(event(sequence, "response.completed", { response: responseBody(id, text) })));
  }

  private emit(type: string, eventValue: { data?: unknown }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(eventValue as Event & { data?: unknown });
  }
}

function websocketAdapter(
  factory: ResponsesSocketFactory,
  overrides: Partial<VesicleConfig> = {},
): OpenAIResponsesAdapter {
  return new OpenAIResponsesAdapter({ ...config(), ...overrides }, {
    sessionId: "session-ws",
    webSocketFactory: factory,
    retryDelay: async () => undefined,
  });
}

function config() {
  return {
    provider: "openai-responses" as const,
    providerId: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6",
    apiKey: "test-key",
    responsesProfile: "openai-public" as const,
    responsesTransport: "websocket" as const,
  };
}

function sessionOptions(sessionId: string, owner: string, factory: ResponsesSocketFactory) {
  return {
    sessionId, owner, baseUrl: "https://api.openai.com/v1", providerId: "openai",
    headers: { authorization: "Bearer key" }, factory,
  };
}

function request(messages: VesicleRequest["messages"], id = "request-1"): VesicleRequest {
  return { id, model: { provider: "openai", model: "gpt-5.6" }, system: ["system"], messages };
}

function event(sequence: number, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, sequence_number: sequence, ...extra };
}

function responseBody(id: string, text: string) {
  return {
    id, status: "completed",
    output: text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] : [],
  };
}

function responseStream(events: unknown[]): Response {
  return new Response(bytesFromChunks(events.map((item) => `data: ${JSON.stringify(item)}\n\n`)), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(iterable: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const result: ProviderStreamEvent[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

async function complete(adapter: OpenAIResponsesAdapter, input: VesicleRequest): Promise<VesicleResponse> {
  const events = await collect(adapter.stream(input));
  const completed = [...events].reverse().find((eventValue) => eventValue.type === "complete");
  if (!completed || completed.type !== "complete") throw new Error("Missing completed response.");
  return completed.response;
}
