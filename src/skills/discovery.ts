/**
 * Skill discovery: load roots grouped by scope and resolve name collisions.
 *
 * Phase 0 discovers two scopes (`harness`, `user`). Roots are supplied by the
 * caller — the CLI resolves Harness roots through the asset resolver (so they
 * come from the active verified Harness baseline under logical `assets/skills/`)
 * and user roots from `<user-config>/skills/`. Keeping the resolver out of this
 * module keeps `skills/` decoupled from `core/runtime/assets` and `core/harness`
 * and makes discovery unit-testable with temporary directories.
 *
 * Collisions are resolved by deterministic scope precedence: `user` outranks
 * `harness`. Exactly one winner is selected per name; lower-precedence entries
 * are reported as `shadowed` and their bodies/resources are never merged.
 * Diagnostics name only safe logical scope labels, never an absolute host path.
 */

import { loadSkill } from "./loader";
import { PHASE0_DISCOVERY_SCOPES, type LoadedSkill, type SkillDiagnostic, type SkillScope } from "./types";

/**
 * Phase 0 precedence, highest first. `user` authoring outranks the verified
 * `harness` baseline so a user can intentionally override a bundled Skill.
 */
export const PHASE0_PRECEDENCE: readonly SkillScope[] = ["user", "harness"];

export interface DiscoverSkillsOptions {
  /** Skill roots resolved from the active verified Harness (`assets/skills/<name>/`). */
  harnessRoots?: string[];
  /** Skill roots under the user configuration directory (`<user-config>/skills/<name>/`). */
  userRoots?: string[];
}

export interface DiscoveryResult {
  /** Valid winning skill per name (the effective inventory), sorted by name. */
  skills: LoadedSkill[];
  /** Skills whose winning entry failed validation, sorted by name. */
  invalid: LoadedSkill[];
  /** Collision and scope-level diagnostics. Per-skill parse diagnostics stay on each `LoadedSkill`. */
  diagnostics: SkillDiagnostic[];
}

/**
 * Discover and merge skills across the Phase 0 scopes. Loading is fail-soft per
 * root: one unreadable or malformed skill never hides its siblings.
 */
export async function discoverSkills(options: DiscoverSkillsOptions = {}): Promise<DiscoveryResult> {
  const rootsByScope: Array<{ scope: SkillScope; roots: string[] }> = PHASE0_DISCOVERY_SCOPES.map((scope) => ({
    scope,
    roots: scope === "harness" ? (options.harnessRoots ?? []) : (options.userRoots ?? []),
  }));

  const loaded: LoadedSkill[] = [];
  for (const { scope, roots } of rootsByScope) {
    for (const root of roots) {
      loaded.push(await loadSkill(root, scope));
    }
  }

  return mergeByPrecedence(loaded);
}

function mergeByPrecedence(loaded: readonly LoadedSkill[]): DiscoveryResult {
  const byName = new Map<string, LoadedSkill[]>();
  for (const skill of loaded) {
    const list = byName.get(skill.name) ?? [];
    list.push(skill);
    byName.set(skill.name, list);
  }

  const skills: LoadedSkill[] = [];
  const invalid: LoadedSkill[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  for (const [name, group] of [...byName.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const winner = pickWinner(group);
    if (winner.parsed.ok) {
      skills.push(winner);
    } else {
      invalid.push(winner);
    }
    for (const entry of group) {
      if (entry === winner) continue;
      diagnostics.push({
        kind: "shadowed",
        message: `Skill "${name}" in scope "${entry.scope}" is shadowed by scope "${winner.scope}"; the lower-precedence entry is not available.`,
      });
    }
  }

  return { skills, invalid, diagnostics };
}

/** Select the highest-precedence entry. Ties (same scope) keep the first loaded. */
function pickWinner(group: LoadedSkill[]): LoadedSkill {
  let best = group[0]!;
  let bestRank = precedenceRank(best.scope);
  for (let index = 1; index < group.length; index++) {
    const candidate = group[index]!;
    const rank = precedenceRank(candidate.scope);
    if (rank < bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best;
}

function precedenceRank(scope: SkillScope): number {
  const rank = PHASE0_PRECEDENCE.indexOf(scope);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}
