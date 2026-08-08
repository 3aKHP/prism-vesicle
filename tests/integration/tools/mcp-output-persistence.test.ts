import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  composeMcpOutputPersistenceHint,
  composeTruncatedMcpPreview,
  MCP_INLINE_TRUNCATE_THRESHOLD_BYTES,
  mcpOutputSessionDir,
  persistMcpOutput,
  shouldTruncateMcpOutput,
} from "../../../src/mcp/output-persistence";
import { deliverMcpToolResult } from "../../../src/mcp/result-delivery";
import { normalizeMcpToolResult } from "../../../src/mcp/types";

/**
 * Opt-in MCP output persistence (#137B slice 1). The oracle is the on-disk
 * contract the model relies on: when the toggle is on, every MCP text result
 * and decoded image lands under tmp/mcp-output/<sessionId>/ with a meaningful,
 * greppable filename and a native image extension; when off, nothing is written.
 */
const SESSION_ID = "2026-08-08T12-00-00-abcd1234";

describe("MCP output persistence helper", () => {
  test("writes text under the session dir with a meaningful filename", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-persist-"));
    try {
      await persistMcpOutput(
        root,
        { sessionId: SESSION_ID, toolCallId: "call_1", serverId: "wiki", toolName: "search", arguments: JSON.stringify({ query: "operator profile" }) },
        "full result body\n",
        [],
      );
      const dir = join(root, mcpOutputSessionDir(SESSION_ID));
      const textFiles = (await readdir(dir)).filter((f) => f.endsWith(".txt"));
      expect(textFiles).toHaveLength(1);
      expect(textFiles[0]).toMatch(/^wiki-search__operator-profile-[0-9a-f]{8}\.txt$/);
      expect(await readFile(join(dir, textFiles[0]!), "utf8")).toBe("full result body\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes images as native files under blob/", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-persist-img-"));
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      await persistMcpOutput(
        root,
        { sessionId: SESSION_ID, toolCallId: "call_2", serverId: "media", toolName: "render", arguments: "{}" },
        "x",
        [{ bytes: png, mediaType: "image/png" }, { bytes: png, mediaType: "image/jpeg" }],
      );
      const blob = join(root, mcpOutputSessionDir(SESSION_ID), "blob");
      const files = await readdir(blob);
      expect(files.some((f) => f.endsWith("-image-1.png"))).toBe(true);
      expect(files.some((f) => f.endsWith("-image-2.jpg"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("hint advertises the session path, blob dir, readback tools, and non-rewind caveat", () => {
    const hint = composeMcpOutputPersistenceHint(SESSION_ID);
    expect(hint).toContain(mcpOutputSessionDir(SESSION_ID));
    expect(hint).toContain("blob/");
    expect(hint).toContain("read_file");
    expect(hint).toContain("not rewind-safe");
  });

  test("sanitizes adversarial server/tool/argument names so nothing escapes the session dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-persist-traversal-"));
    try {
      const adversarial = ["../../etc", "/absolute/path", "..\\..\\windows", "a/b/c", "name\x00null"];
      for (const value of adversarial) {
        await persistMcpOutput(
          root,
          { sessionId: SESSION_ID, toolCallId: `call-${value}`, serverId: value, toolName: value, arguments: JSON.stringify({ q: value }) },
          "body\n",
          [],
        );
      }
      const dir = join(root, mcpOutputSessionDir(SESSION_ID));
      const textFiles = (await readdir(dir)).filter((f) => f.endsWith(".txt"));
      expect(textFiles.length).toBe(adversarial.length);
      for (const f of textFiles) {
        expect(f).not.toContain("..");
        expect(f).not.toContain("/");
        expect(f).not.toContain("\\");
      }
      // Nothing escaped the scratch root: only tmp/ exists at the project root.
      expect((await readdir(root)).filter((entry) => entry !== "tmp")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MCP result delivery persistence", () => {
  test("persists text and images when outputPersistence is set", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-deliver-"));
    try {
      const png = testPng();
      const result = normalizeMcpToolResult({
        content: [
          { type: "text", text: "operator artwork" },
          { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
        ],
      });
      await deliverMcpToolResult(result, {
        rootDir: root,
        visionEnabled: true,
        serverId: "media",
        toolName: "render",
        outputPersistence: { sessionId: SESSION_ID, toolCallId: "call_3", arguments: "{\"q\":\"hello\"}" },
      });

      const sessionDir = join(root, mcpOutputSessionDir(SESSION_ID));
      const textFiles = (await readdir(sessionDir)).filter((f) => f.endsWith(".txt"));
      expect(textFiles).toHaveLength(1);
      expect(await readFile(join(sessionDir, textFiles[0]!), "utf8")).toBe("operator artwork");
      const blobFiles = await readdir(join(sessionDir, "blob"));
      expect(blobFiles.some((f) => f.endsWith(".png"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes nothing under tmp/ when outputPersistence is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-deliver-none-"));
    try {
      const result = normalizeMcpToolResult({ content: [{ type: "text", text: "operator artwork" }] });
      await deliverMcpToolResult(result, { rootDir: root, visionEnabled: true, serverId: "media", toolName: "render" });
      // No scratch output directory is created when persistence is off.
      await expect(readdir(join(root, "tmp"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MCP output auto-truncate", () => {
  test("shouldTruncateMcpOutput is threshold-gated on UTF-8 bytes", () => {
    expect(shouldTruncateMcpOutput("x".repeat(16))).toBe(false);
    expect(shouldTruncateMcpOutput("x".repeat(MCP_INLINE_TRUNCATE_THRESHOLD_BYTES))).toBe(true);
    // CJK: 3 bytes/char, so fewer chars still cross the byte threshold.
    expect(shouldTruncateMcpOutput("字".repeat(MCP_INLINE_TRUNCATE_THRESHOLD_BYTES))).toBe(true);
  });

  test("composeTruncatedMcpPreview emits a bounded preview plus a reference", () => {
    const large = "a".repeat(MCP_INLINE_TRUNCATE_THRESHOLD_BYTES + 10);
    const preview = composeTruncatedMcpPreview(large, "tmp/mcp-output/s/file.txt");
    expect(preview.length).toBeLessThan(large.length);
    expect(preview).toContain("MCP output truncated");
    expect(preview).toContain(String(Buffer.byteLength(large, "utf8")));
    expect(preview).toContain("tmp/mcp-output/s/file.txt");
    expect(preview).toContain("read_file");
  });

  test("auto-truncate delivers a preview inline while persisting the full text", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-trunc-"));
    try {
      const large = "a".repeat(MCP_INLINE_TRUNCATE_THRESHOLD_BYTES + 800);
      const result = normalizeMcpToolResult({ content: [{ type: "text", text: large }] });
      const delivered = await deliverMcpToolResult(result, {
        rootDir: root,
        visionEnabled: false,
        serverId: "wiki",
        toolName: "search",
        outputPersistence: { sessionId: SESSION_ID, toolCallId: "call-trunc", arguments: "{\"q\":\"x\"}", autoTruncate: true },
      });
      expect(delivered.content.length).toBeLessThan(large.length);
      expect(delivered.content).toContain("MCP output truncated");
      expect(delivered.content).toContain(mcpOutputSessionDir(SESSION_ID));
      const dir = join(root, mcpOutputSessionDir(SESSION_ID));
      const textFile = (await readdir(dir)).find((f) => f.endsWith(".txt"));
      expect(textFile).toBeDefined();
      expect(await readFile(join(dir, textFile!), "utf8")).toBe(large);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("with auto-truncate off the full body stays inline even when large", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-notrunc-"));
    try {
      const large = "b".repeat(MCP_INLINE_TRUNCATE_THRESHOLD_BYTES + 100);
      const result = normalizeMcpToolResult({ content: [{ type: "text", text: large }] });
      const delivered = await deliverMcpToolResult(result, {
        rootDir: root,
        visionEnabled: false,
        serverId: "wiki",
        toolName: "search",
        outputPersistence: { sessionId: SESSION_ID, toolCallId: "call-full", arguments: "{}" },
      });
      expect(delivered.content).toBe(large);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("under the threshold the full body stays inline even with auto-truncate on", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-under-"));
    try {
      const small = "c".repeat(256);
      const result = normalizeMcpToolResult({ content: [{ type: "text", text: small }] });
      const delivered = await deliverMcpToolResult(result, {
        rootDir: root,
        visionEnabled: false,
        serverId: "wiki",
        toolName: "search",
        outputPersistence: { sessionId: SESSION_ID, toolCallId: "call-under", arguments: "{}", autoTruncate: true },
      });
      expect(delivered.content).toBe(small);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function testPng(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}
