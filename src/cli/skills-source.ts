/**
 * Skill source acquisition for `vesicle skills install`.
 *
 * CLI-layer bridge between a user-named source and the pure Skill Store
 * (`src/skills/store.ts`). It resolves a local source into one or more
 * validated skill-root directories on disk and calls `installSnapshot` for each.
 * The pure `src/skills/` module never runs host processes, so all Git access
 * lives here; remote (GitHub) acquisition layers on top of the same selection
 * contract in a later task.
 *
 * Repository mapping follows the approved plan §3: detect the Skill layout,
 * refuse to guess when multiple skills are present, and let `--path` / `--all`
 * disambiguate. Local Git sources snapshot the tracked HEAD tree by default
 * and require `--include-worktree` to capture uncommitted changes, so an
 * installed snapshot is tied to a resolved commit rather than a floating
 * checkout.
 */

import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { buildProcessEnvironment, DEFAULT_PROCESS_TIMEOUT_MS, MAX_PROCESS_STREAM_BYTES } from "../core/process/runtime";
import { detectSkillRepo, installSnapshot, parseSkillMarkdown, readActiveIndex, readProvenance, SKILL_FILE_NAME, SKILL_NAME_PATTERN } from "../skills";
import type { SkillProvenance, SkillRepoShape } from "../skills";

export interface InstallSourceOptions {
  /** Explicit repo-relative skill root (e.g. `skills/foo`). */
  path?: string;
  /** Install every detected skill in a collection or multi-arbitrary source. */
  all?: boolean;
  /** Remote/Git ref (branch, tag, or commit) to install from. */
  ref?: string;
  /** Local Git only: snapshot the working tree instead of the tracked HEAD tree. */
  includeWorktree?: boolean;
  env?: NodeJS.ProcessEnv;
}

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
function resolveSkillRoot(base: string, skillRoot: string): string {
  return skillRoot === "." ? base : join(base, ...skillRoot.split("/"));
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

// ---------------------------------------------------------------------------
// GitHub acquisition
// ---------------------------------------------------------------------------

export interface GitHubSource {
  owner: string;
  repo: string;
  /** ref (branch/tag/sha) parsed from a `/tree/<ref>` URL, if present. */
  ref?: string;
  /** subpath parsed from a `/tree/<ref>/<subpath>` URL, if present. */
  subpath?: string;
}

// Accepts https, ssh://git@, and git@ forms; owner/repo with optional `.git`
// and optional `/tree/<ref>/<subpath>`.
const GITHUB_URL_PATTERN =
  /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+))?)?$/;

/** Parse a GitHub URL into owner, repo, and any `/tree/<ref>/<subpath>` parts. */
export function parseGitHubUrl(url: string): GitHubSource {
  const match = GITHUB_URL_PATTERN.exec(url.trim().replace(/\/+$/, ""));
  if (!match) throw new Error(`Not a recognized GitHub repository URL: ${url}`);
  const [, owner, repo, ref, subpath] = match;
  if (!owner || !repo) throw new Error(`Could not read owner/repository from: ${url}`);
  const source: GitHubSource = { owner, repo };
  if (ref) source.ref = ref;
  if (subpath) source.subpath = subpath;
  return source;
}

/** A source string is remote when it carries an http(s) scheme or SSH `git@` form. */
export function isRemoteSource(source: string): boolean {
  const trimmed = source.trim();
  return /^https?:\/\//.test(trimmed) || /^git@[a-z0-9.-]+:/i.test(trimmed);
}

/**
 * Install dispatcher: a remote URL routes to GitHub acquisition, any other
 * source is treated as a local path. This is the single entry point the
 * `vesicle skills install` CLI calls.
 */
export async function installFromSource(
  source: string,
  options: InstallSourceOptions = {},
): Promise<SkillProvenance[]> {
  return isRemoteSource(source) ? installFromGitHub(source, options) : installFromLocalPath(source, options);
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GitHubInstallOptions extends InstallSourceOptions {
  /** Override the fetch implementation so tests can inject a local tarball. */
  fetchImpl?: FetchLike;
}

/**
 * Install Skill(s) from a GitHub repository URL. The requested (or default)
 * ref is resolved to an immutable commit SHA before download, the tarball is
 * fetched, extracted to a staging tree, and each selected skill root is
 * snapshotted into the Skill Store with GitHub provenance. No new dependency:
 * tarball extraction shells out to the system `tar`.
 */
export async function installFromGitHub(
  url: string,
  options: GitHubInstallOptions = {},
): Promise<SkillProvenance[]> {
  const parsed = parseGitHubUrl(url);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  const resolved = await resolveRefAndSubpath(parsed, options, fetchImpl, env);
  if (!/^[0-9a-f]{40}$/.test(resolved.commit)) {
    throw new Error("GitHub did not return a valid 40-character commit SHA.");
  }
  const tarball = await downloadGitHubTarball(parsed.owner, parsed.repo, resolved.commit, fetchImpl, env);

  const scratch = await mkdtemp(join(tmpdir(), "vesicle-skill-github-"));
  const extracted = join(scratch, "extracted");
  await mkdir(extracted, { recursive: true });
  try {
    await extractTarball(tarball, extracted, env);
    const extractedRoot = await singleTopLevelDir(extracted);
    const sourceRoot = await renameRootForSkill(extracted, extractedRoot);
    const shape = await detectSkillRepo(sourceRoot);
    const selections = selectSkillRoots(shape, { ...options, path: options.path ?? resolved.subpath });
    const results: SkillProvenance[] = [];
    for (const skillRoot of selections) {
      results.push(
        await installSnapshot({
          sourceDirectory: resolveSkillRoot(sourceRoot, skillRoot),
          sourceKind: "github",
          sourceIdentity: `${parsed.owner}/${parsed.repo}`,
          requestedRef: resolved.ref,
          resolvedCommit: resolved.commit,
          skillRoot,
          enabled: true,
          env,
        }),
      );
    }
    return results;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface SkillUpdateResult {
  provenance: SkillProvenance;
  changed: boolean;
  previousVersion?: string;
}

/**
 * Re-acquire an installed skill from its recorded source and install the latest
 * version. For GitHub sources the recorded ref is re-resolved to a new commit;
 * for local sources the recorded path is re-read. A matching bundle hash is a
 * no-op (idempotent); a new version becomes active and the previous one is
 * retained for rollback.
 */
export async function updateSkill(
  name: string,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<SkillUpdateResult> {
  const env = options.env ?? process.env;
  const index = await readActiveIndex(env);
  const entry = index.entries.find((item) => item.name === name);
  if (!entry) throw new Error(`No installed skill named "${name}".`);
  const previous = await readProvenance(name, entry.version, env);
  if (!previous) throw new Error(`Installed version metadata for "${name}" is missing.`);

  let results: SkillProvenance[];
  if (previous.sourceKind === "github") {
    const [owner, repo] = (previous.sourceIdentity ?? "").split("/");
    if (!owner || !repo) throw new Error(`Cannot update "${name}": GitHub source identity is incomplete.`);
    const ref = previous.requestedRef;
    const url = ref ? `https://github.com/${owner}/${repo}/tree/${ref}` : `https://github.com/${owner}/${repo}`;
    results = await installFromGitHub(url, { ref, path: previous.skillRoot, env, fetchImpl: options.fetchImpl });
  } else {
    if (!previous.sourceIdentity) throw new Error(`Cannot update "${name}": no source path is recorded.`);
    // A skill originally snapshotted from a dirty worktree (--include-worktree)
    // must be re-acquired the same way; otherwise a still-dirty source fails the
    // clean-tree gate and `update` has no flag to pass through.
    results = await installFromLocalPath(previous.sourceIdentity, {
      path: previous.skillRoot,
      env,
      includeWorktree: previous.dirtySource === true,
    });
  }
  const provenance = results.find((item) => item.name === name) ?? results[0];
  if (!provenance) throw new Error(`Update of "${name}" did not produce a skill.`);
  const changed = provenance.version !== entry.version;
  return { provenance, changed, previousVersion: changed ? entry.version : undefined };
}

async function resolveDefaultBranch(
  owner: string,
  repo: string,
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const response = await githubFetch(`https://api.github.com/repos/${owner}/${repo}`, fetchImpl, env);
  if (!response.ok) {
    throw new Error(`GitHub API could not read repository ${owner}/${repo} (HTTP ${response.status}).`);
  }
  const data = (await response.json()) as { default_branch?: unknown };
  if (typeof data.default_branch !== "string" || !data.default_branch) {
    throw new Error(`GitHub did not return a default branch for ${owner}/${repo}.`);
  }
  return data.default_branch;
}

async function resolveGitHubCommit(
  owner: string,
  repo: string,
  ref: string,
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
  const response = await githubFetch(url, fetchImpl, env);
  if (!response.ok) {
    throw new Error(`GitHub could not resolve ref "${ref}" (HTTP ${response.status}).`);
  }
  const data = (await response.json()) as { sha?: unknown };
  if (typeof data.sha !== "string") throw new Error("GitHub commit response is missing a SHA.");
  return data.sha;
}

/** Like `resolveGitHubCommit` but returns `undefined` on a 404 instead of throwing. */
async function tryResolveGitHubCommit(
  owner: string,
  repo: string,
  ref: string,
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
  const response = await githubFetch(url, fetchImpl, env);
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GitHub could not resolve ref "${ref}" (HTTP ${response.status}).`);
  }
  const data = (await response.json()) as { sha?: unknown };
  if (typeof data.sha !== "string") throw new Error("GitHub commit response is missing a SHA.");
  return data.sha;
}

/**
 * Resolve a GitHub ref and optional subpath from the parsed URL and options. An
 * explicit `--ref` is used verbatim. Without one, a `/tree/<ref>/<subpath>` URL
 * is ambiguous when `<ref>` contains a slash (e.g. `feature/integrate`): the
 * parser splits it into a short ref and a long subpath. Try the longest ref
 * prefix first, peeling trailing segments into the subpath, until one resolves
 * to a commit — so a slash-bearing branch resolves correctly while a plain ref
 * with a real subpath still resolves in a single request.
 */
async function resolveRefAndSubpath(
  parsed: GitHubSource,
  options: GitHubInstallOptions,
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv,
): Promise<{ ref: string; commit: string; subpath?: string }> {
  const owner = parsed.owner;
  const repo = parsed.repo;
  if (options.ref) {
    const commit = await resolveGitHubCommit(owner, repo, options.ref, fetchImpl, env);
    return { ref: options.ref, commit, ...(parsed.subpath ? { subpath: parsed.subpath } : {}) };
  }
  const segments = parsed.ref === undefined ? [] : [parsed.ref, ...(parsed.subpath ? parsed.subpath.split("/") : [])];
  if (segments.length === 0) {
    const branch = await resolveDefaultBranch(owner, repo, fetchImpl, env);
    const commit = await resolveGitHubCommit(owner, repo, branch, fetchImpl, env);
    return { ref: branch, commit };
  }
  for (let count = segments.length; count >= 1; count--) {
    const candidateRef = segments.slice(0, count).join("/");
    const commit = await tryResolveGitHubCommit(owner, repo, candidateRef, fetchImpl, env);
    if (commit !== undefined) {
      const subpath = count < segments.length ? segments.slice(count).join("/") : undefined;
      return { ref: candidateRef, commit, ...(subpath ? { subpath } : {}) };
    }
  }
  throw new Error(`GitHub could not resolve ref "${segments.join("/")}" in ${owner}/${repo}.`);
}

async function downloadGitHubTarball(
  owner: string,
  repo: string,
  sha: string,
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`;
  const response = await githubFetch(url, fetchImpl, env);
  if (!response.ok) throw new Error(`GitHub download failed (HTTP ${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

async function githubFetch(url: string, fetchImpl: FetchLike, env: NodeJS.ProcessEnv): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": "prism-vesicle", Accept: "application/vnd.github+json" };
  const token = env.GITHUB_TOKEN;
  if (typeof token === "string" && token.length > 0) headers.Authorization = `Bearer ${token}`;
  return fetchImpl(url, { headers });
}

/**
 * Extract a gzipped tar `tarGz` into `dest` using the system `tar`. The archive
 * is staged outside `dest` so only the extracted tree remains. Throws if `tar`
 * is missing, reports a non-zero exit, or runs past the host timeout, so a
 * hostile archive cannot hang or flood output. Runs with a filtered environment.
 */
async function extractTarball(tarGz: Buffer, dest: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const archive = join(tmpdir(), `vesicle-github-${randomUUID()}.tar.gz`);
  await writeFile(archive, tarGz);
  try {
    // --no-same-owner avoids restoring archive ownership (EPERM as non-root, or
    // foreign uid/gid as root). --no-same-permissions is intentionally NOT used:
    // a Skill may bundle executable scripts whose +x bit must survive extraction.
    const result = await runHostCommand(["tar", "--no-same-owner", "-xzf", archive, "-C", dest], { env });
    if (result.timedOut) {
      throw new Error("tar extraction timed out; the archive may be hostile or the disk slow.");
    }
    if (result.exitCode !== 0) {
      throw new Error(`tar extraction failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
  } finally {
    await rm(archive, { force: true }).catch(() => undefined);
  }
}

/**
 * Run a host command under the project's process-hardening policy: a filtered
 * environment (no inherited host secrets), a bounded timeout that kills the
 * child, and truncated output capture. Used for extracting an untrusted remote
 * GitHub tarball; Git invocations stay synchronous because they are local.
 */
async function runHostCommand(
  argv: string[],
  { env, timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS }: { env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ exitCode?: number; stdout: string; stderr: string; timedOut: boolean }> {
  const child = Bun.spawn(argv, {
    env: buildProcessEnvironment(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, readBounded(child.stdout), readBounded(child.stderr)]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let kept = 0;
  while (kept < MAX_PROCESS_STREAM_BYTES) {
    const next = await reader.read();
    if (next.done) break;
    const remaining = MAX_PROCESS_STREAM_BYTES - kept;
    const slice = next.value.byteLength <= remaining ? Buffer.from(next.value) : Buffer.from(next.value.subarray(0, remaining));
    chunks.push(slice);
    kept += slice.byteLength;
  }
  try {
    await reader.cancel();
  } catch {
    // Stream already closed after process exit or kill.
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** GitHub tarballs extract to one top-level directory; return its absolute path. */
async function singleTopLevelDir(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  if (dirs.length === 1) return join(directory, dirs[0]!.name);
  throw new Error("GitHub archive did not extract to a single top-level directory.");
}

/**
 * GitHub names an archive root `<repo>-<sha>`. A root Skill must live in a
 * directory whose name equals its declared `name`, and GitHub repository names
 * need not be valid skill names (uppercase, underscores, dots). Rename the
 * extracted root to the `SKILL.md` `name` when the archive is a root Skill;
 * nested/collection layouts key off subdirectories and are left unchanged.
 */
async function renameRootForSkill(extracted: string, extractedRoot: string): Promise<string> {
  const current = basename(extractedRoot);
  const desired = (await readRootSkillName(extractedRoot)) ?? current;
  if (desired === current) return extractedRoot;
  const target = join(extracted, desired);
  await rename(extractedRoot, target);
  return target;
}

/** Read the declared `name` from a root `SKILL.md`, if it is a valid skill name. */
async function readRootSkillName(root: string): Promise<string | undefined> {
  const raw = await readFile(join(root, SKILL_FILE_NAME)).catch(() => undefined);
  if (raw === undefined) return undefined;
  const parsed = parseSkillMarkdown(raw.toString("utf8"), undefined);
  if (!parsed.ok) return undefined;
  return SKILL_NAME_PATTERN.test(parsed.metadata.name) ? parsed.metadata.name : undefined;
}
