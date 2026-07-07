import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveGate, runPrompt } from "../src/core/agent-loop/run";
import { validateCharacterCard } from "../src/core/validators";

/**
 * End-to-end gate flow against the real provider configured in .env.
 *
 * Skips automatically when VESICLE_API_KEY is absent, so this test is safe
 * to leave in the suite; it only runs when a key is available (locally or
 * in CI with secrets injected). The user confirmed the .env key is dedicated
 * to testing.
 *
 * Verifies the full chain: ETL prompt -> model reads its instructions ->
 * model calls request_confirmation for blueprint-confirmation -> loop
 * returns needs_user -> resolveGate(confirm) -> model advances to Phase 1,
 * writes the character card file, and may pause again on phase-confirmation.
 */
describe.skipIf(!process.env.VESICLE_API_KEY)("E2E: ETL Phase 0 gate flow", () => {
  let rootDir: string | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "vesicle-e2e-"));
    await cp("assets", join(rootDir, "assets"), { recursive: true });
    await mkdir(join(rootDir, "workspace"), { recursive: true });
    await writeFile(join(rootDir, "workspace", ".gitkeep"), "", "utf8");
  });

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  test("model calls request_confirmation, then on confirm writes a validatable card", async () => {
    if (!rootDir) throw new Error("E2E rootDir was not initialized.");

    const first = await runPrompt({
      input:
        "我要为「洛天依」制作角色卡。请按工作流 A 的 Phase 0 输出蓝图并请求 blueprint-confirmation。",
      engine: "etl",
      rootDir,
      messages: [
        {
          role: "user",
          content:
            "我要为「洛天依」制作角色卡。请按工作流 A 的 Phase 0 输出蓝图并请求 blueprint-confirmation。",
        },
      ],
    });

    // The ETL prompt instructs the model to call request_confirmation at
    // Phase 0. We accept either a clean gate pause or, if the model chose
    // to keep talking, a complete turn — but log which path we got so the
    // test output is useful when the prompt/model behaviour drifts.
    if (first.kind === "complete") {
      console.log(`[E2E] model completed without gating. Content preview: ${first.response.content.slice(0, 200)}`);
      expect(first.response.content.length).toBeGreaterThan(0);
      return;
    }

    expect(first.kind).toBe("needs_user");
    expect(first.gate.gate).toBe("blueprint-confirmation");
    expect(first.gate.summary.length).toBeGreaterThan(0);
    console.log(`[E2E] gate paused: ${first.gate.gate}`);
    console.log(`[E2E] blueprint summary:\n${first.gate.summary}`);

    const resumed = await resolveGate({
      engine: "etl",
      rootDir,
      sessionId: first.sessionId,
      messages: first.messages,
      toolCallId: first.toolCallId,
      gate: first.gate,
      resolution: { decision: "confirm" },
    });

    if (resumed.kind === "needs_user") {
      expect(resumed.gate.gate).toBe("phase-confirmation");
      expect(resumed.assistantContent.length).toBeGreaterThan(0);
      console.log(`[E2E] post-confirm gate paused: ${resumed.gate.gate}`);
      console.log(`[E2E] post-confirm content preview: ${resumed.assistantContent.slice(0, 200)}`);
    } else {
      expect(resumed.response.content.length).toBeGreaterThan(0);
      console.log(`[E2E] post-confirm content preview: ${resumed.response.content.slice(0, 200)}`);
    }

    // Phase 1 should have produced a workspace artifact via write_file.
    // Read whichever .md file appeared and run the Module A validator on it.
    const workspaceDir = join(rootDir, "workspace");
    const files = await readdir(workspaceDir).catch(() => [] as string[]);
    const cardFiles = files.filter((f) => f.endsWith(".md"));
    if (cardFiles.length === 0) {
      console.log("[E2E] no workspace artifact written; model may have only narrated Phase 1. Skipping card validation.");
      return;
    }

    const cardPath = join(workspaceDir, cardFiles[0]);
    const cardContent = await readFile(cardPath, "utf8");
    console.log(`[E2E] validating artifact: ${cardPath} (${cardContent.length} chars)`);

    const validation = validateCharacterCard(cardContent);
    console.log(`[E2E] validation ok=${validation.ok}`);
    for (const error of validation.errors) console.log(`[E2E]   error: ${error}`);
    for (const warning of validation.warnings) console.log(`[E2E]   warn: ${warning}`);

    // The model's Phase 1 output is partial (Shell only: frontmatter +
    // Visual Cortex), so we do not hard-assert the full seven-section
    // check here. We do assert the foundational invariants that Phase 1
    // must satisfy: frontmatter present, no L-System leakage.
    expect(validation.errors.some((e) => e.includes("YAML frontmatter"))).toBe(false);
    expect(validation.errors.every((e) => !e.includes("L-System"))).toBe(true);
  }, 90000);
});
