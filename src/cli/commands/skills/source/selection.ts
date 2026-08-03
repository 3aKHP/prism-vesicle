// Pure repository-shape selection: resolves a detected Skill layout into the
// skill roots to install. No I/O, no processes.

import { join } from "node:path";
import type { SkillRepoShape } from "../../../../skills";
import type { InstallSourceOptions } from "./types";

/**
 * Resolve a detected shape into the skill roots to install. Throws on an empty
 * source or an ambiguous multi-skill source without `--path` / `--all`.
 */
export function selectSkillRoots(shape: SkillRepoShape, options: InstallSourceOptions): string[] {
  const explicit = options.path;
  if (shape.kind === "none") {
    throw new Error("No SKILL.md found in the source.");
  }
  if (shape.kind === "root-skill") {
    if (explicit !== undefined && explicit !== ".") {
      throw new Error(`--path "${explicit}" does not match the repository root, which is itself a Skill.`);
    }
    return ["."];
  }
  if (shape.kind === "single-nested") {
    if (explicit !== undefined && explicit !== shape.skillRoot) {
      throw new Error(`--path "${explicit}" was not found; the detected Skill root is "${shape.skillRoot}".`);
    }
    return [shape.skillRoot];
  }
  const candidates = shape.skillRoots;
  if (explicit !== undefined) {
    if (!candidates.includes(explicit)) {
      throw new Error(`--path "${explicit}" was not found among the detected Skills.`);
    }
    return [explicit];
  }
  if (options.all) return candidates;
  throw new Error(
    `Multiple Skills found; specify --path <root> or --all:\n${candidates.map((candidate) => `  ${candidate}`).join("\n")}`,
  );
}

/** Resolve a repo-relative POSIX skill root against a staging/source directory. */
export function resolveSkillRoot(base: string, skillRoot: string): string {
  return skillRoot === "." ? base : join(base, ...skillRoot.split("/"));
}
