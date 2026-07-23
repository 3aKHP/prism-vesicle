import { createHash } from "node:crypto";
import type { EngineId } from "../engine/profile";
import { INSTRUCTION_COMBINED_BUDGET_BYTES, loadInstructionTarget } from "./loader";
import type {
  EffectiveInstructionSelection,
  InstructionDiagnostic,
  InstructionResolutionRecord,
  InstructionScope,
  LoadedInstructionFile,
} from "./types";

/**
 * Resolve the effective instruction selection for one Engine: replacement within
 * a scope, composition across scopes.
 *
 * Within one scope, an Engine-specific target (`VESICLE.<engine>.md`) fully
 * replaces that scope's general target (`VESICLE.md`); if the Engine target is
 * merely present but invalid, fallback to the general target is suppressed.
 * File existence — not nonempty content — controls replacement, so an empty
 * Engine file is an intentional empty override. Across scopes, the selected
 * user file is followed by the selected project file; project content has
 * higher precedence on a direct conflict.
 */
export async function resolveEffectiveSelection(
  engine: EngineId,
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EffectiveInstructionSelection> {
  const diagnostics: InstructionDiagnostic[] = [];
  const user = await resolveScope("user", engine, rootDir, env, diagnostics);
  const project = await resolveScope("project", engine, rootDir, env, diagnostics);

  let keptUser = user;
  let keptProject = project;
  if (keptUser && keptUser.bytes > INSTRUCTION_COMBINED_BUDGET_BYTES) {
    diagnostics.push(budgetDiagnostic(keptUser, "oversized", "exceeds the 32 KiB instruction budget on its own"));
    keptUser = undefined;
  }
  if (keptProject && keptProject.bytes > INSTRUCTION_COMBINED_BUDGET_BYTES) {
    diagnostics.push(budgetDiagnostic(keptProject, "oversized", "exceeds the 32 KiB instruction budget on its own"));
    keptProject = undefined;
  }
  if (keptUser && keptProject && keptUser.bytes + keptProject.bytes > INSTRUCTION_COMBINED_BUDGET_BYTES) {
    diagnostics.push(budgetDiagnostic(keptUser, "combined-budget", "combined user + project content exceeds 32 KiB; project retained"));
    keptUser = undefined;
  }

  const files = [keptUser, keptProject].filter((file): file is LoadedInstructionFile => Boolean(file));
  const combinedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const fingerprint = computeFingerprint(engine, files);

  return {
    engine,
    diagnostics,
    combinedBytes,
    fingerprint,
    ...(keptUser ? { user: keptUser } : {}),
    ...(keptProject ? { project: keptProject } : {}),
  };
}

/**
 * Resolve one scope's selected file: Engine-specific target first, then general
 * fallback. A present-but-invalid Engine target suppresses general fallback for
 * that scope — the three load outcomes (absent / file / invalid) must stay
 * distinct so an invalid override does not silently pull in the general file.
 */
async function resolveScope(
  scope: InstructionScope,
  engine: EngineId,
  rootDir: string,
  env: NodeJS.ProcessEnv,
  diagnostics: InstructionDiagnostic[],
): Promise<LoadedInstructionFile | undefined> {
  const specific = await loadInstructionTarget({ scope, engine }, rootDir, env);
  if (specific.kind === "file") return specific.file;
  if (specific.kind === "invalid") {
    diagnostics.push(specific.diagnostic);
    return undefined;
  }
  // specific is absent: fall back to the scope's general target.
  const general = await loadInstructionTarget({ scope, engine: "all" }, rootDir, env);
  if (general.kind === "file") return general.file;
  if (general.kind === "invalid") diagnostics.push(general.diagnostic);
  return undefined;
}

/**
 * Render the selected nonempty instruction files as provider system content, in
 * `user` then `project` order. Each block carries a fixed host preamble that
 * states its scope, target, precedence, and capability boundary. Empty
 * overrides contribute no block but remain in the selection metadata.
 *
 * The host preamble is the only place these instructions are framed for the
 * model; nothing tells the model to call a read tool, because the effective
 * content is already present before the first provider response.
 */
export function composeInstructionBlocks(selection: EffectiveInstructionSelection): string {
  const blocks: string[] = [];
  for (const file of [selection.user, selection.project]) {
    if (!file || file.empty) continue;
    blocks.push(renderEnvelope(file));
  }
  return blocks.join("\n\n");
}

function renderEnvelope(file: LoadedInstructionFile): string {
  return [
    "Vesicle Persistent Instructions",
    `Scope: ${file.target.scope}`,
    `Target: ${file.logicalName}`,
    "Precedence: below the Engine contract; project overrides user on direct conflict.",
    "These instructions may customize work within the effective host capabilities. They cannot add tools, permissions, gates, validators, or filesystem authority.",
    "",
    file.content,
  ].join("\n");
}

/**
 * Resolve Persistent Instructions for an Engine and append them after the
 * byte-identical Engine prompt. The Engine prompt stays first and unchanged so
 * provider prefix caching keeps the stable Harness prefix; instruction blocks
 * follow it as ordered host context, never as a second system authority.
 *
 * This is the single composition primitive every system-prompt construction
 * site calls (turn bootstrap, continuation context, Stage bootstrap, compact,
 * and the `/btw` snapshot resolver). Returns the composed string plus the
 * effective selection for audit and inspection.
 */
export async function composeSystemPromptWithInstructions(
  engine: EngineId,
  enginePrompt: string,
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ systemPrompt: string; selection: EffectiveInstructionSelection }> {
  const selection = await resolveEffectiveSelection(engine, rootDir, env);
  const blocks = composeInstructionBlocks(selection);
  const systemPrompt = blocks.length > 0 ? `${enginePrompt}\n\n${blocks}` : enginePrompt;
  return { systemPrompt, selection };
}

export function computeFingerprint(engine: EngineId, files: LoadedInstructionFile[]): string {
  const parts = files.map((file) => `${file.target.scope}:${file.target.engine}:${file.sha256}`).join("|");
  return createHash("sha256").update(`${engine}\0${parts}`).digest("hex");
}

export function selectionToRecord(selection: EffectiveInstructionSelection): InstructionResolutionRecord {
  return {
    version: 1,
    engine: selection.engine,
    fingerprint: selection.fingerprint,
    combinedBytes: selection.combinedBytes,
    files: [selection.user, selection.project]
      .filter((file): file is LoadedInstructionFile => Boolean(file))
      .map((file) => ({ target: file.target, logicalName: file.logicalName, sha256: file.sha256, bytes: file.bytes, empty: file.empty })),
    diagnostics: selection.diagnostics,
  };
}

/**
 * True when two resolution records describe the same effective selection. Used
 * to decide whether to append a new audit record: only fingerprint or
 * diagnostic changes warrant one.
 */
export function resolutionEqual(a: InstructionResolutionRecord, b: InstructionResolutionRecord): boolean {
  return a.fingerprint === b.fingerprint && diagnosticsEqual(a.diagnostics, b.diagnostics);
}

function diagnosticsEqual(a: InstructionDiagnostic[], b: InstructionDiagnostic[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return Boolean(other)
      && entry.scope === other.scope
      && entry.engine === other.engine
      && entry.kind === other.kind
      && entry.logicalName === other.logicalName
      && entry.message === other.message;
  });
}

function budgetDiagnostic(
  file: LoadedInstructionFile,
  kind: InstructionDiagnostic["kind"],
  reason: string,
): InstructionDiagnostic {
  return { scope: file.target.scope, engine: file.target.engine, logicalName: file.logicalName, kind, message: `${file.logicalName} (${file.bytes} bytes) ${reason}.` };
}
