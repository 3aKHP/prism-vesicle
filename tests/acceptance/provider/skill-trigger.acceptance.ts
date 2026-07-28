/**
 * Skill trigger evaluation (Phase 2 Wave D).
 *
 * Validates that the model activates the correct Skill for should-trigger
 * prompts and refrains from activation for near-miss prompts. Gated by
 * BUN_E2E_REAL_PROVIDER=1; skips (not passes) when the precondition is unmet.
 *
 * Each prompt is run through a single-turn agent loop with the pilot Skill
 * catalog injected. The assertion is whether the model called `activate_skill`
 * with the expected name (positive) or did not call it (negative).
 */
import { afterEach, beforeEach, expect, test, describe } from "bun:test";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPrompt } from "../../../src/core/agent-loop/run";
import type { AgentLoopEvent } from "../../../src/core/agent-loop/types";
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

const fixturesRoot = join(import.meta.dir, "..", "..", "fixtures", "pilot-skills");

type TriggerCase = { prompt: string; expectSkill?: string };

const reviewRubricCases: TriggerCase[] = [
  { prompt: "Please review the latest chapter against our quality rubric.", expectSkill: "review-rubric" },
  { prompt: "Critique this scene using the structured editorial dimensions.", expectSkill: "review-rubric" },
  { prompt: "Score the prose craft and narrative coherence of workspace/chapter-3.md.", expectSkill: "review-rubric" },
  { prompt: "Apply the review rubric to the draft and give me dimension scores.", expectSkill: "review-rubric" },
  { prompt: "How does this passage rate on canon fidelity and reader engagement?", expectSkill: "review-rubric" },
  { prompt: "Give me a structured quality assessment of the narrative.", expectSkill: "review-rubric" },
  { prompt: "Evaluate the writing quality using the five-dimension rubric.", expectSkill: "review-rubric" },
  { prompt: "Assess this output against the editorial review criteria.", expectSkill: "review-rubric" },
  // Near-miss: should NOT trigger review-rubric
  { prompt: "Run the Evaluate engine on the current artifact." },
  { prompt: "Validate the character card against Module A." },
  { prompt: "Check if the scenario card passes Module B validation." },
  { prompt: "Generate a PASS/FAIL audit report for this deliverable." },
  { prompt: "Rewrite the paragraph to improve flow." },
  { prompt: "Summarize the research notes into a brief." },
  { prompt: "Prepare the workspace artifacts for delivery." },
  { prompt: "Convert the markdown output to a Word document." },
];

const artifactHandoffCases: TriggerCase[] = [
  { prompt: "Prepare the completed chapters for external delivery.", expectSkill: "artifact-handoff" },
  { prompt: "Package the workspace drafts with delivery headers.", expectSkill: "artifact-handoff" },
  { prompt: "Format the artifacts for handoff to the editor.", expectSkill: "artifact-handoff" },
  { prompt: "Apply the delivery template to the finished novels.", expectSkill: "artifact-handoff" },
  { prompt: "Generate a delivery manifest for the workspace outputs.", expectSkill: "artifact-handoff" },
  { prompt: "Make the drafts delivery-ready with metadata blocks.", expectSkill: "artifact-handoff" },
  { prompt: "Hand off the completed artifacts with proper formatting.", expectSkill: "artifact-handoff" },
  { prompt: "Add delivery headers and generate the manifest.", expectSkill: "artifact-handoff" },
  // Near-miss
  { prompt: "Review the prose quality of the latest chapter." },
  { prompt: "Validate the character card frontmatter." },
  { prompt: "Synthesize the research notes into a brief." },
  { prompt: "Run the evaluate engine and produce an audit report." },
  { prompt: "Rewrite the dialogue to sound more natural." },
  { prompt: "Count the words in source_materials/notes.md." },
  { prompt: "Switch to the Weaver engine for the next scene." },
  { prompt: "Compact the session context." },
];

const researchSynthesisCases: TriggerCase[] = [
  { prompt: "Synthesize the research notes into a structured brief.", expectSkill: "research-synthesis" },
  { prompt: "Consolidate the source materials on this topic.", expectSkill: "research-synthesis" },
  { prompt: "Produce a research brief from the scattered notes.", expectSkill: "research-synthesis" },
  { prompt: "Summarize and cluster the claims across all source documents.", expectSkill: "research-synthesis" },
  { prompt: "Merge the research materials into one coherent overview.", expectSkill: "research-synthesis" },
  { prompt: "Extract the key claims from source_materials and resolve conflicts.", expectSkill: "research-synthesis" },
  { prompt: "Create a thematic synthesis of the background research.", expectSkill: "research-synthesis" },
  { prompt: "Build a research brief with source citations from the notes.", expectSkill: "research-synthesis" },
  // Near-miss
  { prompt: "Review the latest chapter against the quality rubric." },
  { prompt: "Prepare the artifacts for delivery to the editor." },
  { prompt: "Validate the scenario card structure." },
  { prompt: "Rewrite the opening paragraph for better hook." },
  { prompt: "Run the evaluate engine on the current output." },
  { prompt: "Switch to the ETL engine for the next phase." },
  { prompt: "List the files in the workspace directory." },
  { prompt: "Compact the conversation to free context." },
];

const vesicleDocsCases: TriggerCase[] = [
  // Positive Chinese
  { prompt: "Vesicle 的 auto-compact 怎么配置？", expectSkill: "vesicle-docs" },
  { prompt: "为什么我看不到 shell_exec？", expectSkill: "vesicle-docs" },
  { prompt: "Gemini provider 的 providers.yaml 应该怎么写？", expectSkill: "vesicle-docs" },
  { prompt: "rewind、compact 和 resume 有什么区别？", expectSkill: "vesicle-docs" },
  { prompt: "怎么安装、调用和禁用一个 Skill？", expectSkill: "vesicle-docs" },
  { prompt: "Stage 为什么不能使用 Skills？", expectSkill: "vesicle-docs" },
  // Positive English
  { prompt: "How do I configure MCP in Vesicle?", expectSkill: "vesicle-docs" },
  { prompt: "Where does Vesicle store provider secrets?", expectSkill: "vesicle-docs" },
  { prompt: "How does the session Skill catalog behave after an upgrade?", expectSkill: "vesicle-docs" },
  // Near-miss: ordinary Prism creative work and generic technical questions
  { prompt: "帮我写一张角色卡。" },
  { prompt: "继续这个场景。" },
  { prompt: "Review this chapter for continuity." },
  { prompt: "How does YAML parsing work in general?" },
];

let rootDir: string | undefined;
beforeEach(async () => {
  if (!precondition.ok) return;
  rootDir = await createAcceptanceRoot();
  await cp(fixturesRoot, join(rootDir!, "assets", "skills"), { recursive: true });
  await mkdir(join(rootDir!, "source_materials"), { recursive: true });
  await writeFile(join(rootDir!, "source_materials", "note-a.md"), "# Note A\nClaim one. Claim two.\n", "utf8");
  await writeFile(join(rootDir!, "source_materials", "note-b.md"), "# Note B\nClaim three. Contradicts claim one.\n", "utf8");
});
afterEach(async () => {
  if (rootDir) {
    await removeAcceptanceRoot(rootDir);
    rootDir = undefined;
  }
});

function collectSkillActivations(events: AgentLoopEvent[]): string[] {
  const names: string[] = [];
  for (const event of events) {
    if (event.type === "tool_result" && "skillEvent" in event && event.skillEvent?.kind === "skill_activation") {
      names.push((event.skillEvent as { name: string }).name);
    }
  }
  return names;
}

function collectResourceReads(events: AgentLoopEvent[]): string[] {
  const paths: string[] = [];
  for (const event of events) {
    if (event.type === "tool_result" && "skillEvent" in event && event.skillEvent?.kind === "skill_resource_read") {
      paths.push((event.skillEvent as { path: string }).path);
    }
  }
  return paths;
}

interface TriggerResult {
  activations: string[];
  resourceReads: string[];
}

async function runTriggerCase(triggerCase: TriggerCase): Promise<TriggerResult> {
  if (!rootDir) throw new Error("acceptance rootDir was not initialized");
  const events: AgentLoopEvent[] = [];
  await runPrompt({
    input: triggerCase.prompt,
    engine: "etl",
    rootDir,
    messages: [{ role: "user", content: triggerCase.prompt }],
    onEvent: (event) => { events.push(event); },
  });
  return { activations: collectSkillActivations(events), resourceReads: collectResourceReads(events) };
}

describe.skipIf(!precondition.ok)(`skill trigger evaluation [${label}]`, () => {
  test("review-rubric: positive triggers activate the skill", async () => {
    const positives = reviewRubricCases.filter((c) => c.expectSkill);
    let hits = 0;
    for (const triggerCase of positives) {
      const result = await runTriggerCase(triggerCase);
      if (result.activations.includes("review-rubric")) hits += 1;
    }
    summarize("trigger-review-rubric-positive", { total: positives.length, hits });
    expect(hits).toBeGreaterThanOrEqual(Math.ceil(positives.length * 0.6));
  });

  test("review-rubric: near-miss prompts do not activate", async () => {
    const negatives = reviewRubricCases.filter((c) => !c.expectSkill);
    let falsePositives = 0;
    for (const triggerCase of negatives) {
      const result = await runTriggerCase(triggerCase);
      if (result.activations.includes("review-rubric")) falsePositives += 1;
    }
    summarize("trigger-review-rubric-negative", { total: negatives.length, falsePositives });
    expect(falsePositives).toBeLessThanOrEqual(Math.floor(negatives.length * 0.25));
  });

  test("artifact-handoff: positive triggers activate the skill", async () => {
    const positives = artifactHandoffCases.filter((c) => c.expectSkill);
    let hits = 0;
    for (const triggerCase of positives) {
      const result = await runTriggerCase(triggerCase);
      if (result.activations.includes("artifact-handoff")) hits += 1;
    }
    summarize("trigger-artifact-handoff-positive", { total: positives.length, hits });
    expect(hits).toBeGreaterThanOrEqual(Math.ceil(positives.length * 0.6));
  });

  test("artifact-handoff: near-miss prompts do not activate", async () => {
    const negatives = artifactHandoffCases.filter((c) => !c.expectSkill);
    let falsePositives = 0;
    for (const triggerCase of negatives) {
      const result = await runTriggerCase(triggerCase);
      if (result.activations.includes("artifact-handoff")) falsePositives += 1;
    }
    summarize("trigger-artifact-handoff-negative", { total: negatives.length, falsePositives });
    expect(falsePositives).toBeLessThanOrEqual(Math.floor(negatives.length * 0.25));
  });

  test("research-synthesis: positive triggers activate the skill", async () => {
    const positives = researchSynthesisCases.filter((c) => c.expectSkill);
    let hits = 0;
    for (const triggerCase of positives) {
      const result = await runTriggerCase(triggerCase);
      if (result.activations.includes("research-synthesis")) hits += 1;
    }
    summarize("trigger-research-synthesis-positive", { total: positives.length, hits });
    expect(hits).toBeGreaterThanOrEqual(Math.ceil(positives.length * 0.6));
  });

  test("research-synthesis: near-miss prompts do not activate", async () => {
    const negatives = researchSynthesisCases.filter((c) => !c.expectSkill);
    let falsePositives = 0;
    for (const triggerCase of negatives) {
      const result = await runTriggerCase(triggerCase);
      if (result.activations.includes("research-synthesis")) falsePositives += 1;
    }
    summarize("trigger-research-synthesis-negative", { total: negatives.length, falsePositives });
    expect(falsePositives).toBeLessThanOrEqual(Math.floor(negatives.length * 0.25));
  });

  test("vesicle-docs: positive triggers activate the skill and read resources", async () => {
    const positives = vesicleDocsCases.filter((c) => c.expectSkill);
    let hits = 0;
    let resourceHits = 0;
    for (const triggerCase of positives) {
      const result = await runTriggerCase(triggerCase);
      if (result.activations.includes("vesicle-docs")) {
        hits += 1;
        if (result.resourceReads.length > 0) resourceHits += 1;
      }
    }
    summarize("trigger-vesicle-docs-positive", { total: positives.length, hits, resourceHits });
    expect(hits).toBeGreaterThanOrEqual(Math.ceil(positives.length * 0.6));
    expect(resourceHits).toBeGreaterThanOrEqual(Math.ceil(hits * 0.5));
  }, 180_000);

  test("vesicle-docs: near-miss prompts do not activate", async () => {
    const negatives = vesicleDocsCases.filter((c) => !c.expectSkill);
    let falsePositives = 0;
    for (const triggerCase of negatives) {
      const result = await runTriggerCase(triggerCase);
      if (result.activations.includes("vesicle-docs")) falsePositives += 1;
    }
    summarize("trigger-vesicle-docs-negative", { total: negatives.length, falsePositives });
    expect(falsePositives).toBeLessThanOrEqual(Math.floor(negatives.length * 0.25));
  }, 120_000);
});
