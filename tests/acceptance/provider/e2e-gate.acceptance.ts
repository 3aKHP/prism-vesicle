import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolveGate, runPrompt } from "../../../src/core/agent-loop/run";
import { validateCharacterCard } from "../../../src/core/validators";
import {
  checkAcceptancePrecondition,
  createAcceptanceRoot,
  removeAcceptanceRoot,
  summarize,
} from "./support";

const precondition = await checkAcceptancePrecondition();
const label = precondition.ok
  ? `${precondition.providerId}/${precondition.model}`
  : `skipped: ${precondition.reason}`;

let rootDir: string | undefined;
beforeEach(async () => {
  if (precondition.ok) rootDir = await createAcceptanceRoot();
});
afterEach(async () => {
  if (rootDir) {
    await removeAcceptanceRoot(rootDir);
    rootDir = undefined;
  }
});

/**
 * Strict ETL Phase 0 gate acceptance. The model MUST follow the gate protocol:
 * Phase 0 outputs a blueprint and calls request_confirmation for
 * blueprint-confirmation; on confirm it advances to Phase 1 and writes the
 * character card. Any deviation — completing Phase 0 without gating, an engine
 * switch, a user question, a permission request, or a quality decision — is a
 * FAILURE. This is the strict workflow gate, not a lenient smoke; run it as a
 * recorded dogfood acceptance before a public tag.
 *
 * Skipped (not passed) when the acceptance precondition is unmet.
 */
test.skipIf(!precondition.ok)(`strict ETL Phase 0 gate acceptance [${label}]`, async () => {
  if (!rootDir) throw new Error("acceptance rootDir was not initialized");

  const phase0Prompt =
    "我要为「洛天依」制作角色卡。请按工作流 A 的 Phase 0 输出蓝图并请求 blueprint-confirmation。";
  const first = await runPrompt({
    input: phase0Prompt,
    engine: "etl",
    rootDir,
    messages: [{ role: "user", content: phase0Prompt }],
  });

  // Phase 0 must reach the blueprint-confirmation gate. Every other kind is a
  // strict failure: the model did not follow the ETL gate protocol.
  if (first.kind !== "needs_user") {
    throw new Error(
      `Phase 0 strict failure: expected needs_user (blueprint-confirmation gate), got ${first.kind}`,
    );
  }
  expect(first.gate.gate).toBe("blueprint-confirmation");
  expect(first.gate.summary.length).toBeGreaterThan(0);
  summarize("gate", {
    phase: 0,
    gate: first.gate.gate,
    provider: precondition.providerId,
    model: precondition.model,
  });
  // The gate summary is the durable user-visible checkpoint the operator is
  // accepting; surface it as evidence rather than model prose to be trimmed.
  console.log(`[acceptance:gate] Phase 0 blueprint summary:\n${first.gate.summary}`);

  const resumed = await resolveGate({
    engine: "etl",
    rootDir,
    sessionId: first.sessionId,
    messages: first.messages,
    toolCallId: first.toolCallId,
    gate: first.gate,
    resolution: { decision: "confirm" },
  });

  // After confirm the model advances to Phase 1. Accept only the expected
  // phase-confirmation gate or a clean completion; switch/question/permission/
  // quality are strict failures.
  if (resumed.kind !== "needs_user" && resumed.kind !== "complete") {
    throw new Error(
      `Phase 1 strict failure: post-confirm deviation ${resumed.kind} (expected phase-confirmation gate or complete)`,
    );
  }
  if (resumed.kind === "needs_user") {
    expect(resumed.gate.gate).toBe("phase-confirmation");
    expect(resumed.gate.summary.length).toBeGreaterThan(0);
    summarize("gate", { phase: 1, gate: resumed.gate.gate });
    console.log(`[acceptance:gate] Phase 1 paused at ${resumed.gate.gate}`);
  } else {
    summarize("gate", { phase: 1, kind: "complete", contentLen: resumed.response.content.length });
  }

  // Phase 1 must produce a workspace artifact via write_file. Validate the
  // foundational invariants Phase 1 must satisfy (frontmatter present, no
  // L-System leakage); the Phase 1 Shell is partial, so the full seven-section
  // check is not asserted here.
  const workspaceDir = join(rootDir, "workspace");
  const files = await readdir(workspaceDir).catch(() => [] as string[]);
  const cardFiles = files.filter((f) => f.endsWith(".md"));
  expect(cardFiles.length, "Phase 1 did not write a workspace artifact").toBeGreaterThan(0);

  const cardContent = await readFile(join(workspaceDir, cardFiles[0]), "utf8");
  const validation = validateCharacterCard(cardContent);
  expect(
    validation.errors.some((e) => e.includes("YAML frontmatter")),
    "Phase 1 artifact missing YAML frontmatter",
  ).toBe(false);
  expect(
    validation.errors.every((e) => !e.includes("L-System")),
    "Phase 1 artifact leaked L-System content",
  ).toBe(true);
  summarize("gate", {
    artifact: cardFiles[0],
    chars: cardContent.length,
    validationOk: validation.ok,
    errors: validation.errors.length,
    warnings: validation.warnings.length,
  });
}, 120000);
