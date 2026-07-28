import { copyFile, mkdir } from "node:fs/promises";
import { writableProjectRoots } from "../core/artifacts/roots";
import { resolveFilesystemSkills } from "../core/skills/catalog-sources";
import type { FilesystemSkillInspection } from "../core/skills/catalog-sources";
import { dirname, join, resolve } from "node:path";
import { assertSafeRelativePath, createSkill, loadSkill, projectDisabledPath, readActiveIndex, readDisabledNames, readProvenance, rollbackSkill, setDisabled, setSkillEnabled, skillStoreDirectory, uninstallSkill, userDisabledPath } from "../skills";
import type { CreateSkillScope, DiscoveryResult, LoadedSkill } from "../skills";
import { installFromSource, updateSkill } from "./skills-source";
import type { InstallSourceOptions } from "./skills-source";

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
  if (command === "install" && args.length >= 2) {
    await runInstall(args.slice(1));
    return;
  }
  if (command === "update" && args.length === 2) {
    await runUpdate(args[1]!);
    return;
  }
  if (command === "rollback" && args.length === 2) {
    await runRollback(args[1]!);
    return;
  }
  if (command === "uninstall" && args.length === 2) {
    await runUninstall(args[1]!);
    return;
  }
  if (command === "create" && args.length >= 2) {
    await runCreate(args.slice(1));
    return;
  }
  if (command === "enable" && args.length === 2) {
    await runEnableDisable(args[1]!, true);
    return;
  }
  if (command === "disable" && args.length === 2) {
    await runEnableDisable(args[1]!, false);
    return;
  }
  if (command === "copy-template" && args.length >= 3) {
    await runCopyTemplate(args.slice(1));
    return;
  }
  printUsage();
  process.exitCode = 1;
}

async function runList(): Promise<void> {
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
  console.error("  vesicle skills create <name> [--scope user|project] [--force]");
  console.error("  vesicle skills enable <name>");
  console.error("  vesicle skills disable <name>");
  console.error("  vesicle skills copy-template <skill-name> <resource-path> <dest-path>");
  console.error("  vesicle skills install <path-or-url> [--ref <ref>] [--path <root>] [--all] [--include-worktree]");
  console.error("  vesicle skills update <name>");
  console.error("  vesicle skills rollback <name>");
  console.error("  vesicle skills uninstall <name>");
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

interface ParsedInstallArgs {
  source?: string;
  options: InstallSourceOptions;
}

function parseInstallArgs(rest: string[]): ParsedInstallArgs {
  let source: string | undefined;
  const options: InstallSourceOptions = {};
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === "--all") options.all = true;
    else if (arg === "--include-worktree") options.includeWorktree = true;
    else if (arg === "--ref") options.ref = consumeFlagValue(rest, ++index, "--ref");
    else if (arg === "--path") options.path = consumeFlagValue(rest, ++index, "--path");
    else if (!arg.startsWith("--") && source === undefined) source = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return { source, options };
}

function consumeFlagValue(rest: string[], index: number, flag: string): string {
  const value = rest[index];
  if (value === undefined) throw new Error(`${flag} requires a value.`);
  return value;
}

async function runInstall(rest: string[]): Promise<void> {
  const { source, options } = parseInstallArgs(rest);
  if (!source) {
    console.error("Usage: vesicle skills install <path-or-url> [--ref <ref>] [--path <root>] [--all] [--include-worktree]");
    process.exitCode = 1;
    return;
  }
  try {
    const results = await installFromSource(source, options);
    for (const provenance of results) {
      const origin = provenance.sourceIdentity ?? "local directory";
      const root = provenance.skillRoot !== "." ? ` (root: ${provenance.skillRoot})` : "";
      console.log(`Installed ${provenance.name} ${provenance.version} [${provenance.sourceKind}] from ${origin}${root}.`);
    }
    console.log(`${results.length} skill(s) installed.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runUpdate(name: string): Promise<void> {
  try {
    const result = await updateSkill(name);
    if (!result.changed) {
      console.log(`${name} ${result.provenance.version} is already up to date.`);
      return;
    }
    console.log(`Updated ${name}: ${result.previousVersion} -> ${result.provenance.version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runRollback(name: string): Promise<void> {
  try {
    const version = await rollbackSkill(name);
    console.log(`Rolled back ${name} to ${version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runUninstall(name: string): Promise<void> {
  try {
    await uninstallSkill(name);
    console.log(`Uninstalled ${name}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

interface ParsedCreateArgs {
  name?: string;
  scope: CreateSkillScope;
  force: boolean;
}

function parseCreateArgs(rest: string[]): ParsedCreateArgs {
  let name: string | undefined;
  let scope: CreateSkillScope = "user";
  let force = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === "--force") force = true;
    else if (arg === "--scope") {
      const value = rest[++index];
      if (value !== "user" && value !== "project") throw new Error(`--scope must be "user" or "project", got "${value}".`);
      scope = value;
    } else if (!arg.startsWith("--") && name === undefined) name = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return { name, scope, force };
}

async function runCreate(rest: string[]): Promise<void> {
  let parsed: ParsedCreateArgs;
  try {
    parsed = parseCreateArgs(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (!parsed.name) {
    console.error("Usage: vesicle skills create <name> [--scope user|project] [--force]");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await createSkill(parsed.name, process.cwd(), { scope: parsed.scope, force: parsed.force });
    if (result.backupPath) console.log(`Backed up existing skill to ${result.backupPath}.`);
    console.log(`Created ${result.name} [${result.scope}] at ${result.root}.`);
    console.log("Edit SKILL.md to add instructions, then run: vesicle skills validate " + result.root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runEnableDisable(name: string, enabled: boolean): Promise<void> {
  const action = enabled ? "Enabled" : "Disabled";
  try {
    const inspection = await inspectSkills();
    const discovered = [...inspection.result.skills, ...inspection.result.invalid].find((skill) => skill.name === name);
    if (discovered) {
      if (discovered.scope === "harness") {
        console.error(`Harness-scope skill "${name}" cannot be disabled; it is part of the verified Harness baseline.`);
        process.exitCode = 1;
        return;
      }
      const path = discovered.scope === "project" ? projectDisabledPath(process.cwd()) : userDisabledPath();
      await setDisabled(path, name, !enabled);
      console.log(`${action} ${discovered.scope}-scope skill "${name}".`);
      return;
    }
    const index = await readActiveIndex();
    const installed = index.entries.find((entry) => entry.name === name);
    if (installed) {
      await setSkillEnabled(name, enabled);
      console.log(`${action} installed skill "${name}".`);
      return;
    }
    console.error(`No skill named "${name}" found in any scope.`);
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runCopyTemplate(rest: string[]): Promise<void> {
  const [skillName, resourcePath, destPath] = rest;
  if (!skillName || !resourcePath || !destPath) {
    console.error("Usage: vesicle skills copy-template <skill-name> <resource-path> <dest-path>");
    process.exitCode = 1;
    return;
  }
  try {
    assertSafeRelativePath(resourcePath);
    const normalizedDest = destPath.replace(/\\/g, "/");
    const destRoot = normalizedDest.split("/", 1)[0]!;
    if (!writableProjectRoots.includes(destRoot as (typeof writableProjectRoots)[number])) {
      console.error(`Destination must be under a writable root (${writableProjectRoots.join(", ")}). Got: "${destRoot}".`);
      process.exitCode = 1;
      return;
    }
    if (normalizedDest.includes("..")) {
      console.error("Destination must not contain \"..\".");
      process.exitCode = 1;
      return;
    }

    const skill = await resolveSkillByName(skillName);
    if (!skill) {
      console.error(`No skill named "${skillName}" found in any scope.`);
      process.exitCode = 1;
      return;
    }
    const sourceAbsolute = join(skill.rootDirectory, resourcePath);
    const projectRoot = process.cwd();
    const destAbsolute = resolve(projectRoot, normalizedDest);
    await mkdir(dirname(destAbsolute), { recursive: true });
    await copyFile(sourceAbsolute, destAbsolute);
    console.log(`Copied ${skillName}/${resourcePath} -> ${normalizedDest}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function resolveSkillByName(name: string): Promise<LoadedSkill | undefined> {
  const inspection = await inspectSkills();
  const discovered = inspection.result.skills.find((skill) => skill.name === name);
  if (discovered) return discovered;
  const index = await readActiveIndex().catch(() => undefined);
  if (index) {
    const entry = index.entries.find((item) => item.name === name && item.enabled);
    if (entry) {
      const root = join(skillStoreDirectory(), name, entry.version);
      const loaded = await loadSkill(root, "installed", { expectedName: name });
      if (loaded.parsed.ok) return loaded;
    }
  }
  return undefined;
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
