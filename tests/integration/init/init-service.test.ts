import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateProjectInstructions } from "../../../src/core/init";
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
});
