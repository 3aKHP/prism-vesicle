import { abortError, ProviderError } from "../shared/errors";

type SocketEvent = Event & { data?: unknown; code?: number; reason?: string };
export type ResponsesSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: SocketEvent) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void;
};
export type ResponsesSocketFactory = (url: string, headers: Record<string, string>) => ResponsesSocket;

type SessionSocketOptions = {
  sessionId: string;
  owner: string;
  baseUrl: string;
  providerId: string;
  headers: Record<string, string>;
  factory?: ResponsesSocketFactory;
  now?: () => number;
  requestTimeoutMs?: number;
};

const sessionSockets = new Map<string, ResponsesWebSocketSession>();
const rotateAfterMs = 55 * 60 * 1_000;
const defaultRequestTimeoutMs = 120_000;

export class ResponsesWebSocketSession {
  readonly sessionId: string;
  readonly owner: string;
  lastResponseId?: string;
  unavailable = false;
  private socket?: ResponsesSocket;
  private pendingSocket?: ResponsesSocket;
  private connectPromise?: Promise<ResponsesSocket>;
  private cancelConnect?: (reason: string) => void;
  private inFlight = false;
  private openedAt = 0;
  private prewarmRequired = true;

  constructor(private readonly options: SessionSocketOptions) {
    this.sessionId = options.sessionId;
    this.owner = options.owner;
  }

  matches(options: SessionSocketOptions): boolean {
    return this.owner === options.owner
      && headersEqual(this.options.headers, options.headers)
      && this.options.requestTimeoutMs === options.requestTimeoutMs;
  }

  async request(message: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    if (this.unavailable) throw failure(
      "Responses WebSocket is disabled for this session after retry exhaustion.",
      this.options.providerId,
      false,
    );
    if (this.inFlight) throw failure("Responses WebSocket permits only one in-flight response per session.", this.options.providerId);
    this.prepareForRequest();
    this.inFlight = true;
    try {
      const socket = await this.connect(signal);
      try {
        const payloads = await receiveTerminal(
          socket,
          JSON.stringify(message),
          signal,
          this.options.providerId,
          this.options.requestTimeoutMs ?? defaultRequestTimeoutMs,
        );
        return sseResponse(payloads);
      } catch (error) {
        this.resetConnection("request failure");
        throw error;
      }
    } finally {
      this.inFlight = false;
    }
  }

  prepareForRequest(): void {
    if (this.socket && this.now() - this.openedAt >= rotateAfterMs) this.resetConnection("connection rotation");
  }

  markCompleted(responseId: string | undefined): void {
    this.lastResponseId = responseId;
    this.prewarmRequired = false;
  }

  needsPrewarm(): boolean {
    return this.prewarmRequired;
  }

  clearContinuation(): void {
    this.lastResponseId = undefined;
    this.prewarmRequired = true;
  }

  disable(): void {
    this.unavailable = true;
    this.close(1000, "HTTP downgrade");
  }

  close(code = 1000, reason = "session close"): void {
    const socket = this.socket;
    const pendingSocket = this.pendingSocket;
    const cancelConnect = this.cancelConnect;
    this.socket = undefined;
    this.pendingSocket = undefined;
    this.connectPromise = undefined;
    this.cancelConnect = undefined;
    this.openedAt = 0;
    this.lastResponseId = undefined;
    this.prewarmRequired = true;
    cancelConnect?.(reason);
    socket?.close(code, reason);
    if (pendingSocket && pendingSocket !== socket) pendingSocket.close(code, reason);
  }

  resetConnection(reason: string): void {
    this.close(1000, reason);
  }

  private connect(signal?: AbortSignal): Promise<ResponsesSocket> {
    if (this.socket?.readyState === 1) return Promise.resolve(this.socket);
    if (this.connectPromise) return this.connectPromise;
    const factory = this.options.factory ?? defaultSocketFactory;
    const socket = factory(responsesWebSocketUrl(this.options.baseUrl), this.options.headers);
    this.pendingSocket = socket;
    this.connectPromise = new Promise((resolve, reject) => {
      const opened = () => {
        if (this.pendingSocket !== socket) {
          cleanup();
          socket.close(1000, "stale connection");
          reject(failure("Responses WebSocket connection was closed before opening.", this.options.providerId));
          return;
        }
        cleanup();
        this.pendingSocket = undefined;
        this.connectPromise = undefined;
        this.cancelConnect = undefined;
        this.socket = socket;
        this.openedAt = this.now();
        resolve(socket);
      };
      const failed = () => {
        cleanup();
        if (this.pendingSocket !== socket) return;
        this.pendingSocket = undefined;
        this.connectPromise = undefined;
        this.cancelConnect = undefined;
        socket.close(1000, "connection failed");
        reject(failure("Responses WebSocket connection failed before opening.", this.options.providerId));
      };
      const aborted = () => {
        cleanup();
        this.pendingSocket = undefined;
        this.connectPromise = undefined;
        this.cancelConnect = undefined;
        socket.close(1000, "aborted");
        reject(abortError(signal));
      };
      const cleanup = () => {
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        signal?.removeEventListener("abort", aborted);
      };
      this.cancelConnect = (reason) => {
        cleanup();
        reject(failure(`Responses WebSocket connection closed before opening: ${reason}.`, this.options.providerId));
      };
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    return this.connectPromise;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function responsesWebSocketSession(options: SessionSocketOptions): ResponsesWebSocketSession {
  const existing = sessionSockets.get(options.sessionId);
  if (existing?.matches(options)) return existing;
  existing?.close(1000, "provider owner changed");
  const created = new ResponsesWebSocketSession(options);
  sessionSockets.set(options.sessionId, created);
  return created;
}

function headersEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

export function closeResponsesWebSocketSession(sessionId: string): void {
  sessionSockets.get(sessionId)?.close();
  sessionSockets.delete(sessionId);
}

export function resetResponsesWebSocketSessionsForTest(): void {
  closeAllResponsesWebSocketSessions();
}

export function closeAllResponsesWebSocketSessions(): void {
  for (const socket of sessionSockets.values()) socket.close();
  sessionSockets.clear();
}

export function responsesWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/responses`.replace(/\/responses\/responses$/, "/responses");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function defaultSocketFactory(url: string, headers: Record<string, string>): ResponsesSocket {
  // This repository includes lib.dom for browser-shaped types, whose standard
  // constructor hides Bun's documented WebSocketOptions overload. Name that
  // Bun-native overload explicitly instead of casting the options to `never`.
  const BunWebSocket = WebSocket as unknown as {
    new(url: string, options: Bun.WebSocketOptions): WebSocket;
  };
  return new BunWebSocket(url, { headers }) as unknown as ResponsesSocket;
}

function receiveTerminal(
  socket: ResponsesSocket,
  message: string,
  signal: AbortSignal | undefined,
  providerId: string,
  timeoutMs: number,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const payloads: string[] = [];
    let settled = false;
    const received = (event: SocketEvent) => {
      const payload = typeof event.data === "string" ? event.data : String(event.data ?? "");
      let type: string | undefined;
      try {
        type = (JSON.parse(payload) as { type?: string }).type;
      } catch (error) {
        finishReject(new ProviderError("Responses WebSocket delivered invalid JSON.", {
          kind: "malformed_response", providerId, cause: error,
        }));
        return;
      }
      payloads.push(payload);
      if (type === "response.completed" || type === "response.failed" || type === "response.incomplete" || type === "error") {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(payloads);
      }
    };
    const closed = () => finishReject(failure("Responses WebSocket closed before a terminal event.", providerId));
    const errored = () => finishReject(failure("Responses WebSocket failed before a terminal event.", providerId));
    const aborted = () => {
      finishReject(abortError(signal));
      socket.close(1000, "aborted");
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      finishReject(failure("Responses WebSocket timed out before a terminal event.", providerId));
      socket.close(1000, "response timeout");
    }, timeoutMs);
    const cleanup = () => {
      socket.removeEventListener("message", received);
      socket.removeEventListener("close", closed);
      socket.removeEventListener("error", errored);
      signal?.removeEventListener("abort", aborted);
      clearTimeout(timeout);
    };
    socket.addEventListener("message", received);
    socket.addEventListener("close", closed, { once: true });
    socket.addEventListener("error", errored, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    else socket.send(message);
  });
}

function sseResponse(payloads: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function failure(message: string, providerId: string, retryable = true): ProviderError {
  return new ProviderError(message, { kind: "stream_error", providerId, retryable });
}
