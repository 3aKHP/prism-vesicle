import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../../src/core/tools/types";
import { executeActivateSkillTool, executeReadSkillResourceTool } from "../../../src/core/skills";
import { clearSessionActivations } from "../../../src/core/skills";
import type { ResolvedSkillCatalog } from "../../../src/core/skills";
import { catalogFor, loadWritten, makeScratch, writeSkill } from "./helpers";

let scratch: string;
let sessionId: string;

beforeEach(async () => {
  scratch = await makeScratch();
  sessionId = randomUUID();
});

afterEach(async () => {
  clearSessionActivations(sessionId);
  await rm(scratch, { recursive: true, force: true });
});

function call(name: string, args: unknown): ToolCall {
  return { id: `call-${randomUUID()}`, name, arguments: JSON.stringify(args) };
}

async function activeCatalog(files: Record<string, string | Uint8Array>): Promise<ResolvedSkillCatalog> {
  const catalog = catalogFor(await loadWritten(await writeSkill(scratch, "alpha", { files })));
  const activation = await executeActivateSkillTool(call("activate_skill", { name: "alpha" }), { catalog, sessionId });
  expect(activation.ok).toBe(true);
  return catalog;
}

describe("read_skill_resource executor", () => {
  test("requires prior activation", async () => {
    const catalog = catalogFor(await loadWritten(await writeSkill(scratch, "alpha", { files: { "references/note.md": "text" } })));
    const result = await executeReadSkillResourceTool(call("read_skill_resource", { skill: "alpha", path: "references/note.md" }), { catalog, sessionId });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not active in this session");
    expect(result.content).toContain("activate_skill");
  });

  test("reads a text resource verbatim with a header and event", async () => {
    const catalog = await activeCatalog({ "references/note.md": "line one\nline two\n" });
    const result = await executeReadSkillResourceTool(call("read_skill_resource", { skill: "alpha", path: "references/note.md" }), { catalog, sessionId });
    expect(result.ok).toBe(true);
    expect(result.content).toBe('[skill_resource name="alpha" path="references/note.md"]\nline one\nline two\n');
    expect(result.skillEvent).toMatchObject({ kind: "skill_resource_read", name: "alpha", path: "references/note.md", bytes: 18, truncated: false });
    expect(result.content).not.toContain(scratch);
  });

  test("rejects traversal, absolute, and backslash paths", async () => {
    const catalog = await activeCatalog({ "references/note.md": "text" });
    for (const path of ["../outside.md", "/etc/passwd", "references\\note.md", "references/./note.md"]) {
      const result = await executeReadSkillResourceTool(call("read_skill_resource", { skill: "alpha", path }), { catalog, sessionId });
      expect(result.ok).toBe(false);
      expect(result.content).not.toContain(scratch);
    }
  });

  test("script sources are readable without any process capability", async () => {
    const source = "#!/bin/sh\nprintf 'inspect me'\n";
    const catalog = await activeCatalog({ "scripts/tool.sh": source });
    // No shell/interpreter options at all: readability is not gated by process capability.
    const result = await executeReadSkillResourceTool(call("read_skill_resource", { skill: "alpha", path: "scripts/tool.sh" }), { catalog, sessionId });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("inspect me");
  });

  test("caps oversized text at 256 KiB with a truncation note", async () => {
    const oversized = "a".repeat(256 * 1024 + 100);
    const catalog = await activeCatalog({ "references/big.md": oversized });
    const result = await executeReadSkillResourceTool(call("read_skill_resource", { skill: "alpha", path: "references/big.md" }), { catalog, sessionId });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("[truncated:");
    expect(result.skillEvent).toMatchObject({ kind: "skill_resource_read", bytes: oversized.length, truncated: true });
  });

  test("rejects binary resources with a helpful message", async () => {
    const catalog = await activeCatalog({ "assets/blob.bin": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]) });
    const result = await executeReadSkillResourceTool(call("read_skill_resource", { skill: "alpha", path: "assets/blob.bin" }), { catalog, sessionId });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not valid UTF-8");
  });

  test("slices lines with startLine/endLine", async () => {
    const catalog = await activeCatalog({ "references/lines.md": "one\ntwo\nthree\nfour\n" });
    const result = await executeReadSkillResourceTool(
      call("read_skill_resource", { skill: "alpha", path: "references/lines.md", startLine: 2, endLine: 3 }),
      { catalog, sessionId },
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("two\nthree");
    expect(result.content).not.toContain("one\ntwo");
    expect(result.content).toContain("[lines 2-3 of 5]");

    const inverted = await executeReadSkillResourceTool(
      call("read_skill_resource", { skill: "alpha", path: "references/lines.md", startLine: 3, endLine: 2 }),
      { catalog, sessionId },
    );
    expect(inverted.ok).toBe(false);
  });

  test("rejects paths that do not name a regular bundled file", async () => {
    const catalog = await activeCatalog({ "references/note.md": "text" });
    const result = await executeReadSkillResourceTool(call("read_skill_resource", { skill: "alpha", path: "references/missing.md" }), { catalog, sessionId });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not a regular file");
  });
});
