// Local directory/Git acquisition: resolves a local source into validated
// skill-root directories and calls installSnapshot for each. Git access is
// local-only; the filtered process environment is used for Git spawns.

import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { buildProcessEnvironment } from "../../../../core/process/runtime";
import { detectSkillRepo, installSnapshot } from "../../../../skills";
import type { SkillProvenance } from "../../../../skills";
import { selectSkillRoots, resolveSkillRoot } from "./selection";
import type { InstallSourceOptions } from "./types";

/**
 * Install from a local path. A directory containing `.git` is snapshotted from
 * its tracked HEAD tree (or the working tree with `includeWorktree`); any other
 * real directory is installed in place. Returns one provenance per installed
 * skill (a collection installed with `all` may yield several).
 */
export async function installFromLocalPath(
  source: string,
  options: InstallSourceOptions = {},
): Promise<SkillProvenance[]> {
  const absolute = resolve(source);
  const rootInfo = await lstat(absolute).catch(() => undefined);
  if (!rootInfo?.isDirectory()) {
    throw new Error(`Source is not a directory: ${source}`);
  }
  if (await pathExists(join(absolute, ".git"))) {
    return installFromLocalGit(absolute, options);
  }
  return installFromLocalDirectory(absolute, options);
}

async function installFromLocalDirectory(
  absolute: string,
  options: InstallSourceOptions,
): Promise<SkillProvenance[]> {
  const shape = await detectSkillRepo(absolute);
  const selections = selectSkillRoots(shape, options);
  const results: SkillProvenance[] = [];
  for (const skillRoot of selections) {
    results.push(
      await installSnapshot({
        sourceDirectory: resolveSkillRoot(absolute, skillRoot),
        sourceKind: "local-directory",
        sourceIdentity: absolute,
        skillRoot,
        enabled: true,
        env: options.env,
      }),
    );
  }
  return results;
}

async function installFromLocalGit(
  repo: string,
  options: InstallSourceOptions,
): Promise<SkillProvenance[]> {
  const env = options.env ?? process.env;
  if (!gitAvailable(env)) {
    throw new Error(
      "Source is a Git repository but `git` is not on PATH; install Git or pass a non-Git directory.",
    );
  }
  const headSha = runGit(repo, ["rev-parse", "HEAD"], env).trim();
  if (!headSha) throw new Error("Could not resolve the HEAD commit of the Git repository.");
  const status = runGit(repo, ["status", "--porcelain"], env).trim();
  const clean = status.length === 0;
  if (!clean && !options.includeWorktree) {
    const preview = status.split("\n").slice(0, 20).join("\n");
    throw new Error(
      `Git working tree has uncommitted changes; commit them or pass --include-worktree to snapshot the current files:\n${preview}`,
    );
  }

  // Name the staging root after the repository so a root Skill (skillRoot ".")
  // validates: the parser requires the SKILL.md `name` to match its directory.
  const scratch = await mkdtemp(join(tmpdir(), "vesicle-skill-git-"));
  const staging = join(scratch, basename(repo));
  await mkdir(staging, { recursive: true });
  try {
    await stageTrackedWorkingTree(repo, staging, env);
    const shape = await detectSkillRepo(staging);
    const selections = selectSkillRoots(shape, options);
    const results: SkillProvenance[] = [];
    for (const skillRoot of selections) {
      results.push(
        await installSnapshot({
          sourceDirectory: resolveSkillRoot(staging, skillRoot),
          sourceKind: "local-git",
          sourceIdentity: repo,
          resolvedCommit: headSha,
          dirtySource: !clean,
          skillRoot,
          enabled: true,
          env: options.env,
        }),
      );
    }
    return results;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Copy every tracked file of `repo` from its working tree into `staging`,
 * preserving directory layout and excluding everything Git does not track
 * (untracked files, `.git/`, ignored files) plus symbolic links and non-files.
 * For a clean tree the working copy equals HEAD, so this yields the committed
 * snapshot; with `--include-worktree` it yields the current files instead.
 */
async function stageTrackedWorkingTree(repo: string, staging: string, env: NodeJS.ProcessEnv): Promise<void> {
  const out = runGit(repo, ["ls-files", "-z"], env);
  const paths = out.split("\0").filter((segment) => segment.length > 0);
  for (const relative of paths) {
    const src = join(repo, ...relative.split("/"));
    const info = await lstat(src).catch(() => undefined);
    if (!info || !info.isFile() || info.isSymbolicLink()) continue;
    const dst = join(staging, ...relative.split("/"));
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
}

function gitAvailable(env: NodeJS.ProcessEnv): boolean {
  try {
    return runGitExitCode(["--version"], env) === 0;
  } catch {
    return false;
  }
}

function runGit(repo: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = runGitRaw(["-C", repo, ...args], env);
  if (result.exitCode !== 0) {
    const stderr = result.stderr?.toString().trim() ?? `exit code ${result.exitCode}`;
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return result.stdout.toString();
}

function runGitExitCode(args: string[], env: NodeJS.ProcessEnv): number | undefined {
  return runGitRaw(args, env).exitCode;
}

function runGitRaw(args: string[], env: NodeJS.ProcessEnv): { stdout: Buffer; stderr: Buffer | null; exitCode: number | undefined } {
  // Spawn with a filtered environment so host secrets (GITHUB_TOKEN, provider
  // keys, …) are never inherited by the Git child. Git access here is local-only.
  return Bun.spawnSync(["git", ...args], { env: buildProcessEnvironment(env) });
}

async function pathExists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => undefined));
}
