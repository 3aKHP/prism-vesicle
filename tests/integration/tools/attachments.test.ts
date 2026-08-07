import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectImageMediaType,
  ingestImageBytes,
  materializeMessageImages,
  maxImageAttachmentBytes,
  parseImageAttachments,
  persistedImageAttachments,
} from "../../../src/core/attachments/store";

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);

describe("image attachment store", () => {
  test("stores content-addressed images and materializes base64 only for requests", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-attachments-"));
    const image = await ingestImageBytes(rootDir, png, {
      source: "clipboard",
      filename: "capture.png",
    });

    expect(image.path).toMatch(/^\.vesicle\/attachments\/[a-f0-9]{64}\.png$/);
    expect(image.data).toBeUndefined();
    expect(await readFile(join(rootDir, image.path))).toEqual(Buffer.from(png));

    const [materialized] = (await materializeMessageImages(rootDir, [image]))!;
    expect(materialized.data).toBe(Buffer.from(png).toString("base64"));
    expect(persistedImageAttachments([materialized])?.[0].data).toBeUndefined();
  });

  test("detects supported formats and rejects malformed persisted metadata", () => {
    expect(detectImageMediaType(png)).toBe("image/png");
    expect(detectImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
    expect(parseImageAttachments([{ id: "bad" }])).toBeUndefined();
  });

  test("round-trips MCP attachment references under the shared 20 MiB policy", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-mcp-attachments-"));
    const image = await ingestImageBytes(rootDir, png, {
      source: "mcp",
      filename: "prts-operator_artwork-image-1.png",
      expectedMediaType: "image/png",
    });
    const persisted = persistedImageAttachments([{
      ...image,
      data: Buffer.from(png).toString("base64"),
    }]);

    expect(maxImageAttachmentBytes).toBe(20 * 1024 * 1024);
    expect(parseImageAttachments(persisted)).toEqual([image]);
    expect(JSON.stringify(persisted)).not.toContain(Buffer.from(png).toString("base64"));
    await expect(ingestImageBytes(rootDir, png, {
      source: "mcp",
      expectedMediaType: "image/jpeg",
    })).rejects.toThrow("MIME mismatch");
  });
});
