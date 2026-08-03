// GitHub URL/ref/API/download acquisition. Git token only exists here at the
// GitHub request boundary (githubFetch); archive extraction delegates to
// archive.ts; repository-shape selection delegates to selection.ts.

import { mkdtemp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { detectSkillRepo, installSnapshot, parseSkillMarkdown, SKILL_FILE_NAME, SKILL_NAME_PATTERN } from "../../../../skills";
import type { SkillProvenance } from "../../../../skills";
import { extractTarball } from "./archive";
import { selectSkillRoots, resolveSkillRoot } from "./selection";
import type { GitHubSource, GitHubInstallOptions, FetchLike } from "./types";

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
