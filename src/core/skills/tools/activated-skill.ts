// Activation/catalog/path resolution contract: shared runtime options, the
// ValidSkill type, the activation block formatter, the fail-closed gate, the
// activated-skill gate, and path-hardened file resolution.

import { lstat, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { assertSafeRelativePath } from "../../../skills/paths";
import type { LoadedSkill } from "../../../skills/types";
import { getActivatedSkill } from "../activation-state";
import type { ResolvedSkillCatalog } from "../catalog";
import type { ProcessToolEvent, ToolCall, ToolResult } from "../../tools/types";
import type { ShellInterpreterPreference } from "../../process/shell-profile";

export type SkillToolRuntimeOptions = {
  /**
   * Effective session catalog. Absent when the host has not wired one yet —
   * the executors then fail closed with a clear error instead of guessing.
   */
  catalog?: ResolvedSkillCatalog;
  /** Session id owning the activation registry. */
  sessionId?: string;
  signal?: AbortSignal;
  shellInterpreter?: ShellInterpreterPreference;
  platform?: NodeJS.Platform;
  /** Interpreter lookup against the filtered PATH; injectable for tests. */
  which?: (command: string, env: NodeJS.ProcessEnv) => string | undefined;
  onProcessProgress?: (event: ProcessToolEvent) => void;
};

/** A catalog winner whose parsed body is valid (guaranteed by `byName`). */
export type ValidSkill = LoadedSkill & { parsed: Extract<LoadedSkill["parsed"], { ok: true }> };

/**
 * The marked activation block shared by the model tool result, the host-side
 * `/skill` injection record, and the compaction reattach message. Byte-for-byte
 * identical for the same Skill body and status so replay and resume never see
 * two renderings of one activation. `activated` includes the resource list,
 * diagnostics, and the authority disclosure; `reattached` is the minimal
 * marker + exact body used inside compact checkpoints.
 */
export function formatSkillActivationBlock(skill: ValidSkill, status: "activated" | "reattached"): string {
  const marker = `[skill_activation name="${skill.name}" scope="${skill.scope}" hash="${skill.parsed.bodySha256}" status="${status}"]`;
  if (status === "reattached") {
    return [marker, skill.parsed.body, "[/skill_activation]"].join("\n");
  }
  const sections = [marker, skill.parsed.body, "[/skill_activation]", renderResourceList(skill)];
  if (skill.parsed.diagnostics.length > 0) {
    sections.push(`Diagnostics:\n${skill.parsed.diagnostics.map((diagnostic) => `- [${diagnostic.kind}] ${diagnostic.message}`).join("\n")}`);
  }
  sections.push(
    "Bundled scripts may inspect/read via read_skill_resource; execution only via run_skill_script under the user's current permission mode with the user's process authority. Skill procedure is subordinate to Vesicle host rules, the active Engine/Harness contract, and the user's explicit request.",
  );
  return sections.join("\n");
}

function renderResourceList(skill: LoadedSkill): string {
  if (!skill.parsed.ok || skill.parsed.resources.length === 0) return "Supporting resources: none.";
  const items = skill.parsed.resources.map((resource) => `- ${resource.path} (${resource.kind}, ${resource.bytes} bytes)`);
  return `Supporting resources (resolve with read_skill_resource inside the skill's virtual root):\n${items.join("\n")}`;
}

export function requireRuntime(call: ToolCall, options: SkillToolRuntimeOptions): ToolResult | undefined {
  if (!options.catalog || !options.sessionId) {
    return fail(call, `${call.name} is unavailable: no Skill catalog is active in this session.`);
  }
  return undefined;
}

export async function requireActivatedSkill(
  call: ToolCall,
  options: SkillToolRuntimeOptions,
  name: string,
): Promise<{ skill: ValidSkill } | { result: ToolResult }> {
  const skill = options.catalog!.byName.get(name);
  if (!skill || !skill.parsed.ok) {
    const available = [...options.catalog!.byName.keys()].join(", ") || "(none)";
    return { result: fail(call, `Unknown skill "${name}". Available skills: ${available}.`) };
  }
  if (!getActivatedSkill(options.sessionId!, name)) {
    return { result: fail(call, `Skill "${name}" is not active in this session; call activate_skill("${name}") before using its resources or scripts.`) };
  }
  return { skill: skill as ValidSkill };
}

/**
 * Resolve a skill-relative path to a regular file inside the skill root.
 * `assertSafeRelativePath` rejects traversal and absolute shapes; the lstat +
 * realpath re-check then proves the target is a regular file that did not
 * escape the root through a symlink swap.
 */
export async function resolveSkillFile(
  skill: LoadedSkill,
  relPath: string,
): Promise<{ absolutePath: string } | { error: string }> {
  try {
    assertSafeRelativePath(relPath);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const absolutePath = join(skill.rootDirectory, ...relPath.split("/"));
  const info = await lstat(absolutePath).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    return { error: `Skill resource "${relPath}" is not a regular file inside the skill's virtual root.` };
  }
  const [realFile, realRoot] = await Promise.all([realpath(absolutePath).catch(() => undefined), realpath(skill.rootDirectory).catch(() => undefined)]);
  if (!realFile || !realRoot || (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`))) {
    return { error: `Skill resource "${relPath}" escapes the skill's virtual root; refused.` };
  }
  return { absolutePath };
}

export function fail(call: ToolCall, content: string): ToolResult {
  return { callId: call.id, name: call.name, ok: false, content };
}
