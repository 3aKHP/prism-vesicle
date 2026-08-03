// skills list/inspect — human-readable inventory rendering across all scopes.
// Shared rendering helpers (printExtraMetadata, printDiagnostics, firstDiagnostic,
// truncate) live here because inventory is the human-facing rendering centre.

import { resolveFilesystemSkills } from "../../../core/skills/catalog-sources";
import type { FilesystemSkillInspection } from "../../../core/skills/catalog-sources";
import { readActiveIndex, readDisabledNames, readProvenance, userDisabledPath, projectDisabledPath } from "../../../skills";
import type { DiscoveryResult, LoadedSkill } from "../../../skills";

export interface SkillsInspection {
  result: DiscoveryResult;
  hostRootCount: number;
  harnessRootCount: number;
  userRootCount: number;
  projectRootCount: number;
}

/**
 * Discover skills across the filesystem scopes for the active project. Used by
 * both `vesicle skills list` and `vesicle doctor`. Best-effort: a Harness
 * resolution failure falls back to the default asset resolver so user-scope
 * skills still surface.
 */
export async function inspectSkills(
  projectRoot = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<SkillsInspection> {
  const inspection: FilesystemSkillInspection = await resolveFilesystemSkills(projectRoot, env);
  return {
    result: inspection.result,
    hostRootCount: inspection.counts.host,
    harnessRootCount: inspection.counts.harness,
    userRootCount: inspection.counts.user,
    projectRootCount: inspection.counts.project,
  };
}

export async function runList(): Promise<void> {
  const inspection = await inspectSkills();
  const { result } = inspection;
  const shadowed = result.diagnostics.filter((diagnostic) => diagnostic.kind === "shadowed").length;
  // A corrupted Skill Store index must not mask the harness/user listing; the
  // same guard `vesicle doctor` already uses. Per-sidecar read errors are
  // already tolerated inside `listInstalledSkills`, so this only fires on a bad
  // index file.
  let installed: InstalledSkillView[] = [];
  let installedNotice = "";
  try {
    installed = await listInstalledSkills();
  } catch (error) {
    installedNotice = ` (installed unavailable: ${error instanceof Error ? error.message : String(error)})`;
  }

  console.log("Prism Vesicle Skills");
  if (result.skills.length === 0 && result.invalid.length === 0 && installed.length === 0 && !installedNotice) {
    console.log("No skills discovered or installed.");
    return;
  }
  const userDisabled = await readDisabledNames(userDisabledPath()).catch(() => new Set<string>());
  const projectDisabled = await readDisabledNames(projectDisabledPath(process.cwd())).catch(() => new Set<string>());
  for (const skill of result.skills) {
    const description = skill.parsed.ok ? skill.parsed.metadata.description : "";
    const isDisabled = (skill.scope === "user" || skill.scope === "host") ? userDisabled.has(skill.name)
      : skill.scope === "project" ? projectDisabled.has(skill.name)
      : false;
    const flag = isDisabled ? " (disabled)" : "";
    console.log(`  ${skill.name}  [${skill.scope}]${flag}  ${truncate(description, 64)}`);
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
  if (installed.length > 0) {
    console.log("Installed:");
    for (const skill of installed) {
      const flag = skill.enabled ? "" : " (disabled)";
      console.log(`  ${skill.name}  v${skill.version}${flag}  [${skill.sourceKind}]`);
    }
  }
  console.log(`Summary: ${result.skills.length} valid, ${result.invalid.length} invalid, ${shadowed} shadowed, ${installed.length} installed${installedNotice}`);
}

export async function runInspect(name: string): Promise<void> {
  const inspection = await inspectSkills();
  const skill = [...inspection.result.skills, ...inspection.result.invalid].find((entry) => entry.name === name);
  if (skill) {
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
    return;
  }
  const entry = (await readActiveIndex()).entries.find((item) => item.name === name);
  if (entry) {
    await printInstalledInspection(entry.name, entry.version);
    return;
  }
  console.error(`No skill named "${name}" found in the host, harness, user, project, or installed scope.`);
  process.exitCode = 1;
}

interface InstalledSkillView {
  name: string;
  version: string;
  enabled: boolean;
  sourceKind: string;
}

async function listInstalledSkills(env: NodeJS.ProcessEnv = process.env): Promise<InstalledSkillView[]> {
  const index = await readActiveIndex(env);
  const views: InstalledSkillView[] = [];
  for (const entry of index.entries) {
    let sourceKind = "unknown";
    try {
      const provenance = await readProvenance(entry.name, entry.version, env);
      if (provenance) sourceKind = provenance.sourceKind;
    } catch {
      // A single unreadable provenance sidecar must not hide the other installed skills.
    }
    views.push({ name: entry.name, version: entry.version, enabled: entry.enabled, sourceKind });
  }
  return views.sort((left, right) => left.name.localeCompare(right.name));
}

async function printInstalledInspection(name: string, version: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const provenance = await readProvenance(name, version, env);
  if (!provenance) {
    console.error(`Installed metadata for "${name}" is missing.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Name: ${provenance.name}`);
  console.log(`Scope: installed`);
  console.log(`Version: ${provenance.version}`);
  console.log(`Source: ${provenance.sourceKind}`);
  if (provenance.sourceIdentity) console.log(`Source identity: ${provenance.sourceIdentity}`);
  if (provenance.requestedRef) console.log(`Requested ref: ${provenance.requestedRef}`);
  if (provenance.resolvedCommit) console.log(`Resolved commit: ${provenance.resolvedCommit}`);
  if (provenance.dirtySource) console.log(`Dirty source: true (snapshot includes uncommitted changes)`);
  console.log(`Skill root: ${provenance.skillRoot}`);
  console.log(`Bundle SHA-256: ${provenance.bundleSha256}`);
  console.log(`Files: ${provenance.fileInventory.length}`);
}

export function printExtraMetadata(metadata: { license?: string; compatibility?: string; metadata?: Record<string, string>; allowedTools?: string[]; unknownFields: string[] }): void {
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

export function printDiagnostics(diagnostics: readonly { kind: string; message: string }[]): void {
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
