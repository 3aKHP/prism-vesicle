/**
 * `skillify` draft publisher: guarded, project-aware, create-only publication.
 *
 * The non-model-visible orchestration behind `vesicle skills publish-draft` and
 * the bundled `skillify` wrapper scripts. It owns exactly three concerns:
 *
 * 1. validating the exact `tmp/skillify/<name>` draft-path contract, including
 *    linked-ancestor rejection so a symlinked `tmp/` or `tmp/skillify/` cannot
 *    redirect publication outside the project;
 * 2. calling the portable bundle seam (`inspectSkillBundle`) so validation and
 *    publication share one hash/copy implementation; and
 * 3. routing project publication through sibling staging + atomic rename, and
 *    installed publication through the Store create-only API.
 *
 * It does not own parsing, hashing, bundle enumeration, or Store locking — those
 * live in `src/skills/`. It never deletes the source draft and never mutates
 * the current session catalog. Internal errors are mapped to stable error codes
 * at this boundary so the CLI and wrappers never expose raw ENOENT, SQLite SQL,
 * absolute paths, or stack traces.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { SKILL_NAME_PATTERN } from "../../skills";
import { SkillBundleError, inspectSkillBundle, installSnapshotCreateOnly, stageSkillBundle } from "../../skills";
import type { InspectedSkillBundle } from "../../skills";
import { SkillStoreError } from "../../skills";

export type SkillDraftTarget = "project" | "installed";

export const SKILL_DRAFT_SCHEMA = "vesicle.skill-draft/v1";

export type SkillDraftErrorCode =
  | "invalid-arguments"
  | "invalid-draft-path"
  | "draft-unavailable"
  | "bundle-invalid"
  | "validation-failed"
  | "target-exists"
  | "staging-failed"
  | "publication-failed";

/**
 * Structured failure carrying a stable code and bounded diagnostics. The CLI
 * renders `code` and `diagnostics` in JSON mode; `message` is for internal
 * context and tests and must never be the sole model-facing explanation.
 */
export class SkillDraftError extends Error {
  readonly diagnostics: ReadonlyArray<{ code: string; message: string }>;
  constructor(
    readonly code: SkillDraftErrorCode,
    message: string,
    diagnostics: ReadonlyArray<{ code: string; message: string }> = [],
  ) {
    super(message);
    this.name = "SkillDraftError";
    this.diagnostics = diagnostics;
  }
}

/** Logical draft path: `tmp/skillify/<name>`. */
type ResolvedDraft = { name: string; source: string; draftRoot: string; projectRoot: string };

/** Result of inspecting a draft for validation or pre-publication revalidation. */
export type SkillDraftInspection = {
  ok: true;
  name: string;
  source: string;
  bundleSha256: string;
  version: string;
  fileCount: number;
  diagnostics: Array<{ code: string; message: string }>;
};

/** Result of publishing a draft. */
export type SkillDraftPublication = {
  schema: typeof SKILL_DRAFT_SCHEMA;
  operation: "publish";
  ok: true;
  name: string;
  source: string;
  target: SkillDraftTarget;
  destination: string;
  bundleSha256: string;
  version: string;
  fileCount: number;
  draftRetained: true;
  currentSessionCatalogChanged: false;
  catalogRefresh: "new-session-required";
};

/**
 * Inspect one draft directory: validate the path contract, reject linked
 * ancestors, and run the portable bundle inspection. Returns the name, hash,
 * version, file count, and non-blocking diagnostics on success. Throws
 * `SkillDraftError` on any path, access, or bundle failure.
 */
export async function inspectSkillDraft(projectRoot: string, input: string): Promise<SkillDraftInspection> {
  const resolved = await resolveDraft(projectRoot, input);
  const inspected = await inspectDraftBundle(resolved);
  return {
    ok: true,
    name: inspected.name,
    source: resolved.source,
    bundleSha256: inspected.bundleSha256,
    version: inspected.version,
    fileCount: inspected.files.length,
    diagnostics: inspected.diagnostics.map(toDiagnosticCode),
  };
}

/**
 * Publish one draft to `project` or `installed`. Revalidates and re-hashes the
 * draft inside this call — a previous `validate` result is never authority to
 * publish changed bytes. The draft is always retained; the current session
 * catalog is never mutated.
 */
export async function publishSkillDraft(
  projectRoot: string,
  input: string,
  target: SkillDraftTarget,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<SkillDraftPublication> {
  const resolved = await resolveDraft(projectRoot, input);
  const inspected = await inspectDraftBundle(resolved);

  if (target === "installed") {
    const provenance = await publishInstalled(resolved, options.env);
    return {
      schema: SKILL_DRAFT_SCHEMA,
      operation: "publish",
      ok: true,
      name: provenance.name,
      source: resolved.source,
      target: "installed",
      destination: `installed:${provenance.name}@${provenance.version}`,
      bundleSha256: provenance.bundleSha256,
      version: provenance.version,
      fileCount: provenance.fileInventory.length,
      draftRetained: true,
      currentSessionCatalogChanged: false,
      catalogRefresh: "new-session-required",
    };
  }

  const destination = await publishProject(resolved, inspected);
  return {
    schema: SKILL_DRAFT_SCHEMA,
    operation: "publish",
    ok: true,
    name: inspected.name,
    source: resolved.source,
    target: "project",
    destination,
    bundleSha256: inspected.bundleSha256,
    version: inspected.version,
    fileCount: inspected.files.length,
    draftRetained: true,
    currentSessionCatalogChanged: false,
    catalogRefresh: "new-session-required",
  };
}

// --- path contract --------------------------------------------------------

/**
 * Validate the exact `tmp/skillify/<name>` input shape, then lstat and realpath
 * the project root, `tmp/`, `tmp/skillify/`, and the draft root. Rejects
 * absolute paths, backslashes, empty/dot/`..` segments, extra nesting, NUL,
 * symlinked ancestors, a symlink draft root, and any ancestor whose realpath
 * escapes the project root.
 */
async function resolveDraft(projectRoot: string, input: string): Promise<ResolvedDraft> {
  const parsed = parseDraftInput(input);
  if ("error" in parsed) {
    throw new SkillDraftError(parsed.code, parsed.error);
  }

  const projectInfo = await lstat(projectRoot).catch(() => undefined);
  if (!projectInfo || projectInfo.isSymbolicLink() || !projectInfo.isDirectory()) {
    throw new SkillDraftError("draft-unavailable", "Project root must be an accessible real directory.");
  }
  const projectReal = await realpath(projectRoot).catch(() => undefined);
  if (!projectReal) {
    throw new SkillDraftError("draft-unavailable", "Project root is not accessible.");
  }

  // Walk each ancestor with lstat (no symlink following) so a linked `tmp/` or
  // `tmp/skillify/` cannot redirect the draft root outside the project. The
  // realpath re-check proves the directory did not escape through a swap.
  let current = projectRoot;
  for (const segment of ["tmp", "skillify", parsed.name]) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    if (!info) {
      throw new SkillDraftError("draft-unavailable", `Draft path component is missing or inaccessible: ${segment}.`);
    }
    if (info.isSymbolicLink()) {
      throw new SkillDraftError("invalid-draft-path", `Draft path component "${segment}" is a symbolic link; symbolic links are not permitted in the draft path.`);
    }
    if (!info.isDirectory()) {
      throw new SkillDraftError("draft-unavailable", `Draft path component "${segment}" is not a directory.`);
    }
    const resolved = await realpath(current).catch(() => undefined);
    if (!resolved || (resolved !== projectReal && !resolved.startsWith(`${projectReal}${sep}`))) {
      throw new SkillDraftError("invalid-draft-path", `Draft path component "${segment}" escapes the project root.`);
    }
  }

  return { name: parsed.name, source: input, draftRoot: join(projectReal, "tmp", "skillify", parsed.name), projectRoot: projectReal };
}

function parseDraftInput(input: string): { name: string } | { error: string; code: SkillDraftErrorCode } {
  if (!input || input.includes("\0")) {
    return { error: "Draft directory is required.", code: "invalid-draft-path" };
  }
  if (input.includes("\\")) {
    return { error: `Draft path must use forward slashes: ${input}.`, code: "invalid-draft-path" };
  }
  if (input.startsWith("/")) {
    return { error: `Draft path must be project-relative, not absolute: ${input}.`, code: "invalid-draft-path" };
  }
  const segments = input.split("/");
  if (segments.length !== 3 || segments[0] !== "tmp" || segments[1] !== "skillify") {
    return { error: `Draft path must be exactly tmp/skillify/<name>: ${input}.`, code: "invalid-draft-path" };
  }
  const name = segments[2]!;
  if (!name || name === "." || name === ".." || name.includes("\0")) {
    return { error: `Draft name segment is invalid: "${name}".`, code: "invalid-draft-path" };
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { error: `Draft name "${name}" must be lowercase alphanumeric segments joined by single hyphens.`, code: "invalid-draft-path" };
  }
  return { name };
}

// --- bundle inspection ----------------------------------------------------

async function inspectDraftBundle(resolved: ResolvedDraft): Promise<InspectedSkillBundle> {
  try {
    return await inspectSkillBundle(resolved.draftRoot);
  } catch (error) {
    if (error instanceof SkillBundleError) {
      throw new SkillDraftError(
        error.code === "bundle-unavailable" ? "draft-unavailable" : "bundle-invalid",
        error.message,
        error.diagnostics.map(toDiagnosticCode),
      );
    }
    throw new SkillDraftError("validation-failed", "Draft validation failed unexpectedly.");
  }
}

// --- project publication --------------------------------------------------

async function publishProject(
  resolved: ResolvedDraft,
  inspected: InspectedSkillBundle,
): Promise<string> {
  const publicationRoot = resolved.projectRoot;
  const agentsPath = join(publicationRoot, ".agents");
  const skillsPath = join(agentsPath, "skills");
  const destination = join(skillsPath, inspected.name);

  // Create `.agents/` and `.agents/skills/` deliberately when missing, but
  // reject either when it already exists as a symlink or non-directory. Never
  // publish through a linked target parent.
  await ensurePublicationParent(agentsPath, ".agents");
  await assertPublicationParents(publicationRoot, agentsPath);
  await ensurePublicationParent(skillsPath, ".agents/skills");
  await assertPublicationParents(publicationRoot, agentsPath, skillsPath);

  if (await pathExistsAny(destination)) {
    throw new SkillDraftError("target-exists", `Destination .agents/skills/${inspected.name} already exists; create-only publication does not overwrite or upgrade.`);
  }

  // The stageSkillBundle call copies only the inspected inventory into the
  // sibling staging directory and re-hashes it, proving byte-exact staging.
  const staging = join(skillsPath, `.staging-${inspected.name}-${randomUUID()}`);
  try {
    await stageSkillBundle(resolved.draftRoot, staging, inspected);
    // Narrow the linked-parent swap window immediately before the only durable
    // mutation. A swapped parent makes the source staging path unreachable, so
    // rename fails without publishing through the replacement link.
    await assertPublicationParents(publicationRoot, agentsPath, skillsPath);
    try {
      await rename(staging, destination);
    } catch (error) {
      // Another process may have won the destination race between the existence
      // check and the rename. Report target-exists in that case rather than a
      // generic staging failure.
      if (await pathExistsAny(destination)) {
        throw new SkillDraftError("target-exists", `Destination .agents/skills/${inspected.name} was created concurrently; create-only publication does not overwrite.`);
      }
      throw new SkillDraftError("staging-failed", error instanceof Error ? error.message : String(error));
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return `.agents/skills/${inspected.name}`;
}

/**
 * Ensure `path` exists as a real directory, creating it when missing. Reject
 * when it already exists as a symlink (never publish through a linked parent)
 * or as a non-directory filesystem object.
 */
async function ensurePublicationParent(path: string, label: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) {
    await mkdir(path).catch((error: unknown) => {
      if (!isAlreadyExists(error)) throw error;
    });
  }
  const current = await lstat(path).catch(() => undefined);
  if (!current) throw new SkillDraftError("staging-failed", `${label} could not be created.`);
  if (current.isSymbolicLink()) {
    throw new SkillDraftError("staging-failed", `${label} is a symbolic link; refusing to publish through a linked target parent.`);
  }
  if (!current.isDirectory()) {
    throw new SkillDraftError("staging-failed", `${label} exists as a non-directory; refusing to publish.`);
  }
}

async function assertPublicationParents(projectRoot: string, ...parents: string[]): Promise<void> {
  let expectedParent = projectRoot;
  for (const path of parents) {
    const info = await lstat(path).catch(() => undefined);
    const resolved = info && !info.isSymbolicLink() && info.isDirectory()
      ? await realpath(path).catch(() => undefined)
      : undefined;
    if (!resolved || !resolved.startsWith(`${expectedParent}${sep}`)) {
      throw new SkillDraftError("staging-failed", "Publication parent changed or became linked during publication.");
    }
    expectedParent = resolved;
  }
}

// --- installed publication ------------------------------------------------

async function publishInstalled(
  resolved: ResolvedDraft,
  env: NodeJS.ProcessEnv | undefined,
) {
  try {
    return await installSnapshotCreateOnly({
      sourceDirectory: resolved.draftRoot,
      sourceKind: "local-directory",
      sourceIdentity: resolved.source,
      skillRoot: resolved.source,
      env,
    });
  } catch (error) {
    if (error instanceof SkillStoreError) {
      throw new SkillDraftError(error.code, error.message);
    }
    throw new SkillDraftError("publication-failed", "Installed Skill publication failed unexpectedly.");
  }
}

// --- helpers --------------------------------------------------------------

function toDiagnosticCode(diagnostic: { kind: string; message: string }): { code: string; message: string } {
  return { code: diagnostic.kind, message: diagnostic.message };
}

async function pathExistsAny(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => undefined));
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
