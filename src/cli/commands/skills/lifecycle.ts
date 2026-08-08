// skills install/update/rollback/uninstall — installed-skill lifecycle commands.

import { rollbackSkill, uninstallSkill } from "../../../skills";
import { installFromSource, updateSkill } from "./source";
import type { InstallSourceOptions } from "./source";

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

export async function runInstall(rest: string[]): Promise<void> {
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

export async function runUpdate(name: string): Promise<void> {
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

export async function runRollback(name: string): Promise<void> {
  try {
    const version = await rollbackSkill(name);
    console.log(`Rolled back ${name} to ${version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function runUninstall(name: string): Promise<void> {
  try {
    await uninstallSkill(name);
    console.log(`Uninstalled ${name}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
