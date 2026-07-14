import { loadEngineProfile } from "../../core/engine/profile";
import type { EngineId, EngineProfile } from "../../core/engine/profile";
import { engineIds } from "../../core/engine/profile";
import type { PromptBundle } from "../../core/prompt/loader";
import { composeSystemPrompt, loadPromptBundle } from "../../core/prompt/loader";
import { createMcpRegistryForEngine, type McpRegistryOptions } from "../../mcp/registry";
import { loadPermissionSettings } from "../../config/permissions";
import { agentToolDefinitions } from "../../core/agents/tools";
import { resolveProjectHarnessRuntime } from "../../core/harness";

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
  const systemPrompt = composeSystemPrompt(bundle);
  const permissions = await loadPermissionSettings();

  if (shapeOnly) {
    await printShape(profile, bundle, systemPrompt, permissions.shellExec);
    return;
  }

  await printFullDump(profile, bundle, systemPrompt, permissions.shellExec);
}

type ParsedArgs = { ok: true; value: { engine: EngineId; shapeOnly: boolean } } | { ok: false; error: string };

const hostContractNames = new Set(["config.load", "prompt.load", "session.write"]);
const alwaysVisibleToolNames = ["ask_user_question", "request_engine_switch"];

export type EffectivePromptToolNames = {
  modelVisible: string[];
  hostContracts: string[];
};

export async function getEffectivePromptToolNames(
  profile: EngineProfile,
  options: McpRegistryOptions = {},
  shellExecEnabled = false,
): Promise<EffectivePromptToolNames> {
  const modelVisible: string[] = [];
  const hostContracts: string[] = [];

  for (const name of profile.defaultTools) {
    if (hostContractNames.has(name)) {
      pushUnique(hostContracts, name);
      continue;
    }
    if ((name === "shell_exec" || name === "shell_output" || name === "shell_stop") && !shellExecEnabled) continue;
    pushUnique(modelVisible, name);
  }

  if (profile.stopGates.length > 0) {
    pushUnique(modelVisible, "request_confirmation");
  }
  for (const name of alwaysVisibleToolNames) {
    pushUnique(modelVisible, name);
  }
  if (shellExecEnabled) {
    pushUnique(modelVisible, "shell_exec");
    pushUnique(modelVisible, "shell_output");
    pushUnique(modelVisible, "shell_stop");
  }
  for (const definition of agentToolDefinitions) {
    pushUnique(modelVisible, definition.function.name);
  }
  const mcp = await createMcpRegistryForEngine(profile.id, options);
  for (const definition of mcp.definitions) {
    pushUnique(modelVisible, definition.function.name);
  }

  return { modelVisible, hostContracts };
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
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

async function printShape(profile: EngineProfile, bundle: PromptBundle, systemPrompt: string, shellExecEnabled: boolean): Promise<void> {
  const effectiveTools = await getEffectivePromptToolNames(profile, {}, shellExecEnabled);

  console.log(`Engine: ${profile.id} (${profile.displayName})`);
  console.log(`Protocol: ${profile.protocolVersion}`);
  console.log(`System prompt length: ${systemPrompt.length} chars`);
  console.log(`Sections: ${profile.systemPrompt.length}`);
  for (const section of bundle.sections) {
    console.log(`  - ${section.path} [${section.source}]`);
  }
  console.log(`Model-visible tools: ${effectiveTools.modelVisible.join(", ")}`);
  console.log(`Host contracts: ${effectiveTools.hostContracts.join(", ")}`);
  console.log(`Stop gates: ${profile.stopGates.length > 0 ? profile.stopGates.join(", ") : "(none)"}`);
  console.log(`Validators: ${profile.validators.length > 0 ? profile.validators.join(", ") : "(none)"}`);
  console.log(`State roots: ${profile.stateRoots.join(", ")}`);
}

async function printFullDump(profile: EngineProfile, bundle: PromptBundle, systemPrompt: string, shellExecEnabled: boolean): Promise<void> {
  const effectiveTools = await getEffectivePromptToolNames(profile, {}, shellExecEnabled);

  console.log("=== Prism Vesicle Prompt Dump ===");
  console.log(`Engine: ${profile.id} (${profile.displayName})`);
  console.log(`Protocol: ${profile.protocolVersion}`);
  console.log(`Model-visible tools: ${effectiveTools.modelVisible.join(", ")}`);
  console.log(`Host contracts: ${effectiveTools.hostContracts.join(", ")}`);
  console.log(`Stop gates: ${profile.stopGates.length > 0 ? profile.stopGates.join(", ") : "(none)"}`);
  console.log(`Validators: ${profile.validators.length > 0 ? profile.validators.join(", ") : "(none)"}`);
  console.log("");
  console.log("=== Sections ===");
  for (const section of bundle.sections) {
    console.log(`--- ${section.path} [${section.source}] (${section.text.length} chars) ---`);
  }
  console.log("");
  console.log("=== Composed System Prompt ===");
  console.log(systemPrompt);
  console.log("");
  console.log("=== End (length: " + systemPrompt.length + " chars) ===");
}
