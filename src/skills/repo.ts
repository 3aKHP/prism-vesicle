/**
 * Repository shape detection for Skill installation.
 *
 * The Agent Skills standard defines the contents of one Skill directory but is
 * deliberately silent on how a source repository maps to one or more Skills.
 * That mapping is a Vesicle host contract: given a staged source tree (a local
 * directory, a Git working tree, or an extracted remote tarball), detection
 * classifies the layout so the install CLI can select a skill root
 * deterministically instead of guessing.
 *
 * The walk reuses the same hardening as `paths.ts`: it never follows symbolic
 * links, skips VCS and dependency directories (`.git`, `node_modules`), and
 * bounds depth so a large or hostile tree cannot direct detection at arbitrary
 * host locations. This module is pure filesystem I/O with no network or Git
 * history access; remote acquisition and Git snapshotting live in the CLI
 * layer, which stages a source tree and then calls detection.
 *
 * See `docs/dev/SKILLS.md` for the runtime boundary and
 * `dev/docs/working/SKILLS_RUNTIME_RESEARCH_AND_FEASIBILITY.md` (§3) for the
 * repository mapping contract.
 */

import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import { SKILL_FILE_NAME } from "./loader";

/** Directory names never descended into during detection. */
const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

/** Maximum descent depth to bound detection over a large or hostile tree. */
const MAX_DEPTH = 8;

/** Conventional collection layout: `skills/<name>/SKILL.md`. */
const COLLECTION_PATTERN = /^skills\/[^/]+$/;

export type SkillRepoShapeKind =
  | "root-skill"
  | "single-nested"
  | "skills-collection"
  | "multi-arbitrary"
  | "none";

export type SkillRepoShape =
  | { kind: "root-skill"; skillRoot: string }
  | { kind: "single-nested"; skillRoot: string }
  | { kind: "skills-collection"; skillRoots: string[] }
  | { kind: "multi-arbitrary"; skillRoots: string[] }
  | { kind: "none" };

export interface DetectSkillRepoOptions {
  /** Override the entry file name (default `SKILL.md`). Used by tests and fixtures. */
  skillFileName?: string;
}

/**
 * Classify the Skill layout of `sourceRoot`. The source root must be a real
 * directory (not a symbolic link). Every `skillRoot` / `skillRoots` value is a
 * repo-relative POSIX path — `.` for a root Skill, `skills/foo` for a nested
 * one — and never carries an absolute host path.
 *
 * A root `SKILL.md` takes precedence: when the repository root is itself a
 * Skill, nested candidates are ignored so the root is installed as one complete
 * bundle. Detection finds filesystem locations only; parsing and full inventory
 * validation happen later in the Skill Store.
 */
export async function detectSkillRepo(
  sourceRoot: string,
  options: DetectSkillRepoOptions = {},
): Promise<SkillRepoShape> {
  const skillFileName = options.skillFileName ?? SKILL_FILE_NAME;

  const rootInfo = await lstat(sourceRoot).catch((error: unknown) => {
    throw new Error(`Cannot access source directory: ${readErrorMessage(error)}`);
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("Source must be a real directory, not a file or symbolic link.");
  }

  const found = await findSkillRoots(sourceRoot, skillFileName);

  if (found.includes(".")) return { kind: "root-skill", skillRoot: "." };
  if (found.length === 0) return { kind: "none" };
  if (found.length === 1) return { kind: "single-nested", skillRoot: found[0]! };
  if (found.every((root) => COLLECTION_PATTERN.test(root))) {
    return { kind: "skills-collection", skillRoots: found };
  }
  return { kind: "multi-arbitrary", skillRoots: found };
}

/**
 * Walk `sourceRoot` and return every directory that directly contains the skill
 * entry file as a regular file, as repo-relative POSIX paths. Symbolic-link and
 * non-regular entries are ignored; `.git`, `node_modules`, and entries beyond
 * `MAX_DEPTH` are not descended into.
 */
async function findSkillRoots(sourceRoot: string, skillFileName: string): Promise<string[]> {
  const roots: string[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const skillEntry = entries.find((entry) => entry.name === skillFileName);
    if (skillEntry && skillEntry.isFile() && !skillEntry.isSymbolicLink()) {
      roots.push(toRepoRelative(sourceRoot, directory));
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await visit(join(directory, entry.name), depth + 1);
    }
  }

  await visit(sourceRoot, 0);
  return roots.sort((left, right) => left.localeCompare(right));
}

function toRepoRelative(sourceRoot: string, directory: string): string {
  const rel = relative(sourceRoot, directory).split(sep).join("/");
  return rel || ".";
}

function readErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "unknown read error";
}
