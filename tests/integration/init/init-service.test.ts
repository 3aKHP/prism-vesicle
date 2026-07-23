import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateProjectInstructions } from "../../../src/core/init";
import { loadInstructionTarget } from "../../../src/core/instructions";
import { configureTestProviderEnv, restoreAgentLoopTestState } from "../agent-loop/fixtures/agent-loop";

const originalFetch = globalThis.fetch;

beforeEach(configureTestProviderEnv);
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await restoreAgentLoopTestState();
});

function stubProviderContent(content: string): void {
  globalThis.fetch = (async () => Response.json({
    id: "init-response",
    choices: [{ message: { content } }],
  })) as unknown as typeof fetch;
}

describe("/init generateProjectInstructions", () => {
  test("writes a VESICLE.md from the provider response", async () => {
    const project = await mkdtemp(join(tmpdir(), "vesicle-init-write-"));
    try {
      await mkdir(join(project, "workspace"), { recursive: true });
      await writeFile(join(project, "workspace", "hero.md"), "# Hero\nbrave", "utf8");
      stubProviderContent("# Project guide\nUse the runtime engine.");

      const result = await generateProjectInstructions({ rootDir: project });
      expect(result.path).toBe("VESICLE.md");
      expect(result.overwritten).toBe(false);
      const written = await readFile(join(project, "VESICLE.md"), "utf8");
      expect(written).toContain("# Project guide");
      expect(written).toContain("runtime engine");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("backs up an existing VESICLE.md before overwriting it", async () => {
    const project = await mkdtemp(join(tmpdir(), "vesicle-init-overwrite-"));
    try {
      await writeFile(join(project, "VESICLE.md"), "OLD RULES", "utf8");
      stubProviderContent("NEW RULES");

      const result = await generateProjectInstructions({ rootDir: project });
      expect(result.overwritten).toBe(true);
      expect(result.backupPath).toBeDefined();
      const written = await readFile(join(project, "VESICLE.md"), "utf8");
      expect(written).toContain("NEW RULES");
      const backup = await readFile(join(project, result.backupPath!), "utf8");
      expect(backup).toContain("OLD RULES");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("passes user notes through to the provider request", async () => {
    const project = await mkdtemp(join(tmpdir(), "vesicle-init-notes-"));
    let capturedBody = "";
    globalThis.fetch = (async (_input: unknown, init: RequestInit & { body?: unknown }) => {
      if (typeof init.body === "string") capturedBody = init.body;
      return Response.json({ id: "r", choices: [{ message: { content: "OK" } }] });
    }) as unknown as typeof fetch;
    try {
      await generateProjectInstructions({ rootDir: project, notes: "prefer terse output" });
      expect(capturedBody).toContain("prefer terse output");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("writes a file the Persistent Instructions loader accepts", async () => {
    const project = await mkdtemp(join(tmpdir(), "vesicle-init-pi-roundtrip-"));
    try {
      stubProviderContent("# Project guide\nUse the runtime engine for play.");
      await generateProjectInstructions({ rootDir: project });
      const loaded = await loadInstructionTarget({ scope: "project", engine: "all" }, project);
      expect(loaded.kind).toBe("file");
      if (loaded.kind !== "file") throw new Error("expected file");
      expect(loaded.file.empty).toBe(false);
      expect(loaded.file.content).toContain("runtime engine");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("strips a wrapping code fence from the provider response", async () => {
    const project = await mkdtemp(join(tmpdir(), "vesicle-init-fence-"));
    try {
      stubProviderContent("```markdown\n# Real guide\nUse runtime.\n```");
      await generateProjectInstructions({ rootDir: project });
      const written = await readFile(join(project, "VESICLE.md"), "utf8");
      expect(written).toContain("# Real guide");
      expect(written).not.toContain("```");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("rejects an empty response without creating or overwriting VESICLE.md", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "vesicle-init-empty-fresh-"));
    const existing = await mkdtemp(join(tmpdir(), "vesicle-init-empty-existing-"));
    try {
      stubProviderContent("   ");
      await expect(generateProjectInstructions({ rootDir: fresh })).rejects.toThrow(/empty|did not include/i);
      expect(existsSync(join(fresh, "VESICLE.md"))).toBe(false);

      await writeFile(join(existing, "VESICLE.md"), "PREEXISTING", "utf8");
      stubProviderContent("");
      await expect(generateProjectInstructions({ rootDir: existing })).rejects.toThrow(/empty|did not include/i);
      expect(await readFile(join(existing, "VESICLE.md"), "utf8")).toBe("PREEXISTING");
      expect(existsSync(join(existing, ".vesicle", "init-backups", "VESICLE.md.previous"))).toBe(false);
    } finally {
      await Promise.all([fresh, existing].map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });

  test("rejects output exceeding the 32 KiB Persistent Instruction budget", async () => {
    const project = await mkdtemp(join(tmpdir(), "vesicle-init-budget-"));
    try {
      stubProviderContent(`${"x".repeat(33_000)}`);
      await expect(generateProjectInstructions({ rootDir: project })).rejects.toThrow(/budget/);
      expect(existsSync(join(project, "VESICLE.md"))).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
