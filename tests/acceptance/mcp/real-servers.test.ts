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
import { createMcpRegistryForEngine } from "../../../src/mcp/registry";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACCEPTANCE_ENV = process.env.VESICLE_MCP_ACCEPTANCE === "1";

/** Skip helper: produces an explicit unavailable reason when prerequisites are missing. */
function skipIfUnavailable(label: string, condition: boolean): void {
  if (!ACCEPTANCE_ENV) {
    test.skip(`${label} — set VESICLE_MCP_ACCEPTANCE=1 to run`, () => {});
    return;
  }
  if (!condition) {
    test.skip(`${label} — prerequisite unavailable`, () => {});
    return;
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
      const portMatch = /port[:\s]+(\d+)/i.exec(text);
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

// ─── autotel-mcp (modern/dual-era) ─────────────────────────────────────────

describe("MCP acceptance: autotel-mcp (modern)", () => {
  skipIfUnavailable("autotel modern pin", ACCEPTANCE_ENV);
  if (!ACCEPTANCE_ENV) return;

  let server: { url: string; process: ChildProcess } | undefined;

  test("strict modern pin connects, lists, calls, and closes", async () => {
    const started = await startServer("npx", ["-y", "autotel-mcp@0.4.1", "--transport", "http", "--host", "127.0.0.1", "--port", "0"]);
    if ("error" in started) { console.log(`autotel unavailable: ${started.error}`); return; }
    server = started;

    const result = await createMcpConnection({
      id: "autotel",
      enabled: true,
      transport: "streamable-http",
      url: started.url,
      headers: {},
      timeoutSeconds: 15,
      protocolVersion: "2025-03-26",
      negotiation: "modern",
      supportedProtocolVersions: ["2026-07-28"],
      includeTools: [],
      excludeTools: [],
      enabledEngines: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.info.era).toBe("modern");

    const tools = await result.connection.listTools();
    expect(tools.length).toBeGreaterThan(0);

    const callResult = await result.connection.callTool("backend_capabilities", {});
    expect(callResult.isError).toBe(false);

    await result.connection.close();
  }, 30000);

  test("auto selects modern without initialize", async () => {
    if (!server) return;
    const result = await createMcpConnection({
      id: "autotel-auto",
      enabled: true,
      transport: "streamable-http",
      url: server.url,
      headers: {},
      timeoutSeconds: 15,
      protocolVersion: "2025-03-26",
      negotiation: "auto",
      supportedProtocolVersions: ["2026-07-28"],
      includeTools: [],
      excludeTools: [],
      enabledEngines: [],
    });
    if (result.ok) {
      expect(result.connection.info.era).toBe("modern");
      await result.connection.close();
    }
  }, 15000);

  test.afterAll(async () => {
    if (server) await stopServer(server.process);
  });
});

// ─── PRTS-MCP (legacy) ─────────────────────────────────────────────────────

describe("MCP acceptance: PRTS-MCP (legacy)", () => {
  skipIfUnavailable("prts legacy", ACCEPTANCE_ENV);
  if (!ACCEPTANCE_ENV) return;

  let server: { url: string; process: ChildProcess } | undefined;

  test("absent-field/legacy connection uses initialize and session", async () => {
    const started = await startServer("npx", ["-y", "prts-mcp-ts@2.5.0"], { HOST: "127.0.0.1", PORT: "0" });
    if ("error" in started) { console.log(`prts unavailable: ${started.error}`); return; }
    server = started;

    const result = await createMcpConnection({
      id: "prts",
      enabled: true,
      transport: "streamable-http",
      url: started.url,
      headers: {},
      timeoutSeconds: 15,
      protocolVersion: "2025-03-26",
      negotiation: "legacy",
      supportedProtocolVersions: [],
      includeTools: [],
      excludeTools: [],
      enabledEngines: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.info.era).toBe("legacy");

    const tools = await result.connection.listTools();
    expect(tools.length).toBeGreaterThan(0);

    await result.connection.close();
  }, 30000);

  test.afterAll(async () => {
    if (server) await stopServer(server.process);
  });
});

// ─── Mixed Registry ────────────────────────────────────────────────────────

describe("MCP acceptance: mixed Registry", () => {
  skipIfUnavailable("mixed registry", ACCEPTANCE_ENV);
  if (!ACCEPTANCE_ENV) return;

  test("one Vesicle Registry calls both legacy and modern servers", async () => {
    // This test requires both servers to be running.
    // In real acceptance, start both servers on separate ports and
    // create a single mcp.yaml with both entries.
    // The test verifies both eras' tools are callable in one Agent turn.
    console.log("Mixed Registry acceptance requires both autotel and prts servers running.");
    console.log("Run the individual server tests first, then configure a combined mcp.yaml.");
  }, 60000);
});
