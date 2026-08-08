import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolvePermission, runPrompt } from "../../../src/core/agent-loop/run";
import { loadSessionMessages, loadSessionRecords } from "../../../src/core/session/store";
import {
  configureTestProviderEnv,
  createPromptRoot,
  restoreAgentLoopTestState,
  testPng,
} from "./fixtures/agent-loop";

beforeEach(configureTestProviderEnv);
afterEach(restoreAgentLoopTestState);

describe("agent loop: MCP multimodal results", () => {
  test("materializes an MCP image for a vision request and persists only its attachment reference", async () => {
    await configureTestProviderEnv({ vision: true });
    const rootDir = await createPromptRoot();
    await configureMcp();
    const providerBodies: Record<string, any>[] = [];
    globalThis.fetch = multimodalFetch(providerBodies);

    const result = await runPrompt({
      input: "show the artwork",
      rootDir,
      permission: { mode: "MOMENTUM" },
    });

    expect(result.kind).toBe("complete");
    expect(providerBodies).toHaveLength(2);
    const imageFollowUp = providerBodies[1]!.messages.find((message: any) =>
      message.role === "user" && Array.isArray(message.content));
    expect(imageFollowUp.content).toContainEqual(expect.objectContaining({
      type: "image_url",
      image_url: expect.objectContaining({ url: expect.stringContaining("data:image/png;base64,") }),
    }));

    const records = await loadSessionRecords(rootDir, result.sessionId);
    const toolRecord = records.find((record) => record.role === "tool" && record.metadata?.toolCallId === "call-artwork");
    expect(toolRecord?.metadata?.images).toEqual([expect.objectContaining({
      source: "mcp",
      mediaType: "image/png",
      filename: "prts-operator_artwork-image-2.png",
    })]);
    const persistedImages = toolRecord?.metadata?.images as Array<{ data?: string }> | undefined;
    expect(persistedImages?.[0]?.data).toBeUndefined();
    expect(JSON.stringify(toolRecord)).not.toContain(Buffer.from(testPng()).toString("base64"));

    const resumed = await loadSessionMessages(rootDir, result.sessionId);
    const projectedTool = resumed.find((message) => message.role === "tool" && message.toolCallId === "call-artwork");
    expect(projectedTool?.images?.[0]).toMatchObject({ source: "mcp", mediaType: "image/png" });
    expect(projectedTool?.images?.[0].data).toBeUndefined();
    expect(await readFile(join(rootDir, projectedTool!.images![0]!.path))).toEqual(Buffer.from(testPng()));
  });

  test("keeps a non-vision MCP tool loop text-safe without decoding or persisting the image", async () => {
    const rootDir = await createPromptRoot();
    await configureMcp();
    const providerBodies: Record<string, any>[] = [];
    globalThis.fetch = multimodalFetch(providerBodies);

    const result = await runPrompt({
      input: "describe the artwork without vision",
      rootDir,
      permission: { mode: "MOMENTUM" },
    });

    expect(result.kind).toBe("complete");
    expect(providerBodies).toHaveLength(2);
    expect(JSON.stringify(providerBodies[1])).not.toContain("image_url");
    expect(JSON.stringify(providerBodies[1])).not.toContain(Buffer.from(testPng()).toString("base64"));
    expect(JSON.stringify(providerBodies[1])).toContain("selected model does not support vision");
    expect(await Bun.file(join(rootDir, ".vesicle", "attachments")).exists()).toBe(false);
  });

  test("uses the same vision delivery context after a MANUAL permission continuation", async () => {
    await configureTestProviderEnv({ vision: true });
    const rootDir = await createPromptRoot();
    await configureMcp();
    const providerBodies: Record<string, any>[] = [];
    globalThis.fetch = multimodalFetch(providerBodies);

    const paused = await runPrompt({
      input: "show the artwork after approval",
      rootDir,
      permission: { mode: "MANUAL" },
    });
    expect(paused.kind).toBe("needs_permission");
    if (paused.kind !== "needs_permission") throw new Error("expected MCP permission pause");
    expect(providerBodies).toHaveLength(1);

    const resumed = await resolvePermission({
      engine: "etl",
      rootDir,
      sessionId: paused.sessionId,
      messages: paused.messages,
      request: paused.request,
      remainingToolCalls: paused.remainingToolCalls,
      resolution: { decision: "allow_once", resolvedAt: new Date().toISOString() },
      permission: { mode: "MANUAL" },
    });
    expect(resumed.kind).toBe("complete");
    expect(providerBodies).toHaveLength(2);
    expect(JSON.stringify(providerBodies[1])).toContain("data:image/png;base64,");
  });

  test("materializes and persists MCP image results inside a SubAgent tool loop", async () => {
    await configureTestProviderEnv({ vision: true });
    const rootDir = await createPromptRoot();
    await configureMcp();
    const childBodies: Record<string, any>[] = [];
    globalThis.fetch = subagentMultimodalFetch(childBodies);

    const result = await runPrompt({
      input: "delegate the artwork check",
      rootDir,
      permission: { mode: "MOMENTUM" },
    });

    expect(result.kind).toBe("complete");
    expect(childBodies).toHaveLength(2);
    expect(JSON.stringify(childBodies[1])).toContain("data:image/png;base64,");
    const sessionFiles = await readdir(join(rootDir, ".vesicle", "sessions"));
    const sessionRecords = await Promise.all(sessionFiles.map((file) =>
      loadSessionRecords(rootDir, file.replace(/\.jsonl$/, ""))));
    const childToolRecord = sessionRecords.flat().find((record) =>
      record.metadata?.kind === "subagent-tool-result" && record.metadata?.toolCallId === "child-artwork");
    expect(childToolRecord?.metadata?.images).toEqual([expect.objectContaining({
      source: "mcp",
      filename: "prts-operator_artwork-image-1.png",
    })]);
    expect(JSON.stringify(childToolRecord)).not.toContain(Buffer.from(testPng()).toString("base64"));
  });
});

async function configureMcp(): Promise<void> {
  const providerPath = process.env.VESICLE_PROVIDERS_FILE;
  if (!providerPath) throw new Error("test provider config is missing");
  await writeFile(join(dirname(providerPath), "mcp.yaml"), [
    "servers:",
    "  prts:",
    "    url: https://mcp.test/prts/mcp",
    "",
  ].join("\n"), "utf8");
}

function multimodalFetch(providerBodies: Record<string, any>[]): typeof fetch {
  const imageData = Buffer.from(testPng()).toString("base64");
  return (async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    if (String(input).startsWith("https://mcp.test/")) {
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {
          protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "prts", version: "1.0" },
        } });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "operator_artwork", inputSchema: { type: "object", properties: {} } }] },
        });
      }
      if (body.method === "tools/call") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [
              { type: "text", text: "Artwork for Amiya" },
              { type: "image", data: imageData, mimeType: "image/png" },
            ],
          },
        });
      }
      throw new Error(`unexpected MCP method ${String(body.method)}`);
    }

    providerBodies.push(body);
    if (providerBodies.length === 1) {
      return Response.json({
        id: "chat-mcp-image-1",
        choices: [{ message: {
          content: "",
          tool_calls: [{
            id: "call-artwork",
            type: "function",
            function: { name: "mcp_prts_operator_artwork", arguments: "{}" },
          }],
        } }],
      });
    }
    return Response.json({ id: "chat-mcp-image-2", choices: [{ message: { content: "seen" } }] });
  }) as typeof fetch;
}

function subagentMultimodalFetch(childBodies: Record<string, any>[]): typeof fetch {
  const imageData = Buffer.from(testPng()).toString("base64");
  let parentRequests = 0;
  return (async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    if (String(input).startsWith("https://mcp.test/")) {
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {
          protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "prts", version: "1.0" },
        } });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      if (body.method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "operator_artwork", inputSchema: { type: "object" } }] } });
      }
      if (body.method === "tools/call") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "image", data: imageData, mimeType: "image/png" }] },
        });
      }
      throw new Error(`unexpected MCP method ${String(body.method)}`);
    }

    const system = String(body.messages?.[0]?.content ?? "");
    if (system.includes("General Agent")) {
      childBodies.push(body);
      if (childBodies.length === 1) {
        return Response.json({
          id: "child-mcp-image-1",
          choices: [{ message: {
            content: "",
            tool_calls: [{
              id: "child-artwork",
              type: "function",
              function: { name: "mcp_prts_operator_artwork", arguments: "{}" },
            }],
          } }],
        });
      }
      return Response.json({ id: "child-mcp-image-2", choices: [{ message: { content: "artwork checked" } }] });
    }

    parentRequests += 1;
    if (parentRequests === 1) {
      return Response.json({
        id: "parent-spawn-mcp",
        choices: [{ message: {
          content: "",
          tool_calls: [{
            id: "spawn-artwork-check",
            type: "function",
            function: {
              name: "spawn_agent",
              arguments: JSON.stringify({
                profile: "general",
                description: "Check artwork",
                prompt: "Call the artwork tool and inspect its image.",
                mode: "foreground",
              }),
            },
          }],
        } }],
      });
    }
    return Response.json({ id: "parent-mcp-complete", choices: [{ message: { content: "delegation complete" } }] });
  }) as typeof fetch;
}
