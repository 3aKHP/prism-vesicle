import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxImageAttachmentBytes } from "../../../src/core/attachments/store";
import { createMcpRegistryForEngine } from "../../../src/mcp/registry";
import { deliverMcpToolResult } from "../../../src/mcp/result-delivery";

describe("MCP multimodal result delivery", () => {
  test("delivers mixed and pure inline images through the attachment store", async () => {
    const png = testPng();
    const data = Buffer.from(png).toString("base64");
    const { registry, rootDir } = await registryForResults((args) => ({
      content: args.pure === true
        ? [{ type: "image", data, mimeType: "image/png", filename: "../../untrusted.png" }]
        : [
            { type: "text", text: "operator artwork" },
            { type: "image", data, mimeType: "image/png", filename: "../../untrusted.png" },
          ],
    }));

    const mixed = await registry.execute(
      { id: "mixed", name: "mcp_media_render", arguments: "{}" },
      { rootDir, visionEnabled: true },
    );
    expect(mixed).toMatchObject({
      ok: true,
      content: "operator artwork",
      images: [{ source: "mcp", mediaType: "image/png", filename: "media-render-image-2.png" }],
      mcpEvent: { imageCount: 1, isError: false },
    });
    expect(mixed.content).not.toContain(data);
    expect(await readFile(join(rootDir, mixed.images![0]!.path))).toEqual(Buffer.from(png));

    const pure = await registry.execute(
      { id: "pure", name: "mcp_media_render", arguments: "{\"pure\":true}" },
      { rootDir, visionEnabled: true },
    );
    expect(pure.content).toBe("MCP tool returned 1 image.");
    expect(pure.images?.[0]).toMatchObject({ source: "mcp", filename: "media-render-image-1.png" });
  });

  test("degrades image, error, deferred, and unknown results without payload leakage", async () => {
    const data = Buffer.from(testPng()).toString("base64");
    const secret = "private-resource-body";
    const { registry, rootDir } = await registryForResults((args) => ({
      content: [
        { type: "text", text: "safe text" },
        { type: "image", data, mimeType: "image/png" },
        { type: "audio", data: secret, mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "https://example.test/private?token=secret", text: secret } },
        { type: "resource_link", uri: "https://example.test/private?token=secret" },
        { type: "future", payload: secret },
      ],
      ...(args.error === true ? { isError: true } : {}),
    }));

    const nonVision = await registry.execute(
      { id: "non-vision", name: "mcp_media_render", arguments: "{}" },
      { rootDir, visionEnabled: false },
    );
    expect(nonVision.ok).toBe(true);
    expect(nonVision.images).toBeUndefined();
    expect(nonVision.content).toContain("safe text");
    expect(nonVision.content).toContain("selected model does not support vision");
    expect(nonVision.content).toContain("unsupported content: 1 audio item, 1 resource item, 1 link item");
    expect(nonVision.content).not.toContain(data);
    expect(nonVision.content).not.toContain(secret);
    expect(nonVision.content).not.toContain("token=");
    expect(await attachmentEntries(rootDir)).toEqual([]);

    const errored = await registry.execute(
      { id: "error", name: "mcp_media_render", arguments: "{\"error\":true}" },
      { rootDir, visionEnabled: true },
    );
    expect(errored.ok).toBe(false);
    expect(errored.images).toBeUndefined();
    expect(errored.content).toContain("the tool returned an error");
    expect(await attachmentEntries(rootDir)).toEqual([]);
  });

  test("rejects malformed base64, MIME mismatches, unsupported MIME, and oversized images", async () => {
    const pngData = Buffer.from(testPng()).toString("base64");
    const oversized = Buffer.alloc(maxImageAttachmentBytes + 1).toString("base64");
    const results: Record<string, Record<string, unknown>> = {
      base64: { content: [{ type: "image", data: "not/base64", mimeType: "image/png" }] },
      mismatch: { content: [{ type: "image", data: pngData, mimeType: "image/jpeg" }] },
      unsupported: { content: [{ type: "image", data: pngData, mimeType: "image/svg+xml" }] },
      oversized: { content: [{ type: "image", data: oversized, mimeType: "image/png" }] },
    };
    const { registry, rootDir } = await registryForResults((args) => results[String(args.case)]!);

    const expected = {
      base64: "not strict base64",
      mismatch: "does not match the image bytes",
      unsupported: "declared MIME type is unsupported",
      oversized: "exceeds the 20 MiB limit",
    } as const;
    for (const [scenario, notice] of Object.entries(expected)) {
      const result = await registry.execute(
        { id: scenario, name: "mcp_media_render", arguments: JSON.stringify({ case: scenario }) },
        { rootDir, visionEnabled: true },
      );
      expect(result.ok).toBe(true);
      expect(result.images).toBeUndefined();
      expect(result.content).toContain(notice);
      expect(result.content).not.toContain(pngData);
    }
    expect(await attachmentEntries(rootDir)).toEqual([]);
  });

  test("does not persist an image when delivery is cancelled after the MCP response", async () => {
    const data = Buffer.from(testPng()).toString("base64");
    const { registry, rootDir } = await registryForResults(() => ({
      content: [{ type: "image", data, mimeType: "image/png" }],
    }));
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(registry.execute(
      { id: "cancel", name: "mcp_media_render", arguments: "{}" },
      { rootDir, visionEnabled: true, signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
    await expect(registry.execute(
      { id: "cancel-non-vision", name: "mcp_media_render", arguments: "{}" },
      { rootDir, visionEnabled: false, signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(await attachmentEntries(rootDir)).toEqual([]);
  });

  test("reports attachment write failures without exposing filesystem or image data", async () => {
    const data = Buffer.from(testPng()).toString("base64");
    const { registry, rootDir } = await registryForResults(() => ({
      content: [{ type: "image", data, mimeType: "image/png" }],
    }));
    const invalidRoot = join(rootDir, "not-a-directory");
    await writeFile(invalidRoot, "file", "utf8");

    const result = await registry.execute(
      { id: "write-failure", name: "mcp_media_render", arguments: "{}" },
      { rootDir: invalidRoot, visionEnabled: true },
    );
    expect(result.ok).toBe(true);
    expect(result.images).toBeUndefined();
    expect(result.content).toContain("attachment could not be stored");
    expect(result.content).not.toContain(invalidRoot);
    expect(result.content).not.toContain(data);
  });

  test("caps host-derived attachment labels from untrusted MCP identifiers", async () => {
    const rootDir = join(tmpdir(), `prism-vesicle-mcp-label-${crypto.randomUUID()}`);
    const delivered = await deliverMcpToolResult({
      text: [],
      images: [{
        kind: "image",
        contentIndex: 0,
        data: Buffer.from(testPng()).toString("base64"),
        mimeType: "image/png",
      }],
      deferred: [],
      diagnostics: [],
      isError: false,
    }, {
      rootDir,
      visionEnabled: true,
      serverId: "s".repeat(512),
      toolName: "t".repeat(512),
    });

    expect(delivered.images?.[0]?.filename?.length).toBeLessThanOrEqual(128);
    expect(delivered.images?.[0]?.filename).toEndWith("-image-1.png");
  });
});

async function registryForResults(
  resultForArguments: (args: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ registry: Awaited<ReturnType<typeof createMcpRegistryForEngine>>; rootDir: string }> {
  const rootDir = join(tmpdir(), `prism-vesicle-mcp-multimodal-${crypto.randomUUID()}`);
  await mkdir(rootDir, { recursive: true });
  await writeFile(join(rootDir, "mcp.yaml"), [
    "servers:",
    "  media:",
    "    url: https://mcp.example.test/media/mcp",
    "",
  ].join("\n"), "utf8");
  const fetchImpl = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {
        protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "media", version: "1.0" },
      } });
    }
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/list") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "render", inputSchema: { type: "object" } }] } });
    }
    if (body.method === "tools/call") {
      const params = body.params as Record<string, unknown>;
      const args = params.arguments as Record<string, unknown>;
      return Response.json({ jsonrpc: "2.0", id: body.id, result: resultForArguments(args) });
    }
    throw new Error(`unexpected method ${String(body.method)}`);
  }) as typeof fetch;
  const env = { VESICLE_PROVIDERS_FILE: join(rootDir, "providers.yaml") };
  return { registry: await createMcpRegistryForEngine("etl", { env, fetchImpl }), rootDir };
}

async function attachmentEntries(rootDir: string): Promise<string[]> {
  return readdir(join(rootDir, ".vesicle", "attachments")).catch(() => []);
}

function testPng(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}
