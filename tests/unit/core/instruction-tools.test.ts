import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { permissionClassForTool } from "../../../src/core/permissions/policy";
import {
  composeInstructionBlocks,
  executeReadInstructionsTool,
  executeUpdateInstructionsTool,
  instructionFilePath,
  loadInstructionTarget,
  resolveEffectiveSelection,
} from "../../../src/core/instructions";
import { freezeInstructionBlocks, readFrozenInstructionBlocks } from "../../../src/core/instructions/instruction-context";
import type { InstructionTarget } from "../../../src/core/instructions";
import type { ToolCall } from "../../../src/core/tools/types";

const BUDGET = 32 * 1024;
let counter = 0;
function call(name: string, args: Record<string, unknown>): ToolCall {
  counter += 1;
  return { id: `c-${counter}`, name, arguments: JSON.stringify(args) };
}

async function withRoots(work: (root: { project: string; config: string; env: NodeJS.ProcessEnv }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-instr-tools-"));
  const project = join(root, "project");
  const config = join(root, "config");
  await mkdir(project, { recursive: true });
  await mkdir(config, { recursive: true });
  try {
    await work({ project, config, env: { VESICLE_CONFIG_DIR: config } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeTarget(target: InstructionTarget, content: string, root: { project: string; env: NodeJS.ProcessEnv }): Promise<void> {
  const path = instructionFilePath(target, root.project, root.env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

// Symlink capability probe (top-level await so skipIf sees the resolved value).
const symlinkCapable = await (async (): Promise<boolean> => {
  const dir = await mkdtemp(join(tmpdir(), "vesicle-instr-symlink-probe-"));
  try {
    await writeFile(join(dir, "t"), "x", "utf8");
    await symlink(join(dir, "t"), join(dir, "l"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

describe("read_instructions", () => {
  test("returns content and selectedForActiveEngine for a present target", async () => {
    await withRoots(async (root) => {
      await writeTarget({ scope: "project", engine: "all" }, "project rules", root);
      const result = await executeReadInstructionsTool(call("read_instructions", { scope: "project", engine: "all" }), {
        rootDir: root.project,
        env: root.env,
        activeEngine: "etl",
      });
      expect(result.ok).toBe(true);
      expect(result.content).toContain("project rules");
      expect(result.content).toContain("selectedForActiveEngine=true");
    });
  });

  test("reports exists=false for an absent target", async () => {
    await withRoots(async (root) => {
      const result = await executeReadInstructionsTool(call("read_instructions", { scope: "user", engine: "all" }), {
        rootDir: root.project,
        env: root.env,
      });
      expect(result.ok).toBe(true);
      expect(result.content).toContain("does not exist");
    });
  });

  test("selectedForActiveEngine=false when an engine override masks the general file", async () => {
    await withRoots(async (root) => {
      await writeTarget({ scope: "project", engine: "all" }, "general", root);
      await writeTarget({ scope: "project", engine: "etl" }, "etl override", root);
      const general = await executeReadInstructionsTool(call("read_instructions", { scope: "project", engine: "all" }), {
        rootDir: root.project, env: root.env, activeEngine: "etl",
      });
      expect(general.content).toContain("selectedForActiveEngine=false");
      const override = await executeReadInstructionsTool(call("read_instructions", { scope: "project", engine: "etl" }), {
        rootDir: root.project, env: root.env, activeEngine: "etl",
      });
      expect(override.content).toContain("selectedForActiveEngine=true");
    });
  });
});

describe("update_instructions write/delete", () => {
  test("writes a new target and an empty override, and overwrites with a backup", async () => {
    await withRoots(async (root) => {
      const wrote = await executeUpdateInstructionsTool(call("update_instructions", { scope: "project", engine: "all", action: "write", content: "first", summary: "seed" }), { rootDir: root.project, env: root.env, activeEngine: "etl", sessionId: "s1" });
      expect(wrote.ok).toBe(true);
      expect(await readFile(join(root.project, "VESICLE.md"), "utf8")).toContain("first");

      const overwrote = await executeUpdateInstructionsTool(call("update_instructions", { scope: "project", engine: "all", action: "write", content: "second", summary: "revise" }), { rootDir: root.project, env: root.env, sessionId: "s1" });
      expect(overwrote.ok).toBe(true);
      expect(await readFile(join(root.project, "VESICLE.md"), "utf8")).toContain("second");
      const backup = join(root.project, ".vesicle", "instruction-backups", "project-VESICLE.md.previous");
      expect(existsSync(backup)).toBe(true);
      expect(await readFile(backup, "utf8")).toContain("first");

      const emptied = await executeUpdateInstructionsTool(call("update_instructions", { scope: "project", engine: "all", action: "write", content: "", summary: "clear" }), { rootDir: root.project, env: root.env, sessionId: "s1" });
      expect(emptied.ok).toBe(true);
      const loaded = await loadInstructionTarget({ scope: "project", engine: "all" }, root.project, root.env);
      expect(loaded.kind === "file" && loaded.file.empty).toBe(true);
    });
  });

  test("deletes an existing target and no-ops an absent one", async () => {
    await withRoots(async (root) => {
      await writeTarget({ scope: "project", engine: "all" }, "to remove", root);
      const deleted = await executeUpdateInstructionsTool(call("update_instructions", { scope: "project", engine: "all", action: "delete", summary: "remove" }), { rootDir: root.project, env: root.env });
      expect(deleted.ok).toBe(true);
      expect(existsSync(join(root.project, "VESICLE.md"))).toBe(false);

      const noop = await executeUpdateInstructionsTool(call("update_instructions", { scope: "user", engine: "all", action: "delete", summary: "remove absent" }), { rootDir: root.project, env: root.env });
      expect(noop.ok).toBe(true);
      expect(noop.content).toContain("no change");
    });
  });

  test("CAS: omitted overwrites, 'absent' rejects existing, stale hash never overwrites, matching hash applies", async () => {
    await withRoots(async (root) => {
      await writeTarget({ scope: "project", engine: "all" }, "original", root);
      const current = await loadInstructionTarget({ scope: "project", engine: "all" }, root.project, root.env);
      const hash = current.kind === "file" ? current.file.sha256 : "";

      // absent CAS rejects an existing target without changing it.
      const absentFail = await executeUpdateInstructionsTool(call("update_instructions", { scope: "project", engine: "all", action: "write", content: "x", ifMatchSha256: "absent", summary: "create" }), { rootDir: root.project, env: root.env });
      expect(absentFail.ok).toBe(false);
      expect(await readFile(join(root.project, "VESICLE.md"), "utf8")).toContain("original");

      // stale hash rejects without overwriting.
      const stale = await executeUpdateInstructionsTool(call("update_instructions", { scope: "project", engine: "all", action: "write", content: "stale", ifMatchSha256: "0".repeat(64), summary: "stale" }), { rootDir: root.project, env: root.env });
      expect(stale.ok).toBe(false);
      expect(await readFile(join(root.project, "VESICLE.md"), "utf8")).toContain("original");

      // matching hash applies.
      const matched = await executeUpdateInstructionsTool(call("update_instructions", { scope: "project", engine: "all", action: "write", content: "via cas", ifMatchSha256: hash, summary: "cas write" }), { rootDir: root.project, env: root.env });
      expect(matched.ok).toBe(true);
      expect(await readFile(join(root.project, "VESICLE.md"), "utf8")).toContain("via cas");
    });
  });

  test("rejects content that would oversize the combination, without writing", async () => {
    await withRoots(async (root) => {
      // User file near half the budget — its own write is within budget.
      const half = `${"u".repeat(Math.floor(BUDGET / 2) + 100)}`;
      const userWrite = await executeUpdateInstructionsTool(call("update_instructions", { scope: "user", engine: "all", action: "write", content: half, summary: "big user" }), { rootDir: root.project, env: root.env, activeEngine: "etl" });
      expect(userWrite.ok).toBe(true);
      // Project write would combine with the user file past the budget.
      const projectWrite = await executeUpdateInstructionsTool(call("update_instructions", { scope: "project", engine: "all", action: "write", content: `${"p".repeat(Math.floor(BUDGET / 2) + 100)}`, summary: "big project" }), { rootDir: root.project, env: root.env, activeEngine: "etl" });
      expect(projectWrite.ok).toBe(false);
      expect(projectWrite.content).toMatch(/oversized|budget/);
      expect(existsSync(join(root.project, "VESICLE.md"))).toBe(false);
    });
  });

  test("reports affected engines for a general-target write", async () => {
    await withRoots(async (root) => {
      const result = await executeUpdateInstructionsTool(call("update_instructions", { scope: "project", engine: "all", action: "write", content: "general rules", summary: "seed" }), { rootDir: root.project, env: root.env });
      expect(result.ok).toBe(true);
      // A general target with no overrides affects every engine that falls back to it.
      expect(result.content).toContain("Affects:");
      expect(result.content).toContain("etl");
    });
  });

  test.skipIf(!symlinkCapable)("rejects a project symlink target", async () => {
    await withRoots(async (root) => {
      const elsewhere = join(root.config, "outside.txt");
      await writeFile(elsewhere, "host file", "utf8");
      await symlink(elsewhere, join(root.project, "VESICLE.md"));
      const result = await executeUpdateInstructionsTool(call("update_instructions", { scope: "project", engine: "all", action: "write", content: "x", summary: "via link" }), { rootDir: root.project, env: root.env });
      expect(result.ok).toBe(false);
      expect(result.content).toContain("symbolic link");
    });
  });
});

describe("update_instructions frozen-cache refresh", () => {
  test("a successful write refreshes the in-turn frozen snapshot", async () => {
    await withRoots(async (root) => {
      await writeTarget({ scope: "project", engine: "all" }, "OLD-RULE", root);
      const sessionId = "sess-frozen";
      freezeInstructionBlocks(sessionId, composeInstructionBlocks(await resolveEffectiveSelection("etl", root.project, root.env)));
      expect(readFrozenInstructionBlocks(sessionId)).toContain("OLD-RULE");

      await executeUpdateInstructionsTool(call("update_instructions", { scope: "project", engine: "all", action: "write", content: "NEW-RULE", summary: "refresh" }), { rootDir: root.project, env: root.env, activeEngine: "etl", sessionId });
      const frozen = readFrozenInstructionBlocks(sessionId);
      expect(frozen).toContain("NEW-RULE");
      expect(frozen).not.toContain("OLD-RULE");
    });
  });
});

describe("instruction tool permission classification", () => {
  test("read_instructions is observe, update_instructions is mutate", () => {
    expect(permissionClassForTool("read_instructions")).toBe("observe");
    expect(permissionClassForTool("update_instructions")).toBe("mutate");
  });
});
