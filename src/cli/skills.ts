import { resolve } from "node:path";
import { userConfigDirectory } from "../config/paths";
import { resolveProjectHarnessRuntime } from "../core/harness";
import { createAssetResolver } from "../core/runtime/assets";
import { dirname, join } from "node:path";
import { discoverSkills, listChildSkillRoots, loadSkill } from "../skills";
import type { DiscoveryResult, LoadedSkill } from "../skills";

/** Resolve Harness skill roots from the active verified Harness (`assets/skills/<name>/SKILL.md`). */
async function resolveHarnessSkillRoots(projectRoot: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const runtime = await resolveProjectHarnessRuntime(projectRoot, { env }).catch(() => undefined);
  const resolver = runtime?.assets ?? createAssetResolver(projectRoot, { env });
  let files: string[];
  try {
    files = await resolver.listFiles("assets/skills", true);
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const file of files) {
    const match = /^assets\/skills\/([^/]+)\/SKILL\.md$/.exec(file);
    if (!match) continue;
    const resolved = await resolver.resolveFile(file).catch(() => undefined);
    if (resolved) roots.push(dirname(resolved.absolutePath));
  }
  return roots;
}

export interface SkillsInspection {
  result: DiscoveryResult;
  harnessRootCount: number;
  userRootCount: number;
}

/**
 * Discover skills across the Phase 0 scopes for the active project. Used by both
 * `vesicle skills list` and `vesicle doctor`. Best-effort: a Harness resolution
 * failure falls back to the default asset resolver so user-scope skills still
 * surface.
 */
export async function inspectSkills(
  projectRoot = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<SkillsInspection> {
  const harnessRoots = await resolveHarnessSkillRoots(projectRoot, env);
  const userRoots = await listChildSkillRoots(join(userConfigDirectory(env), "skills"));
  const result = await discoverSkills({ harnessRoots, userRoots });
  return { result, harnessRootCount: harnessRoots.length, userRootCount: userRoots.length };
}

export async function runSkillsCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (command === "list" && args.length === 1) {
    await runList();
    return;
  }
  if (command === "validate" && args.length === 2) {
    await runValidate(args[1]!);
    return;
  }
  if (command === "inspect" && args.length === 2) {
    await runInspect(args[1]!);
    return;
  }
  printUsage();
  process.exitCode = 1;
}

async function runList(): Promise<void> {
  const inspection = await inspectSkills();
  const { result } = inspection;
  const shadowed = result.diagnostics.filter((diagnostic) => diagnostic.kind === "shadowed").length;

  console.log("Prism Vesicle Skills");
  if (result.skills.length === 0 && result.invalid.length === 0) {
    console.log("No skills discovered (harness and user scopes).");
    return;
  }
  for (const skill of result.skills) {
    const description = skill.parsed.ok ? skill.parsed.metadata.description : "";
    console.log(`  ${skill.name}  [${skill.scope}]  ${truncate(description, 64)}`);
  }
  if (result.invalid.length > 0) {
    console.log("Invalid:");
    for (const skill of result.invalid) {
      const message = firstDiagnostic(skill);
      console.log(`  ${skill.name}  [${skill.scope}]  ${message}`);
    }
  }
  if (shadowed > 0) {
    console.log("Shadowed:");
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.kind === "shadowed") console.log(`  ${diagnostic.message}`);
    }
  }
  console.log(`Summary: ${result.skills.length} valid, ${result.invalid.length} invalid, ${shadowed} shadowed`);
}

async function runValidate(target: string): Promise<void> {
  const loaded = await loadSkill(resolve(target), "user");
  console.log("Prism Vesicle Skill Validation");
  console.log(`Path: ${target}`);
  if (loaded.parsed.ok) {
    console.log(`Name: ${loaded.parsed.metadata.name}`);
    console.log(`Description: ${loaded.parsed.metadata.description}`);
    printExtraMetadata(loaded.parsed.metadata);
    printDiagnostics(loaded.parsed.diagnostics);
    console.log(`Resources: ${loaded.parsed.resources.length}`);
    console.log("OK");
    return;
  }
  console.log(`Name: ${loaded.name}`);
  printDiagnostics(loaded.parsed.diagnostics);
  console.log("INVALID");
  process.exitCode = 1;
}

async function runInspect(name: string): Promise<void> {
  const inspection = await inspectSkills();
  const skill = [...inspection.result.skills, ...inspection.result.invalid].find((entry) => entry.name === name);
  if (!skill) {
    console.error(`No skill named "${name}" found in the harness or user scope.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Name: ${skill.name}`);
  console.log(`Scope: ${skill.scope}`);
  if (skill.parsed.ok) {
    const { metadata, resources, diagnostics } = skill.parsed;
    console.log(`Description: ${metadata.description}`);
    printExtraMetadata(metadata);
    console.log(`Resources: ${resources.length}`);
    for (const resource of resources.slice(0, 20)) {
      console.log(`  ${resource.path}  (${resource.kind}, ${resource.bytes} bytes)`);
    }
    if (resources.length > 20) console.log(`  …and ${resources.length - 20} more`);
    printDiagnostics(diagnostics);
  } else {
    printDiagnostics(skill.parsed.diagnostics);
    console.log("INVALID");
    process.exitCode = 1;
  }
}

function printExtraMetadata(metadata: { license?: string; compatibility?: string; metadata?: Record<string, string>; allowedTools?: string[]; unknownFields: string[] }): void {
  if (metadata.license !== undefined) console.log(`License: ${metadata.license}`);
  if (metadata.compatibility !== undefined) console.log(`Compatibility: ${metadata.compatibility}`);
  if (metadata.metadata) {
    const entries = Object.entries(metadata.metadata);
    if (entries.length > 0) {
      console.log("Metadata:");
      for (const [key, value] of entries) console.log(`  ${key}: ${value}`);
    }
  }
  if (metadata.unknownFields.length > 0) {
    console.log(`Unsupported fields: ${metadata.unknownFields.join(", ")}`);
  }
}

function printDiagnostics(diagnostics: readonly { kind: string; message: string }[]): void {
  if (diagnostics.length === 0) {
    console.log("Diagnostics: none");
    return;
  }
  console.log("Diagnostics:");
  for (const diagnostic of diagnostics) console.log(`  [${diagnostic.kind}] ${diagnostic.message}`);
}

function firstDiagnostic(skill: LoadedSkill): string {
  return skill.parsed.diagnostics[0]?.message ?? "invalid";
}

function truncate(value: string, max: number): string {
  const chars = [...value];
  if (chars.length <= max) return value;
  return `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  vesicle skills list");
  console.error("  vesicle skills validate <skill-directory>");
  console.error("  vesicle skills inspect <name>");
}
