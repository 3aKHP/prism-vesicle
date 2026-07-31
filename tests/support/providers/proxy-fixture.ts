/**
 * Reusable local proxy-boundary fixture with REAL sockets: an authenticating
 * HTTP CONNECT proxy (node:http `connect`) that tunnels to a loopback TLS HTTP
 * origin (Bun.serve), against the synthetic non-routable host `provider.test`.
 *
 * The client is always Bun's real `fetch`/`WebSocket` crossing the proxy. A mock
 * that only asserts a `proxy` option exists is explicitly insufficient
 * (`dev/docs/working/ISSUE_150_PROVIDER_PROXY_IMPLEMENTATION_PLAN.md` §10/§15).
 *
 * Trust is test-only: the fixture CA (`tests/fixtures/proxy/ca.crt`) is passed
 * via the test-only `tlsCa` escape hatch on `fetchProvider` (and `tls:{ca}` for
 * direct WebSocket), never weakening production TLS defaults.
 */
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const CERT_DIR = join(FIXTURE_DIR, "..", "..", "fixtures", "proxy");

export type ProxyFixtureObserver = {
  connects: number;
  events: { authPresent: boolean; authValid: boolean }[];
  reset(): void;
};

export type ProxyFixture = {
  /** Proxy URL with valid Basic credentials. */
  proxyUrl: string;
  /** Same proxy, wrong credentials (407). */
  badAuthProxyUrl: string;
  /** Same proxy, no credentials (407). */
  noAuthProxyUrl: string;
  /** Test-only CA PEM for the `tlsCa` / `tls:{ca}` escape hatch. */
  ca: string;
  observer: ProxyFixtureObserver;
  /** Stop proxy and origin servers. */
  stop(): void;
};

export async function startProxyFixture(): Promise<ProxyFixture> {
  const leafCert = readFileSync(join(CERT_DIR, "leaf.crt"), "utf8");
  const leafKey = readFileSync(join(CERT_DIR, "leaf.key"), "utf8");
  const ca = readFileSync(join(CERT_DIR, "ca.crt"), "utf8");
  const goodAuth = "Basic " + Buffer.from("proxy-user:proxy-pass").toString("base64");

  const origin = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: leafCert, key: leafKey },
    fetch: (req, server) => {
      const url = new URL(req.url);
      // Native Responses WebSocket endpoint: upgrade and speak a minimal
      // response.create -> response.completed exchange so the Vesicle WS session
      // can complete a real request through the proxy tunnel.
      if (url.pathname.endsWith("/responses") && server.upgrade(req)) return;
      if (url.pathname === "/json") return Response.json({ ok: true, echo: url.searchParams.get("echo") ?? "" });
      if (url.pathname === "/sse") {
        const body = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            ctrl.enqueue(enc.encode("data: {\"t\":\"a\"}\n\n"));
            ctrl.enqueue(enc.encode("data: {\"t\":\"b\"}\n\n"));
            ctrl.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("ok", { status: 200 });
    },
    websocket: {
      message(ws) {
        // Echo a terminal Responses event so `responsesWebSocketSession.request` resolves.
        ws.send(JSON.stringify({ type: "response.completed", response: { id: "resp_fixture" } }));
      },
    },
  });
  const tlsPort = origin.port;
  if (tlsPort === undefined) throw new Error("proxy fixture origin did not bind a port");

  const observer: ProxyFixtureObserver = {
    connects: 0,
    events: [],
    reset() { this.connects = 0; this.events = []; },
  };

  const proxy = http.createServer();
  proxy.on("connect", (req, clientSocket, head) => {
    const auth = req.headers["proxy-authorization"] ?? null;
    const authValid = auth === goodAuth;
    observer.connects += 1;
    observer.events.push({ authPresent: !!auth, authValid });
    if (!authValid) {
      clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"probe\"\r\nContent-Length: 0\r\n\r\n");
      clientSocket.end();
      return;
    }
    const upstream = net.connect(tlsPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const addr = proxy.address();
  if (!addr || typeof addr === "string") throw new Error("proxy fixture proxy did not bind a port");
  const port = addr.port;

  return {
    proxyUrl: `http://proxy-user:proxy-pass@127.0.0.1:${port}`,
    badAuthProxyUrl: `http://bad-user:bad-pass@127.0.0.1:${port}`,
    noAuthProxyUrl: `http://127.0.0.1:${port}`,
    ca,
    observer,
    stop() {
      origin.stop?.();
      proxy.close();
    },
  };
}
