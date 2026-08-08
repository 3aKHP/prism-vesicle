// Source acquisition barrel: install dispatcher and update re-acquisition.
// Routes a user-named source to local or GitHub acquisition, then into the
// immutable Skill Store via installSnapshot.

import { readActiveIndex, readProvenance } from "../../../../skills";
import type { SkillProvenance } from "../../../../skills";
import { installFromLocalPath } from "./local";
import { installFromGitHub, isRemoteSource } from "./github";
import type { FetchLike, InstallSourceOptions, SkillUpdateResult } from "./types";

export { selectSkillRoots } from "./selection";
export { parseGitHubUrl, isRemoteSource } from "./github";
export { installFromLocalPath } from "./local";
export { installFromGitHub } from "./github";
export type { InstallSourceOptions, GitHubSource, FetchLike, GitHubInstallOptions, SkillUpdateResult } from "./types";

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
