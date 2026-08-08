/**
 * Shared filesystem Skill source resolver.
 *
 * One resolution path used by both CLI inspection (`vesicle skills list`,
 * `vesicle doctor`) and the session catalog. Resolves the four filesystem
 * scopes (host, harness, user, project) and delegates collision merging to
 * the portable `discoverSkills`. No absolute path appears in the returned
 * public diagnostics or model-visible catalog.
 */

import { join } from "node:path";
import { userConfigDirectory } from "../../config/paths";
import { resolveProjectHarnessRuntime } from "../harness/activation";
import { bundledHostAssetsDirectory, createAssetResolver } from "../runtime/assets";
import { discoverSkills, listChildSkillRoots } from "../../skills";
import type { DiscoveryResult } from "../../skills";
import { dirname } from "node:path";

export interface FilesystemSkillInspection {
  result: DiscoveryResult;
  counts: {
    host: number;
    harness: number;
    user: number;
    project: number;
  };
}

export interface ResolveFilesystemSkillsOptions {
  /** Override the package-owned host-assets directory (tests). */
  hostAssetsDirectory?: string;
  /** Override the executable path used to locate bundled assets (tests). */
  executablePath?: string;
}

export async function resolveFilesystemSkills(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveFilesystemSkillsOptions = {},
): Promise<FilesystemSkillInspection> {
  const hostRoots = await resolveHostSkillRoots(options, env);
  const harnessRoots = await resolveHarnessSkillRoots(projectRoot, env);
  const userRoots = await listChildSkillRoots(join(userConfigDirectory(env), "skills"));
  const projectRoots = await listChildSkillRoots(join(projectRoot, ".agents", "skills"));

  const result = await discoverSkills({ hostRoots, harnessRoots, userRoots, projectRoots });
  return {
    result,
    counts: {
      host: hostRoots.length,
      harness: harnessRoots.length,
      user: userRoots.length,
      project: projectRoots.length,
    },
  };
}

async function resolveHostSkillRoots(options: ResolveFilesystemSkillsOptions, env: NodeJS.ProcessEnv): Promise<string[]> {
  const hostDir = options.hostAssetsDirectory
    ?? env.VESICLE_HOST_ASSETS_DIR
    ?? bundledHostAssetsDirectory(options.executablePath);
  if (!hostDir) return [];
  return listChildSkillRoots(join(hostDir, "skills"));
}

async function resolveHarnessSkillRoots(projectRoot: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const runtime = await resolveProjectHarnessRuntime(projectRoot, { env }).catch(() => undefined);
  const resolver = runtime?.assets ?? createAssetResolver(projectRoot, { env });
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
