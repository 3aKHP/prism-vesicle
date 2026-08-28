/**
 * Filesystem-scope Skill disable state.
 *
 * Installed Skills use the Skill Store active-index `enabled` flag. Filesystem
 * scopes (user, project) use a simple line-delimited disabled-names file:
 *
 *   - User scope:    `<user-config>/skills/.disabled`
 *   - Project scope: `<project-root>/.vesicle/disabled-skills`
 *
 * Each line is one Skill name. Empty lines and leading/trailing whitespace are
 * ignored. The files are local host state (`.vesicle/` is gitignored; the user
 * config is per-machine). Disable state is deterministic across platforms: the
 * same file content produces the same disabled set everywhere.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userConfigDirectory } from "../config/paths";
import { withSqliteMutex } from "./sqlite-mutex";
import type { SkillScope } from "./types";

export function userDisabledPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(userConfigDirectory(env), "skills", ".disabled");
}

export function projectDisabledPath(projectRoot: string): string {
  return join(projectRoot, ".vesicle", "disabled-skills");
}

export async function readDisabledNames(path: string): Promise<Set<string>> {
  const raw = await readFile(path, "utf8").catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (raw === undefined) return new Set();
  return new Set(
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

export async function setDisabled(path: string, name: string, disabled: boolean): Promise<void> {
  return withDisabledLock(path, async () => {
    const names = await readDisabledNames(path);
    if (disabled) {
      names.add(name);
    } else {
      names.delete(name);
    }
    await writeDisabledNames(path, names);
  });
}

const disabledLockChains = new Map<string, Promise<unknown>>();

function withDisabledLock<T>(path: string, critical: () => Promise<T>): Promise<T> {
  const prev = disabledLockChains.get(path) ?? Promise.resolve();
  const next = prev.then(() => withDisabledCrossProcessLock(path, critical));
  disabledLockChains.set(path, next.then(() => undefined, () => undefined));
  return next;
}

async function withDisabledCrossProcessLock<T>(path: string, critical: () => Promise<T>): Promise<T> {
  const lockDir = dirname(path);
  await mkdir(lockDir, { recursive: true });
  return withSqliteMutex(
    join(lockDir, ".disabled-lock.sqlite"),
    "Skill disable state is locked by another process; retry later.",
    critical,
  );
}

async function writeDisabledNames(path: string, names: Set<string>): Promise<void> {
  if (names.size === 0) {
    await safeUnlink(path);
    return;
  }
  const content = [...names].sort().join("\n") + "\n";
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, path);
  } catch (error) {
    await safeUnlink(tmp);
    throw error;
  }
}

/**
 * Resolve the disabled-names file path for a filesystem scope. Host Skills
 * use the user-level disabled-names file (package-owned Skills are toggled
 * per-user). Returns undefined for scopes that do not use file-based disable
 * state (harness, installed).
 */
export function disabledPathForScope(
  scope: SkillScope,
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (scope === "user" || scope === "host") return userDisabledPath(env);
  if (scope === "project") return projectDisabledPath(projectRoot);
  return undefined;
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT");
}
