/**
 * Read one Skill root from disk and validate it.
 *
 * Mirrors `core/instructions/loader.ts`: UTF-8 is decoded fatally, one leading
 * BOM is stripped, the SKILL.md target must be a regular file (not a symbolic
 * link), and a race-aware `lstat` re-check guards a swap to a symlink or
 * non-regular file between the link check and the read. `lstat` (not `stat`)
 * is used for the re-check so a swap to a symbolic link is detected instead of
 * silently followed. The skill root itself must be a real directory. Loading is
 * fail-soft: any I/O or parse failure is returned as an `ok: false` parsed
 * result with diagnostics so discovery can skip the skill without hiding its
 * valid siblings.
 */

import { lstat, readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import { enumerateSkillResources } from "./paths";
import { parseSkillMarkdown } from "./parser";
import type { LoadedSkill, SkillDiagnostic, SkillScope } from "./types";

const UTF8_BOM = [0xef, 0xbb, 0xbf];

export const SKILL_FILE_NAME = "SKILL.md";

export type LoadSkillOptions = {
  /** Override the entry file name (default `SKILL.md`). Used by tests and fixtures. */
  skillFileName?: string;
};

/**
 * Load one skill root. `name` is the directory basename and the parser's
 * expected `name`. The returned `rootDirectory` is internal host state and
 * must not appear in catalog entries or diagnostics.
 */
export async function loadSkill(
  rootDirectory: string,
  scope: SkillScope,
  options: LoadSkillOptions = {},
): Promise<LoadedSkill> {
  const skillFileName = options.skillFileName ?? SKILL_FILE_NAME;
  const name = basename(rootDirectory);

  const rootInfo = await lstat(rootDirectory).catch((error: unknown) => error as NodeJS.ErrnoException);
  if (rootInfo instanceof Error) {
    return failed(name, scope, rootDirectory, [{ kind: "read-error", message: readErrorMessage(rootInfo) }]);
  }
  if (rootInfo.isSymbolicLink()) {
    return failed(name, scope, rootDirectory, [{ kind: "linked-root", message: "Skill root is a symbolic link; skipped to protect host filesystem authority." }]);
  }
  if (!rootInfo.isDirectory()) {
    return failed(name, scope, rootDirectory, [{ kind: "not-a-regular-file", message: "Skill root is not a directory." }]);
  }

  const skillPath = join(rootDirectory, skillFileName);
  const entryInfo = await lstat(skillPath).catch((error: unknown) => error as NodeJS.ErrnoException);
  if (entryInfo instanceof Error) {
    return failed(name, scope, rootDirectory, [{ kind: "read-error", message: `${skillFileName}: ${readErrorMessage(entryInfo)}` }]);
  }
  if (entryInfo.isSymbolicLink() || !entryInfo.isFile()) {
    return failed(name, scope, rootDirectory, [{ kind: "not-a-regular-file", message: `${skillFileName} is not a regular file.` }]);
  }

  let raw: Uint8Array;
  try {
    raw = await readFile(skillPath);
  } catch (error) {
    return failed(name, scope, rootDirectory, [{ kind: "read-error", message: readErrorMessage(error) }]);
  }
  // Race-aware re-check with `lstat` (not `stat`): if the entry was swapped to a
  // symbolic link or non-regular file between the first check and the read,
  // detect it instead of following the new target. A residual TOCTOU window
  // remains (path → open is not bound to one handle); Phase 2's
  // `read_skill_resource` should bind the check and read to one fd via
  // `open(O_NOFOLLOW)` + `fstat` to close it for model-driven reads.
  try {
    const rechecked = await lstat(skillPath);
    if (rechecked.isSymbolicLink() || !rechecked.isFile()) {
      return failed(name, scope, rootDirectory, [{ kind: "not-a-regular-file", message: `${skillFileName} changed to a non-regular file during read.` }]);
    }
  } catch (error) {
    return failed(name, scope, rootDirectory, [{ kind: "read-error", message: readErrorMessage(error) }]);
  }

  const bomStripped = raw.length >= 3 && raw[0] === UTF8_BOM[0] && raw[1] === UTF8_BOM[1] && raw[2] === UTF8_BOM[2]
    ? raw.subarray(3)
    : raw;

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bomStripped);
  } catch {
    return failed(name, scope, rootDirectory, [{ kind: "invalid-utf8", message: `${skillFileName} is not valid UTF-8.` }]);
  }

  const parsed = parseSkillMarkdown(content, name);
  if (!parsed.ok) {
    return failed(name, scope, rootDirectory, parsed.diagnostics);
  }

  const { resources, diagnostics: resourceDiagnostics } = await enumerateSkillResources(rootDirectory, skillFileName);
  return {
    name,
    scope,
    rootDirectory,
    parsed: {
      ok: true,
      metadata: parsed.metadata,
      body: parsed.body,
      bodySha256: parsed.bodySha256,
      bytes: parsed.bytes,
      lines: parsed.lines,
      resources,
      diagnostics: [...parsed.diagnostics, ...resourceDiagnostics],
    },
  };
}

/** A directly-authored skill root exists if `SKILL.md` is a regular file inside it. */
export async function skillRootExists(directory: string, skillFileName = SKILL_FILE_NAME): Promise<boolean> {
  const info = await lstat(join(directory, skillFileName)).catch(() => undefined);
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

/** Non-recursively list immediate child directories that look like skill roots, as absolute paths. */
export async function listChildSkillRoots(
  parentDirectory: string,
  skillFileName = SKILL_FILE_NAME,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(parentDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const root = join(parentDirectory, entry.name);
    if (await skillRootExists(root, skillFileName)) {
      roots.push(root);
    }
  }
  return roots.sort((left, right) => left.localeCompare(right));
}

function failed(
  name: string,
  scope: SkillScope,
  rootDirectory: string,
  diagnostics: SkillDiagnostic[],
): LoadedSkill {
  return { name, scope, rootDirectory, parsed: { ok: false, diagnostics } };
}

function readErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "unknown read error";
}
