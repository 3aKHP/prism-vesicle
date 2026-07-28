/**
 * Session-facing Skill catalog resolution.
 *
 * Builds the effective catalog a model can activate from: the filesystem
 * discovery winners (`project`, `user`, `harness`) plus enabled Skill Store
 * snapshots (`installed` scope), which discovery itself does not cover.
 * Collision precedence is `project` > `user` > `installed` > `harness` — a
 * shared project convention outranks personal authoring, which outranks an
 * explicit installation, which outranks the verified Harness baseline; losers
 * produce one `shadowed` diagnostic each.
 *
 * The returned `ResolvedSkillCatalog` pairs the routing view (`SkillCatalog`:
 * name/description/scope only, never an absolute path) with the host-side
 * `byName` map the tool executors use to resolve bodies and resources. Only
 * the routing view may reach model-visible surfaces.
 *
 * The catalog is computed once per session by the host and frozen; Stage
 * stays Skill-less and resolves to an empty catalog.
 */

import { dirname, join } from "node:path";
import { userConfigDirectory } from "../../config/paths";
import { resolveProjectHarnessRuntime } from "../harness/activation";
import { createAssetResolver } from "../runtime/assets";
import type { EngineProfile } from "../engine/profile";
import {
  buildCatalog,
  discoverSkills,
  listChildSkillRoots,
  loadSkill,
  projectDisabledPath,
  readActiveIndex,
  readDisabledNames,
  skillRootExists,
  skillStoreDirectory,
  userDisabledPath,
} from "../../skills";
import type { LoadedSkill, SkillCatalog, SkillDiagnostic } from "../../skills";

export interface ResolvedSkillCatalog {
  /** The bounded routing view (safe for model-visible surfaces). */
  catalog: SkillCatalog;
  /**
   * Host-side body/resource resolution for every catalog winner. Internal
   * only: `LoadedSkill.rootDirectory` is an absolute host path and must never
   * reach model-visible content, events, or diagnostics.
   */
  byName: ReadonlyMap<string, LoadedSkill>;
}

export async function resolveSkillCatalog(
  rootDir: string,
  env: NodeJS.ProcessEnv,
  profile: Pick<EngineProfile, "id">,
  contextWindow?: number,
): Promise<ResolvedSkillCatalog> {
  if (profile.id === "stage") return { catalog: buildCatalog([], { contextWindow }), byName: new Map() };

  const diagnostics: SkillDiagnostic[] = [];
  const harnessRoots = await resolveHarnessSkillRoots(rootDir, env);
  const userRoots = await listChildSkillRoots(join(userConfigDirectory(env), "skills"));
  const projectRoots = await listChildSkillRoots(join(rootDir, ".agents", "skills"));
  const discovery = await discoverSkills({ harnessRoots, userRoots, projectRoots });
  diagnostics.push(...discovery.diagnostics);

  const winners = new Map<string, LoadedSkill>(discovery.skills.map((skill) => [skill.name, skill]));
  for (const installed of await loadInstalledSkills(env, diagnostics)) {
    const existing = winners.get(installed.name);
    if (existing && existing.scope !== "harness") {
      diagnostics.push(shadowedDiagnostic(installed, existing));
      continue;
    }
    if (existing) diagnostics.push(shadowedDiagnostic(existing, installed));
    winners.set(installed.name, installed);
  }

  const userDisabled = await readDisabledNames(userDisabledPath(env)).catch(() => new Set<string>());
  const projectDisabled = await readDisabledNames(projectDisabledPath(rootDir)).catch(() => new Set<string>());
  for (const [name, skill] of winners) {
    if (skill.scope === "user" && userDisabled.has(name)) {
      winners.delete(name);
      diagnostics.push({ kind: "shadowed", message: `Skill "${name}" in scope "user" is disabled and excluded from the catalog.` });
    } else if (skill.scope === "project" && projectDisabled.has(name)) {
      winners.delete(name);
      diagnostics.push({ kind: "shadowed", message: `Skill "${name}" in scope "project" is disabled and excluded from the catalog.` });
    }
  }

  const catalog = buildCatalog([...winners.values()], { contextWindow });
  catalog.diagnostics.push(...diagnostics);
  const kept = new Map<string, LoadedSkill>();
  for (const entry of catalog.entries) {
    const winner = winners.get(entry.name);
    if (winner) kept.set(entry.name, winner);
  }
  return { catalog, byName: kept };
}

/** Names available for `activate_skill`, in catalog order. */
export function catalogNames(resolved: ResolvedSkillCatalog): string[] {
  return resolved.catalog.entries.map((entry) => entry.name);
}

/** Enabled Skill Store snapshots as `installed`-scope loaded skills. */
async function loadInstalledSkills(env: NodeJS.ProcessEnv, diagnostics: SkillDiagnostic[]): Promise<LoadedSkill[]> {
  const index = await readActiveIndex(env).catch((error: unknown) => {
    diagnostics.push({
      kind: "read-error",
      message: `Skill Store index is unreadable (${error instanceof Error ? error.message : String(error)}); installed skills are unavailable.`,
    });
    return undefined;
  });
  if (!index) return [];
  const skills: LoadedSkill[] = [];
  for (const entry of index.entries) {
    if (!entry.enabled) continue;
    const root = join(skillStoreDirectory(env), entry.name, entry.version);
    if (!(await skillRootExists(root))) {
      diagnostics.push({
        kind: "read-error",
        message: `Installed skill "${entry.name}" (${entry.version}) is missing from the Skill Store; it is unavailable.`,
      });
      continue;
    }
    const loaded = await loadSkill(root, "installed", { expectedName: entry.name });
    if (loaded.parsed.ok) {
      skills.push(loaded);
    } else {
      diagnostics.push({
        kind: "invalid",
        message: `Installed skill "${entry.name}" (${entry.version}) is no longer valid: ${loaded.parsed.diagnostics[0]?.message ?? "unknown validation failure"}`,
      });
    }
  }
  return skills;
}

/** Harness skill roots from the active verified Harness (`assets/skills/<name>/`). */
async function resolveHarnessSkillRoots(rootDir: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const runtime = await resolveProjectHarnessRuntime(rootDir, { env }).catch(() => undefined);
  const resolver = runtime?.assets ?? createAssetResolver(rootDir, { env });
  let files: string[];
  try {
    files = await resolver.listFiles("assets/skills", true);
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const file of files) {
    const match = /^assets\/skills\/([^/]+)\/SKILL\.md$/.exec(file);
    if (!match) continue;
    const resolved = await resolver.resolveFile(file).catch(() => undefined);
    if (resolved) roots.push(dirname(resolved.absolutePath));
  }
  return roots;
}

function shadowedDiagnostic(loser: LoadedSkill, winner: LoadedSkill): SkillDiagnostic {
  return {
    kind: "shadowed",
    message: `Skill "${loser.name}" in scope "${loser.scope}" is shadowed by scope "${winner.scope}"; the lower-precedence entry is not available.`,
  };
}
