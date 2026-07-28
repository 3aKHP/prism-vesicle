/**
 * Skill authoring: scaffold a new Skill directory with a valid `SKILL.md`.
 *
 * Creates the standard Agent Skills directory structure in either the user
 * scope (`<user-config>/skills/<name>/`) or the project scope
 * (`<project-root>/.agents/skills/<name>/`). Refuses to overwrite an existing
 * Skill unless `force` is explicitly set.
 */

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { userConfigDirectory } from "../config/paths";
import { SKILL_NAME_PATTERN, MAX_NAME_LENGTH } from "./parser";
import { SKILL_FILE_NAME } from "./loader";

export type CreateSkillScope = "user" | "project";

export interface CreateSkillOptions {
  scope: CreateSkillScope;
  /** Overwrite an existing Skill directory (backs it up first). */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface CreateSkillResult {
  name: string;
  scope: CreateSkillScope;
  /** Absolute path of the created Skill root (CLI display only, never model-visible). */
  root: string;
  /** Present when `force` backed up an existing directory. */
  backupPath?: string;
}

export async function createSkill(
  name: string,
  projectRoot: string,
  options: CreateSkillOptions,
): Promise<CreateSkillResult> {
  if (!name || name.length > MAX_NAME_LENGTH || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Skill name "${name}" must be 1-${MAX_NAME_LENGTH} lowercase alphanumeric segments joined by single hyphens (no leading, trailing, or repeated hyphens).`,
    );
  }

  const env = options.env ?? process.env;
  const parentDir =
    options.scope === "project"
      ? join(projectRoot, ".agents", "skills")
      : join(userConfigDirectory(env), "skills");
  const root = join(parentDir, name);

  let exists = false;
  try {
    await stat(root);
    exists = true;
  } catch {
    // Does not exist — proceed.
  }

  let backupPath: string | undefined;
  if (exists) {
    if (!options.force) {
      throw new Error(
        `Skill "${name}" already exists in the ${options.scope} scope. Use --force to back it up and replace it.`,
      );
    }
    backupPath = `${root}.backup-${Date.now()}`;
    await rename(root, backupPath);
  }

  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "references"), { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, SKILL_FILE_NAME), scaffoldSkillMarkdown(name), "utf8");

  return { name, scope: options.scope, root, backupPath };
}

function scaffoldSkillMarkdown(name: string): string {
  const title = name
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
  return `---
name: ${name}
description: "TODO: Describe what ${title} does and when to use it."
---

# ${title}

TODO: Write the Skill instructions here.

## When to use

TODO: Describe the trigger conditions for this Skill.

## Procedure

TODO: Describe the step-by-step procedure.
`;
}
