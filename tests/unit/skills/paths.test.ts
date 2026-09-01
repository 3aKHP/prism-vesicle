import { describe, expect, test } from "bun:test";
import { assertSafeRelativePath, classifyResource, isTextReference } from "../../../src/skills";
import { utf8SafeBoundary } from "../../../src/skills/paths";

function expectUnsafe(path: string): void {
  expect(() => assertSafeRelativePath(path), `expected "${path}" to be rejected`).toThrow();
}

describe("skill path hardening", () => {
  test("accepts clean relative POSIX paths", () => {
    expect(() => assertSafeRelativePath("references/glossary.md")).not.toThrow();
    expect(() => assertSafeRelativePath("assets/logo.png")).not.toThrow();
    expect(() => assertSafeRelativePath("scripts/run.sh")).not.toThrow();
    expect(() => assertSafeRelativePath("SKILL.md")).not.toThrow();
  });

  test("rejects absolute, traversal, NUL, backslash, and ambiguous segments", () => {
    expectUnsafe("/etc/passwd");
    expectUnsafe("C:/Users/x");
    expectUnsafe("../escape.md");
    expectUnsafe("a/../../b");
    expectUnsafe("a/\0b");
    expectUnsafe("a\\b.md");
    expectUnsafe("a//b");
    expectUnsafe("a/./b");
    expectUnsafe("");
  });

  test("classifies resources by conventional directory", () => {
    expect(classifyResource("references/g.md")).toBe("reference");
    expect(classifyResource("assets/x.png")).toBe("asset");
    expect(classifyResource("scripts/s.sh")).toBe("script");
    expect(classifyResource("other.txt")).toBe("other");
  });

  test("text-reference detection follows extension", () => {
    expect(isTextReference("references/g.md")).toBe(true);
    expect(isTextReference("references/data.json")).toBe(true);
    expect(isTextReference("assets/photo.png")).toBe(false);
  });

  test("byte-cap truncation never splits a UTF-8 sequence at any cut position", () => {
    // The shared 256 KiB cap consumer decodes with a fatal decoder, so the
    // safe-boundary prefix must be decodable for every possible cut,
    // including multi-byte sequences straddling the cap.
    const samples = ["aaa你好世界bbb", "é".repeat(12), "𝕊𝕊𝕊こんにちは"];
    for (const sample of samples) {
      const raw = Buffer.from(sample, "utf8");
      for (let cut = 0; cut <= raw.byteLength; cut++) {
        const boundary = utf8SafeBoundary(raw, cut);
        expect(boundary).toBeLessThanOrEqual(cut);
        expect(() => new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, boundary))).not.toThrow();
      }
    }
  });
});
