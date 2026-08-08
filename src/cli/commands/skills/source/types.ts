// Shared types for Skill source acquisition.

import type { SkillProvenance } from "../../../../skills";

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

export interface GitHubSource {
  owner: string;
  repo: string;
  /** ref (branch/tag/sha) parsed from a `/tree/<ref>` URL, if present. */
  ref?: string;
  /** subpath parsed from a `/tree/<ref>/<subpath>` URL, if present. */
  subpath?: string;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GitHubInstallOptions extends InstallSourceOptions {
  /** Override the fetch implementation so tests can inject a local tarball. */
  fetchImpl?: FetchLike;
}

export interface SkillUpdateResult {
  provenance: SkillProvenance;
  changed: boolean;
  previousVersion?: string;
}
