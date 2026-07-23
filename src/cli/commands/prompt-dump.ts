import { loadEngineProfile } from "../../core/engine/profile";
import type { EngineId, EngineProfile } from "../../core/engine/profile";
import { engineIds } from "../../core/engine/profile";
import type { PromptBundle } from "../../core/prompt/loader";
import { composeSystemPrompt, loadPromptBundle } from "../../core/prompt/loader";
import { INSTRUCTION_COMBINED_BUDGET_BYTES, composeSystemPromptWithInstructions } from "../../core/instructions";
import type { EffectiveInstructionSelection } from "../../core/instructions";
import type { McpRegistryOptions } from "../../mcp/registry";
import { loadPermissionSettings } from "../../config/permissions";
import { resolveToolSurface } from "../../core/agent-loop/tool-surface";
import { resolveProjectHarnessRuntime } from "../../core/harness";
import type { ShellInterpreterPreference } from "../../core/process/shell-profile";
import type { AssetResolver } from "../../core/runtime/assets";

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
  const rootDir = process.cwd();
  const harness = await resolveProjectHarnessRuntime(rootDir);
  const profile = await loadEngineProfile(engine, rootDir, harness?.assets);
  const bundle = await loadPromptBundle(profile, rootDir, harness?.assets);
  const enginePrompt = composeSystemPrompt(bundle);
  // Prompt shape/dump is not session-aware: it resolves current-disk Persistent
  // Instructions the way a new session launched now would.
  const instructional = await composeSystemPromptWithInstructions(engine, enginePrompt, rootDir);
  const systemPrompt = instructional.systemPrompt;
  const permissions = await loadPermissionSettings();

  if (shapeOnly) {
    await printShape(profile, bundle, systemPrompt, instructional.selection, permissions.shellExec, permissions.shellInterpreter, harness?.assets);
    return;
  }

  await printFullDump(profile, bundle, systemPrompt, instructional.selection, permissions.shellExec, permissions.shellInterpreter, harness?.assets);
}

type ParsedArgs = { ok: true; value: { engine: EngineId; shapeOnly: boolean } } | { ok: false; error: string };

export type EffectivePromptToolNames = {
  modelVisible: string[];
};

export async function getEffectivePromptToolNames(
  profile: EngineProfile,
  options: McpRegistryOptions = {},
  shellExecEnabled = false,
  shellInterpreter: ShellInterpreterPreference = "auto",
): Promise<EffectivePromptToolNames> {
  const surface = await resolveToolSurface(profile, true, shellExecEnabled, shellInterpreter, options);
  return {
    modelVisible: surface.definitions.map((definition) => definition.function.name),
  };
}

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

async function printShape(
  profile: EngineProfile,
  bundle: PromptBundle,
  systemPrompt: string,
  instructions: EffectiveInstructionSelection,
  shellExecEnabled: boolean,
  shellInterpreter: ShellInterpreterPreference,
  assets?: AssetResolver,
): Promise<void> {
  const effectiveTools = await getEffectivePromptToolNames(profile, {}, shellExecEnabled, shellInterpreter);

  console.log(`Engine: ${profile.id} (${profile.displayName})`);
  console.log(`Protocol: ${profile.protocolVersion}`);
  console.log(`System prompt length: ${[...systemPrompt].length} chars (${Buffer.byteLength(systemPrompt, "utf8")} bytes)`);
  console.log(`Sections: ${profile.systemPrompt.length}`);
  for (const section of bundle.sections) {
    console.log(`  - ${section.path} [${section.source}] (${[...section.text].length} chars, ${Buffer.byteLength(section.text, "utf8")} bytes)`);
  }
  printInstructionShape(instructions);
  const ledger = assets ? await loadStaticAssetLedger(assets, profile.id) : undefined;
  printStaticAssetLedger(profile.id, ledger);
  console.log(`Model-visible tools: ${effectiveTools.modelVisible.join(", ")}`);
  console.log(`Stop gates: ${profile.stopGates.length > 0 ? profile.stopGates.join(", ") : "(none)"}`);
  console.log(`Validators: ${profile.validators.length > 0 ? profile.validators.join(", ") : "(none)"}`);
  console.log(`State roots: ${profile.stateRoots.join(", ")}`);
}

async function printFullDump(
  profile: EngineProfile,
  bundle: PromptBundle,
  systemPrompt: string,
  instructions: EffectiveInstructionSelection,
  shellExecEnabled: boolean,
  shellInterpreter: ShellInterpreterPreference,
  assets?: AssetResolver,
): Promise<void> {
  const effectiveTools = await getEffectivePromptToolNames(profile, {}, shellExecEnabled, shellInterpreter);

  console.log("=== Prism Vesicle Prompt Dump ===");
  console.log(`Engine: ${profile.id} (${profile.displayName})`);
  console.log(`Protocol: ${profile.protocolVersion}`);
  console.log(`Model-visible tools: ${effectiveTools.modelVisible.join(", ")}`);
  console.log(`Stop gates: ${profile.stopGates.length > 0 ? profile.stopGates.join(", ") : "(none)"}`);
  console.log(`Validators: ${profile.validators.length > 0 ? profile.validators.join(", ") : "(none)"}`);
  console.log("");
  console.log("=== Sections ===");
  for (const section of bundle.sections) {
    console.log(`--- ${section.path} [${section.source}] (${[...section.text].length} chars, ${Buffer.byteLength(section.text, "utf8")} bytes) ---`);
  }
  printInstructionShape(instructions);
  const ledger = assets ? await loadStaticAssetLedger(assets, profile.id) : undefined;
  printStaticAssetLedger(profile.id, ledger);
  console.log("");
  console.log("=== Composed System Prompt ===");
  console.log(systemPrompt);
  console.log("");
  console.log("=== End (length: " + [...systemPrompt].length + " chars) ===");
}

function printInstructionShape(instructions: EffectiveInstructionSelection): void {
  const files = [instructions.user, instructions.project].filter((file): file is NonNullable<typeof file> => Boolean(file));
  console.log("Persistent instructions:");
  if (files.length === 0 && instructions.diagnostics.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const file of files) {
    const override = file.target.engine !== "all" ? `, engine override ${file.target.engine}` : "";
    const empty = file.empty ? ", empty override" : "";
    console.log(`  - ${file.logicalName} [${file.target.scope}${override}] (${file.bytes} bytes${empty}, sha256 ${file.sha256.slice(0, 8)})`);
  }
  console.log(`Persistent instruction budget: ${instructions.combinedBytes} / ${INSTRUCTION_COMBINED_BUDGET_BYTES} bytes`);
  for (const diagnostic of instructions.diagnostics) {
    console.log(`  ! ${diagnostic.logicalName} [${diagnostic.scope}]: ${diagnostic.kind} — ${diagnostic.message}`);
  }
}

type StaticAssetLedgerEntry = { budgetCharacters: number; remainingCharacters: number };

function printStaticAssetLedger(engine: EngineId, ledger: StaticAssetLedgerEntry | undefined): void {
  if (!ledger) return;
  console.log(`Static Harness asset limit: ${ledger.budgetCharacters} chars; unallocated static asset budget: ${ledger.remainingCharacters} chars`);
  if (engine === "stage") {
    console.log("Stage runtime context is excluded: /stage adds frozen Module A system text and Module B assistant history; the static asset limit never blocks the assembled request.");
  }
}

async function loadStaticAssetLedger(assets: AssetResolver, engine: EngineId): Promise<StaticAssetLedgerEntry | undefined> {
  const source = await assets.readText("assets/prompt-context-ledger.json").catch(() => undefined);
  if (!source) return undefined;
  try {
    const parsed = JSON.parse(source) as { engines?: Record<string, StaticAssetLedgerEntry> };
    const entry = parsed.engines?.[engine];
    return entry && Number.isInteger(entry.budgetCharacters) && Number.isInteger(entry.remainingCharacters) ? entry : undefined;
  } catch {
    return undefined;
  }
}
