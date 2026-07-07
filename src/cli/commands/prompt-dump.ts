import { loadEngineProfile } from "../../core/engine/profile";
import type { EngineId, EngineProfile } from "../../core/engine/profile";
import { engineIds } from "../../core/engine/profile";
import type { PromptBundle } from "../../core/prompt/loader";
import { composeSystemPrompt, loadPromptBundle } from "../../core/prompt/loader";

/**
 * `vesicle prompt dump` — print the fully composed system prompt the model
 * would see for a given engine, plus the resolved profile and tool surface.
 *
 * This is the primary "is there host pollution?" audit tool: run it and
 * grep the output for Codex/Claude/RooCode/AGENTS.md/ask_followup_question
 * to confirm no host identity leaked into the engine prompt.
 *
 * Usage:
 *   vesicle prompt dump --engine etl        # full composed prompt
 *   vesicle prompt shape --engine etl       # structure summary only
 */
export async function runPromptDump(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    printUsage();
    process.exit(1);
  }

  const { engine, shapeOnly } = parsed.value;
  const profile = await loadEngineProfile(engine);
  const bundle = await loadPromptBundle(profile);
  const systemPrompt = composeSystemPrompt(bundle);

  if (shapeOnly) {
    printShape(profile, systemPrompt);
    return;
  }

  printFullDump(profile, bundle, systemPrompt);
}

type ParsedArgs = { ok: true; value: { engine: EngineId; shapeOnly: boolean } } | { ok: false; error: string };

function parseArgs(args: string[]): ParsedArgs {
  let engine: string | undefined;
  let shapeOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--engine" || arg === "-e") {
      engine = args[++i];
      continue;
    }
    if (arg === "--shape" || arg === "-s") {
      shapeOnly = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    return { ok: false, error: `Unknown argument: ${arg}` };
  }

  if (!engine) {
    return { ok: false, error: "Missing --engine." };
  }
  if (!engineIds.includes(engine as EngineId)) {
    return { ok: false, error: `Unknown engine "${engine}". Available: ${engineIds.join(", ")}.` };
  }

  return { ok: true, value: { engine: engine as EngineId, shapeOnly } };
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  vesicle prompt dump --engine <id>     Print the fully composed system prompt.");
  console.error("  vesicle prompt shape --engine <id>    Print profile structure and lengths only.");
  console.error("");
  console.error(`Engines: ${engineIds.join(", ")}`);
}

function printShape(profile: EngineProfile, systemPrompt: string): void {
  console.log(`Engine: ${profile.id} (${profile.displayName})`);
  console.log(`Protocol: ${profile.protocolVersion}`);
  console.log(`System prompt length: ${systemPrompt.length} chars`);
  console.log(`Sections: ${profile.systemPrompt.length}`);
  for (const path of profile.systemPrompt) {
    console.log(`  - ${path}`);
  }
  console.log(`Model-visible tools: ${profile.defaultTools.filter((t) => !["config.load", "prompt.load", "session.write"].includes(t)).join(", ")}`);
  console.log(`Host contracts: ${profile.defaultTools.filter((t) => ["config.load", "prompt.load", "session.write"].includes(t)).join(", ")}`);
  console.log(`Stop gates: ${profile.stopGates.length > 0 ? profile.stopGates.join(", ") : "(none)"}`);
  console.log(`Validators: ${profile.validators.length > 0 ? profile.validators.join(", ") : "(none)"}`);
  console.log(`State roots: ${profile.stateRoots.join(", ")}`);
}

function printFullDump(profile: EngineProfile, bundle: PromptBundle, systemPrompt: string): void {
  console.log("=== Prism Vesicle Prompt Dump ===");
  console.log(`Engine: ${profile.id} (${profile.displayName})`);
  console.log(`Protocol: ${profile.protocolVersion}`);
  console.log(`Tools: ${profile.defaultTools.join(", ")}`);
  console.log(`Stop gates: ${profile.stopGates.length > 0 ? profile.stopGates.join(", ") : "(none)"}`);
  console.log(`Validators: ${profile.validators.length > 0 ? profile.validators.join(", ") : "(none)"}`);
  console.log("");
  console.log("=== Sections ===");
  for (const section of bundle.sections) {
    console.log(`--- ${section.path} (${section.text.length} chars) ---`);
  }
  console.log("");
  console.log("=== Composed System Prompt ===");
  console.log(systemPrompt);
  console.log("");
  console.log("=== End (length: " + systemPrompt.length + " chars) ===");
}
