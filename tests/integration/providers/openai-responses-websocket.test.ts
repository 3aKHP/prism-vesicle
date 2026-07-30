import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import type { VesicleConfig } from "../../../src/config/env";
import { bootstrapTurn } from "../../../src/core/agent-loop/turn-bootstrap";
import { runLoop } from "../../../src/core/agent-loop/turn-loop";
import { OpenAIResponsesAdapter } from "../../../src/providers/openai-responses/adapter";
import { responsesEndpointFingerprint } from "../../../src/providers/openai-responses/owner";
import { toResponsesWebSocketMessage } from "../../../src/providers/openai-responses/request";
import { readResponsesStream } from "../../../src/providers/openai-responses/stream";
import type { ResponsesSocket, ResponsesSocketFactory } from "../../../src/providers/openai-responses/websocket";
import {
  closeAllResponsesWebSocketSessions,
  resetResponsesWebSocketSessionsForTest,
  responsesWebSocketSession,
  responsesWebSocketUrl,
} from "../../../src/providers/openai-responses/websocket";
import type { ProviderStreamEvent, VesicleRequest, VesicleResponse } from "../../../src/providers/shared/types";
import { bytesFromChunks } from "../../support/providers/sse";
import captures from "../../fixtures/openai-responses/request-captures-v1.json";
import eventCaptures from "../../fixtures/openai-responses/event-captures-v1.json";
import { compareStructuredCapture, requireJsonValue } from "../../support/providers/responses-conformance";
import {
  configureTestProviderEnv,
  createPromptRoot,
  restoreAgentLoopTestState,
} from "../agent-loop/fixtures/agent-loop";

afterEach(() => resetResponsesWebSocketSessionsForTest());

describe("OpenAI Responses WebSocket transport", () => {
  test("matches the frozen public, Codex-beta, and prewarm request captures", () => {
    const context = {
      providerId: "openai",
      endpointFingerprint: responsesEndpointFingerprint("https://api.openai.com/v1"),
    };
    const fixtureRequest: VesicleRequest = {
      id: "<dynamic:prompt-cache-key>",
      model: { provider: "openai", model: "gpt-5.6" },
      system: ["fixture instructions"],
      messages: [{ role: "user", content: "incremental fixture prompt" }],
      tools: [{ type: "function", function: {
        name: "read_fixture", description: "Read fixture data",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      } }],
      generation: { reasoningTier: "high" },
    };
    const continuation = {
      responseId: "<dynamic:response-id>", afterMessageIndex: 0, pendingCallIds: [],
    };
    const cases = [
      {
        id: "openai-public-ws-generate",
        actual: toResponsesWebSocketMessage(fixtureRequest, context, continuation, true, "openai-public"),
      },
      {
        id: "codex-beta-ws-generate",
        actual: toResponsesWebSocketMessage(fixtureRequest, context, continuation, true, "codex-beta-2026-02-06"),
      },
      {
        id: "openai-public-ws-prewarm",
        actual: toResponsesWebSocketMessage({
          ...fixtureRequest,
          messages: [{ role: "user", content: "fixture prompt" }],
        }, context, undefined, false, "openai-public"),
      },
    ];
    for (const fixtureCase of cases) {
      const expected = captures.captures.find((capture) => capture.id === fixtureCase.id);
      if (!expected) throw new Error(`Missing frozen capture ${fixtureCase.id}.`);
      expect(compareStructuredCapture(
        requireJsonValue(expected.body),
        requireJsonValue(JSON.parse(JSON.stringify(fixtureCase.actual))),
      )).toEqual([]);
    }
  });

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
        socket.completed(payload.generate === false ? "warm_beta" : "resp_beta", payload.generate === false ? "" : "ok");
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
    await expect(pending).rejects.toThrow("connection closed before opening: provider owner changed");
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

  test("does not grant the HTTP downgrade a second retry budget", async () => {
    const originalFetch = globalThis.fetch;
    let sockets = 0;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response("fallback failed", { status: 500 });
    }) as unknown as typeof fetch;
    const events: ProviderStreamEvent[] = [];
    try {
      const adapter = websocketAdapter(() => {
        sockets += 1;
        return new FakeSocket((_message, socket) => socket.close());
      });
      await expect((async () => {
        for await (const item of adapter.stream(request([{ role: "user", content: "fallback failure" }]))) {
          events.push(item);
        }
      })()).rejects.toThrow("Provider request failed (500)");
      expect(sockets).toBe(6);
      expect(fetches).toBe(1);
      expect(events.filter((item) => item.type === "attempt_discarded")).toHaveLength(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects prewarm output instead of silently continuing from it", async () => {
    let sends = 0;
    const adapter = websocketAdapter(() => new FakeSocket((_message, socket) => {
      sends += 1;
      socket.terminal({
        id: "resp_bad_warm", status: "completed",
        output: [{ type: "function_call", call_id: "call_bad", name: "write_file", arguments: "{}" }],
      });
    }));

    await expect(complete(adapter, request([{ role: "user", content: "prewarm" }])))
      .rejects.toThrow("prewarm returned unexpected output Items");
    expect(sends).toBe(1);
  });

  test("normalizes the canonical event fixture identically over SSE and WebSocket", async () => {
    const capture = eventCaptures.captures.find((item) => item.id === "completed-function-call");
    if (!capture?.events) throw new Error("Missing completed function-call event capture.");
    const fixtureEvents = capture.events.map((item) => {
      const { sequence, ...rest } = item;
      return { sequence_number: sequence, ...rest };
    });
    const factory: ResponsesSocketFactory = () => new FakeSocket((message, socket) => {
      const payload = JSON.parse(message) as Record<string, unknown>;
      if (payload.generate === false) socket.completed("resp_fixture_warm");
      else for (const item of fixtureEvents) socket.message(item);
    });
    const wsEvents = await collect(websocketAdapter(factory).stream(request([{ role: "user", content: "fixture" }])));
    const sseEvents = await collect(readResponsesStream(responseStream(fixtureEvents), {
      requestId: "request-1", providerId: "openai", model: "gpt-5.6",
      endpointFingerprint: responsesEndpointFingerprint("https://api.openai.com/v1"),
      profile: "openai-public",
    }));

    expect(completedResponse(wsEvents)).toEqual(completedResponse(sseEvents));
  });

  test("completes a real Agent Loop WebSocket tool round on one socket", async () => {
    await configureTestProviderEnv();
    try {
      const rootDir = await createPromptRoot();
      let sockets = 0;
      const sent: Array<Record<string, unknown>> = [];
      const factory: ResponsesSocketFactory = () => {
        sockets += 1;
        return new FakeSocket((message, socket) => {
          const payload = JSON.parse(message) as Record<string, unknown>;
          sent.push(payload);
          if (payload.generate === false) return socket.completed("resp_agent_warm");
          if (sent.length === 2) {
            socket.terminal({
              id: "resp_agent_call", status: "completed",
              output: [{
                type: "function_call", call_id: "call_agent_write", name: "write_file",
                arguments: JSON.stringify({ path: "workspace/ws-agent.md", content: "written once" }),
              }],
            });
            return;
          }
          socket.terminal(responseBody("resp_agent_final", "done"));
        });
      };
      const bootstrapped = await bootstrapTurn({ input: "write once", rootDir });
      const adapter = new OpenAIResponsesAdapter({
        provider: "openai-responses", providerId: "test", baseUrl: "https://provider.test/v1",
        model: "test-model", apiKey: "test-key", responsesProfile: "openai-public",
        responsesTransport: "websocket",
      }, {
        sessionId: bootstrapped.session.sessionId,
        webSocketFactory: factory,
        retryDelay: async () => undefined,
      });
      const result = await runLoop({ ...bootstrapped, provider: adapter });

      expect(result.kind).toBe("complete");
      expect(sockets).toBe(1);
      expect(await readFile(join(rootDir, "workspace", "ws-agent.md"), "utf8")).toBe("written once");
      expect(sent[2]).toMatchObject({
        previous_response_id: "resp_agent_call",
        input: [{ type: "function_call_output", call_id: "call_agent_write" }],
      });
    } finally {
      await restoreAgentLoopTestState();
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
    const canceled = (async () => {
      for await (const item of websocketAdapter(factory).stream({
        ...request([{ role: "user", content: "abort" }]), signal: controller.signal,
      })) events.push(item);
    })();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError", message: "stop" });
    expect(sockets).toBe(1);
    expect(events).toEqual([]);
  });

  test("times out a socket that never sends a terminal event", async () => {
    const socket = new FakeSocket(() => undefined);
    const session = responsesWebSocketSession({
      ...sessionOptions("timeout", "owner", () => socket),
      requestTimeoutMs: 5,
    });

    await expect(session.request({ type: "response.create" })).rejects.toMatchObject({
      name: "ProviderError",
      retryable: true,
      message: "Responses WebSocket timed out before a terminal event.",
    });
    expect(socket.closeCount).toBe(1);
  });

  test("marks a session disabled after exhaustion as non-retryable", async () => {
    const session = responsesWebSocketSession(sessionOptions(
      "disabled", "owner", () => new FakeSocket(() => undefined),
    ));
    session.disable();

    await expect(session.request({ type: "response.create" })).rejects.toMatchObject({
      name: "ProviderError",
      retryable: false,
    });
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

  test("Bun's native client sends handshake headers without a cast", async () => {
    const handshake = { authorization: null as string | null };
    const server = Bun.serve({
      port: 0,
      fetch(requestValue, bunServer) {
        handshake.authorization = requestValue.headers.get("authorization");
        if (bunServer.upgrade(requestValue)) return undefined;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(socket) {
          socket.send(JSON.stringify(event(0, "response.completed", {
            response: responseBody("resp_native", "native"),
          })));
        },
      },
    });
    try {
      const session = responsesWebSocketSession({
        sessionId: "native", owner: "owner", baseUrl: `http://127.0.0.1:${server.port}/v1`,
        providerId: "openai", headers: { authorization: "Bearer native-key" },
      });
      await session.request({ type: "response.create" });
      expect(handshake.authorization).toBe("Bearer native-key");
    } finally {
      closeAllResponsesWebSocketSessions();
      server.stop(true);
    }
  });

  test("closes a failed opening socket even when it never emits close", async () => {
    const socket = new FakeSocket(() => undefined, false);
    const session = responsesWebSocketSession(sessionOptions("open-error", "owner", () => socket));
    const pending = session.request({ type: "response.create" });
    socket.error();

    await expect(pending).rejects.toThrow("connection failed before opening");
    expect(socket.closeCount).toBe(1);
  });

  test.skipIf(process.platform === "win32")("host SIGTERM cleanup releases an active native socket before exit", async () => {
    let opened!: () => void;
    const socketOpened = new Promise<void>((resolveOpen) => { opened = resolveOpen; });
    const server = Bun.serve({
      port: 0,
      fetch(requestValue, bunServer) {
        if (bunServer.upgrade(requestValue)) return undefined;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open() { opened(); },
        message() { /* Keep the request in flight until the process signal. */ },
      },
    });
    const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../../../src/providers/openai-responses/websocket.ts")).href;
    const lifecycleUrl = pathToFileURL(resolve(import.meta.dir, "../../../src/providers/lifecycle.ts")).href;
    const shutdownUrl = pathToFileURL(resolve(import.meta.dir, "../../../src/core/process/shutdown.ts")).href;
    const baseUrl = `http://127.0.0.1:${server.port}/v1`;
    const script = `import { responsesWebSocketSession } from ${JSON.stringify(moduleUrl)};\n`
      + `import { closeAllProviderSessions } from ${JSON.stringify(lifecycleUrl)};\n`
      + `import { installHostShutdownHooks, registerHostShutdownCleanup } from ${JSON.stringify(shutdownUrl)};\n`
      + "installHostShutdownHooks();\n"
      + "registerHostShutdownCleanup(async () => { await Bun.sleep(25); console.log(\"host-cleanup\"); throw new Error(\"expected cleanup failure\"); });\n"
      + "registerHostShutdownCleanup(() => { console.log(\"provider-cleanup\"); closeAllProviderSessions(); }, 100);\n"
      + `const session = responsesWebSocketSession({sessionId:"child",owner:"owner",baseUrl:${JSON.stringify(baseUrl)},providerId:"test",headers:{authorization:"Bearer test"}});\n`
      + "void session.request({type:\"response.create\"});";
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "ignore" });
    try {
      await Promise.race([
        socketOpened,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("child socket did not open")), 2_000)),
      ]);
      child.kill("SIGTERM");
      await expect(Promise.race([
        child.exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("child did not exit")), 2_000)),
      ])).resolves.toBe(143);
      expect(await new Response(child.stdout).text()).toContain("host-cleanup\nprovider-cleanup");
    } finally {
      child.kill("SIGKILL");
      server.stop(true);
    }
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

  error(): void {
    this.emit("error", {});
  }

  completed(id: string, text = "", sequence = 0): void {
    queueMicrotask(() => this.message(event(sequence, "response.completed", { response: responseBody(id, text) })));
  }

  terminal(body: Record<string, unknown>, sequence = 0): void {
    queueMicrotask(() => this.message(event(sequence, "response.completed", { response: body })));
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

function completedResponse(events: ProviderStreamEvent[]): VesicleResponse {
  const completed = [...events].reverse().find((item) => item.type === "complete");
  if (!completed || completed.type !== "complete") throw new Error("Missing completed response.");
  return completed.response;
}
