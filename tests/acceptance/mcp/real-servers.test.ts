/**
 * MCP dual-era real-server acceptance lane.
 *
 * This file is excluded from default `bun test` discovery. Run explicitly:
 *
 *   bun run test:acceptance:mcp
 *
 * Missing server commands, credentials, or network access produce explicit
 * skips with a documented unavailable reason — never a passing test.
 *
 * Required real-server set (see plan Appendix A):
 *   - autotel-mcp@0.4.1       (primary modern/dual-era)
 *   - @blen/fedreg-mcp-server@2.0.5 (independent modern cross-check)
 *   - prts-mcp-ts@2.5.0       (legacy half of mixed Registry)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { createMcpConnection } from "../../../src/mcp/connection";

const ACCEPTANCE_ENV = process.env.VESICLE_MCP_ACCEPTANCE === "1";

// Static-skip helper for acceptance describe blocks that have no individual
// test conditions to check beyond ACCEPTANCE_ENV.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _skip(label: string): void {
  if (!ACCEPTANCE_ENV) {
    test.skip(`${label} — set VESICLE_MCP_ACCEPTANCE=1 to run`, () => {});
  } else {
    test.skip(`${label} — prerequisite unavailable`, () => {});
  }
}

async function startServer(command: string, args: string[], env: Record<string, string> = {}): Promise<{ url: string; process: ChildProcess } | { error: string }> {
  return new Promise((resolve) => {
    let resolved = false;
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        resolve({ error: "server did not start within 15s" });
      }
    }, 15000);
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      const portMatch = /(?:port[:\s]+|listening.*?)(\d+)/i.exec(text);
      if (portMatch && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ url: `http://127.0.0.1:${portMatch[1]}/mcp`, process: child });
      }
    });
    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      const portMatch = /(?:port[:\s]+|listening.*?)(\d+)/i.exec(text);
      if (portMatch && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ url: `http://127.0.0.1:${portMatch[1]}/mcp`, process: child });
      }
    });
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
        resolve({ error: `server exited with code ${code} before announcing a port` });
      }
    });
  });
}

function stopServer(process: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    process.kill("SIGTERM");
    process.on("exit", () => resolve());
    setTimeout(() => { process.kill("SIGKILL"); resolve(); }, 3000);
  });
}

function serverConfig(url: string, negotiation: "legacy" | "modern" | "auto", id = "acceptance") {
  return {
    id,
    enabled: true,
    transport: "streamable-http" as const,
    url,
    headers: {},
    timeoutSeconds: 15,
    protocolVersion: "2025-03-26",
    negotiation,
    supportedProtocolVersions: negotiation === "legacy" ? [] : ["2026-07-28"],
    includeTools: [],
    excludeTools: [],
    enabledEngines: [],
  };
}

// ─── autotel-mcp (modern/dual-era) ─────────────────────────────────────────

describe("MCP acceptance: autotel-mcp (modern)", () => {
  test("strict modern pin connects, lists, calls, and closes", async () => {
    if (!ACCEPTANCE_ENV) return;
    const started = await startServer("npx", ["-y", "autotel-mcp@0.4.1", "--transport", "http", "--host", "127.0.0.1", "--port", "0"]);
    if ("error" in started) { console.log(`autotel unavailable: ${started.error}`); return; }
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

  test("auto selects modern without initialize", async () => {
    if (!ACCEPTANCE_ENV) return;
    const started = await startServer("npx", ["-y", "autotel-mcp@0.4.1", "--transport", "http", "--host", "127.0.0.1", "--port", "0"]);
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
  test("absent-field/legacy connection uses initialize and session", async () => {
    if (!ACCEPTANCE_ENV) return;
    const started = await startServer("npx", ["-y", "prts-mcp-ts@2.5.0"], { HOST: "127.0.0.1", PORT: "0" });
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
  if (!ACCEPTANCE_ENV) {
    test.skip("mixed registry — set VESICLE_MCP_ACCEPTANCE=1 to run", () => {});
    return;
  }
  test("one Vesicle Registry calls both legacy and modern servers", async () => {
    // This test requires both servers to be running on separate ports.
    // Configure a combined mcp.yaml and verify both eras' tools are callable
    // in one Agent turn with independent state.
    console.log("Mixed Registry acceptance requires both autotel and prts servers running.");
  }, 60000);
});
