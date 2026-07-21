import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inspectProviderConfig } from "../../../src/config/providers";
import { resolveGate, runPrompt } from "../../../src/core/agent-loop/run";
import { validateCharacterCard } from "../../../src/core/validators";

/**
 * End-to-end gate flow against the real provider selected by providers.yaml.
 *
 * Runs only when BUN_E2E_REAL_PROVIDER=1 is explicitly supplied. Real model
 * output is intentionally non-deterministic and must not turn a developer's
 * local credentials into a surprise failure of the deterministic test suite.
 *
 * Verifies the full chain: ETL prompt -> model reads its instructions ->
 * model calls request_confirmation for blueprint-confirmation -> loop
 * returns needs_user -> resolveGate(confirm) -> model advances to Phase 1,
 * writes the character card file, and may pause again on phase-confirmation.
 */
describe("E2E: ETL Phase 0 gate flow", () => {
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
    if (process.env.BUN_E2E_REAL_PROVIDER !== "1") {
      console.log("[E2E] BUN_E2E_REAL_PROVIDER is not set; skipping real-provider run.");
      return;
    }
    const providerStatus = await inspectProviderConfig().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[E2E] provider config unavailable; skipping real-provider run. ${message}`);
      return undefined;
    });
    if (!providerStatus?.hasApiKey) {
      const missing = providerStatus?.missing.join(", ") ?? "provider config";
      console.log(`[E2E] selected provider credentials missing (${missing}); skipping real-provider run.`);
      return;
    }

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
    if (first.kind === "needs_engine_switch") {
      console.log(`[E2E] model requested engine switch to ${first.request.targetEngine}; skipping ETL gate assertions.`);
      expect(first.request.reason.length).toBeGreaterThan(0);
      return;
    }
    if (first.kind === "needs_user_question") {
      console.log(`[E2E] model asked question ${first.question.header}; skipping ETL gate assertions.`);
      expect(first.question.options.length).toBeGreaterThanOrEqual(2);
      return;
    }
    if (first.kind === "needs_permission") {
      console.log(`[E2E] model requested permission for ${first.request.toolName}; skipping ETL gate assertions.`);
      return;
    }
    if (first.kind === "needs_quality_decision") {
      console.log(`[E2E] quality decision pending with ${first.decision.findingCount} findings; skipping ETL gate assertions.`);
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

    if (resumed.kind === "needs_engine_switch") {
      console.log(`[E2E] post-confirm engine switch requested: ${resumed.request.targetEngine}`);
      expect(resumed.request.reason.length).toBeGreaterThan(0);
      return;
    }
    if (resumed.kind === "needs_user_question") {
      console.log(`[E2E] post-confirm question requested: ${resumed.question.header}`);
      expect(resumed.question.options.length).toBeGreaterThanOrEqual(2);
      return;
    }
    if (resumed.kind === "needs_user") {
      expect(resumed.gate.gate).toBe("phase-confirmation");
      // A provider may legally emit the next tool call with no adjacent prose.
      // The gate summary is the durable user-visible checkpoint contract.
      expect(resumed.gate.summary.length).toBeGreaterThan(0);
      console.log(`[E2E] post-confirm gate paused: ${resumed.gate.gate}`);
      console.log(`[E2E] post-confirm content preview: ${resumed.assistantContent.slice(0, 200)}`);
    } else if (resumed.kind === "needs_permission") {
      console.log(`[E2E] post-confirm permission requested: ${resumed.request.toolName}`);
      return;
    } else if (resumed.kind === "needs_quality_decision") {
      console.log(`[E2E] post-confirm quality decision pending with ${resumed.decision.findingCount} findings.`);
      return;
    } else {
      expect(resumed.response.content.length).toBeGreaterThan(0);
      console.log(`[E2E] post-confirm content preview: ${resumed.response.content.slice(0, 200)}`);
    }

    // Phase 1 should have produced a workspace artifact via write_file.
    // Read whichever .md file appeared and run the Module A validator on it.
    const workspaceDir = join(rootDir, "workspace");
    const files = await readdir(workspaceDir).catch(() => [] as string[]);
    const cardFiles = files.filter((f) => f.endsWith(".md"));
    expect(cardFiles.length).toBeGreaterThan(0);

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
