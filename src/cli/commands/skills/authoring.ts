// skills create/enable/disable/copy-template — authoring and toggling commands.

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { projectContentRoots } from "../../../core/project/roots";
import { assertSafeRelativePath, createSkill, loadSkill, projectDisabledPath, readActiveIndex, setDisabled, setSkillEnabled, skillStoreDirectory, userDisabledPath } from "../../../skills";
import type { CreateSkillScope, LoadedSkill } from "../../../skills";
import { inspectSkills } from "./inventory";

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

export async function runCreate(rest: string[]): Promise<void> {
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

export async function runEnableDisable(name: string, enabled: boolean): Promise<void> {
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

export async function runCopyTemplate(rest: string[]): Promise<void> {
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
    if (!projectContentRoots.includes(destRoot as (typeof projectContentRoots)[number])) {
      console.error(`Destination must be under an approved content root (${projectContentRoots.join(", ")}). Got: "${destRoot}".`);
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
