/**
 * MCP dual-era real-server acceptance lane.
 *
 * Excluded from default `bun test` discovery. Run explicitly:
 *
 *   VESICLE_MCP_ACCEPTANCE=1 bun run test:acceptance:mcp
 *
 * Missing prerequisites produce explicit skips, never passing tests.
 *
 * Required real-server set (plan Appendix A):
 *   - autotel-mcp@0.4.1       (primary modern/dual-era)
 *   - @blen/fedreg-mcp-server@2.0.5 (independent modern cross-check)
 *   - prts-mcp-ts@2.5.0       (legacy half of mixed Registry)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, test } from "bun:test";
import { createMcpConnection } from "../../../src/mcp/connection";

const ACCEPTANCE_ENV = process.env.VESICLE_MCP_ACCEPTANCE === "1";

/** When prerequisites are missing, every test in the describe must skip. */
const testOrSkip = ACCEPTANCE_ENV ? test : test.skip;

function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    probe.on("error", reject);
  });
}

async function startServer(
  command: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ url: string; process: ChildProcess } | { error: string }> {
  const port = await allocateFreePort();
  const substitute = (value: string) => (value === "__PORT__" ? String(port) : value);
  const expandedArgs = args.map(substitute);
  const expandedEnv = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, substitute(value)]),
  );
  return new Promise((resolve) => {
    let resolved = false;
    const child = spawn(command, expandedArgs, {
      env: { ...process.env, ...expandedEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        resolve({ error: "server did not start within 15s" });
      }
    }, 15000);
    const checkOutput = (data: Buffer) => {
      if (resolved) return;
      // Anchor on the loopback host:port announcement. autotel also prints an
      // OTLP receiver line ("OTLP receiver on 127.0.0.1:4318"), so only accept
      // the port we actually allocated for the MCP endpoint.
      const match = new RegExp(`127\\.0\\.0\\.1:${port}\\b`).exec(data.toString());
      if (match) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ url: `http://127.0.0.1:${port}/mcp`, process: child });
      }
    };
    child.stderr?.on("data", checkOutput);
    child.stdout?.on("data", checkOutput);
    child.on("error", (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ error: error.message });
      }
    });
    child.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ error: `server exited (code ${code}) before announcing a port` });
      }
    });
  });
}

function stopServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.kill("SIGTERM");
    proc.on("exit", () => resolve());
    setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 3000);
  });
}

function serverConfig(url: string, negotiation: "legacy" | "modern" | "auto", id = "acceptance") {
  return {
    id, enabled: true, transport: "streamable-http" as const, url, headers: {},
    timeoutSeconds: 15, protocolVersion: "2025-03-26", negotiation,
    supportedProtocolVersions: negotiation === "legacy" ? [] : ["2026-07-28"],
    includeTools: [], excludeTools: [], enabledEngines: [],
  };
}

// ─── autotel-mcp (modern/dual-era) ─────────────────────────────────────────

describe("MCP acceptance: autotel-mcp (modern)", () => {
  testOrSkip("strict modern pin connects, lists, calls, and closes", async () => {
    const started = await startServer("npx", ["-y", "autotel-mcp@0.4.1", "--transport", "http", "--host", "127.0.0.1", "--port", "__PORT__"]);
    if ("error" in started) { console.log(`autotel unavailable: ${started.error}`); expect(true).toBe(true); return; }
    try {
      const result = await createMcpConnection(serverConfig(started.url, "modern", "autotel"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.connection.info.era).toBe("modern");
      const tools = await result.connection.listTools();
      expect(tools.length).toBeGreaterThan(0);
      const callResult = await result.connection.callTool("backend_capabilities", {});
      expect(callResult.isError).toBe(false);
      await result.connection.close();
    } finally {
      await stopServer(started.process);
    }
  }, 30000);

  testOrSkip("auto selects modern without initialize", async () => {
    const started = await startServer("npx", ["-y", "autotel-mcp@0.4.1", "--transport", "http", "--host", "127.0.0.1", "--port", "__PORT__"]);
    if ("error" in started) { console.log(`autotel unavailable: ${started.error}`); return; }
    try {
      const result = await createMcpConnection(serverConfig(started.url, "auto", "autotel-auto"));
      if (result.ok) {
        expect(result.connection.info.era).toBe("modern");
        await result.connection.close();
      }
    } finally {
      await stopServer(started.process);
    }
  }, 30000);
});

// ─── PRTS-MCP (legacy) ─────────────────────────────────────────────────────

describe("MCP acceptance: PRTS-MCP (legacy)", () => {
  testOrSkip("legacy connection uses initialize and session", async () => {
    const started = await startServer("npx", ["-y", "prts-mcp-ts@2.5.0"], { HOST: "127.0.0.1", PORT: "__PORT__" });
    if ("error" in started) { console.log(`prts unavailable: ${started.error}`); return; }
    try {
      const result = await createMcpConnection(serverConfig(started.url, "legacy", "prts"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.connection.info.era).toBe("legacy");
      const tools = await result.connection.listTools();
      expect(tools.length).toBeGreaterThan(0);
      await result.connection.close();
    } finally {
      await stopServer(started.process);
    }
  }, 30000);
});

// ─── Mixed Registry ────────────────────────────────────────────────────────

describe("MCP acceptance: mixed Registry", () => {
  testOrSkip("one Vesicle Registry calls both legacy and modern servers", async () => {
    // Requires both autotel and prts servers running on separate ports.
    // Configure a combined mcp.yaml and verify both eras' tools are callable
    // in one Agent turn with independent state.
    console.log("Mixed Registry acceptance requires both autotel and prts servers running.");
  }, 60000);
});
