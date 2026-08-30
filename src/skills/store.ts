/**
 * Immutable Skill Store: host-owned, content-addressed snapshots of installed
 * Skills plus a small active index.
 *
 * Layout (under `<user-config>/skill-store`):
 *
 *   index.json                          active index (name → version, enabled, time)
 *   <name>/<version>/                   one complete, byte-exact standard bundle
 *     SKILL.md                          verbatim from source (never rewritten)
 *     references/…, assets/…            supporting resources
 *   <name>/<version>.provenance.json    host sidecar (source, hashes, inventory)
 *
 * The version directory holds only the auditable standard bundle; provenance
 * lives in a sibling sidecar so the bundle stays byte-for-byte comparable with
 * its source. Snapshots are staged, re-verified by hash, and atomically renamed
 * so an interrupted install never leaves a live dependency on the source path
 * or a half-written active version. Reinstalling identical content is idempotent
 * by bundle hash; a differing bundle under the same version is a hard conflict.
 *
 * Portable bundle inspection, hashing, and byte-exact staging live in the
 * shared `bundle.ts` seam. Both `installSnapshot` and the `skillify`
 * create-only publication path (`installSnapshotCreateOnly`) call that seam so
 * there is one hash/copy implementation. The Store owns only index/provenance
 * persistence, lifecycle, and the cross-process lock.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userConfigDirectory } from "../config/paths";
import { computeBundleHash, hashBundleDirectory, inspectSkillBundle, stageSkillBundle } from "./bundle";
import type { SkillBundleFile } from "./bundle";
import { withSqliteMutex } from "./sqlite-mutex";

const INDEX_SCHEMA = "prism-vesicle-skill-store/v1";
const PROVENANCE_SCHEMA = "prism-vesicle-skill-provenance/v1";
const INDEX_FILE = "index.json";
const PROVENANCE_FILE = "provenance.json";

export type { SkillBundleFile } from "./bundle";
export { computeBundleHash } from "./bundle";
export type { InspectedSkillBundle } from "./bundle";

export type SkillSourceKind = "local-directory" | "local-git" | "github";

export interface SkillStoreIndexEntry {
  name: string;
  version: string;
  enabled: boolean;
  installedAt: string;
}

export interface SkillStoreIndex {
  schema: typeof INDEX_SCHEMA;
  entries: SkillStoreIndexEntry[];
}

export interface SkillProvenance {
  schema: typeof PROVENANCE_SCHEMA;
  name: string;
  version: string;
  sourceKind: SkillSourceKind;
  sourceIdentity?: string;
  requestedRef?: string;
  resolvedCommit?: string;
  /**
   * Present when a local Git snapshot was taken from a dirty working tree
   * (`--include-worktree`) rather than a clean commit. The resolved commit
   * alone is then not the snapshot's complete identity; the bundle hash is.
   */
  dirtySource?: boolean;
  /** Repository-relative skill root (e.g. `.` or `skills/foo`). Never an absolute host path. */
  skillRoot: string;
  /** SHA-256 of the `SKILL.md` body (without frontmatter). */
  contentSha256: string;
  /** Deterministic SHA-256 over the full standard-bundle file inventory. */
  bundleSha256: string;
  fileInventory: SkillBundleFile[];
  installedAt: string;
}

export interface InstallSnapshotOptions {
  sourceDirectory: string;
  /** Snapshot version label. Defaults to a content-addressed `sha-<bundle[0:12]>`. */
  version?: string;
  sourceKind?: SkillSourceKind;
  sourceIdentity?: string;
  requestedRef?: string;
  resolvedCommit?: string;
  /** Mark the snapshot as coming from a dirty Git working tree. */
  dirtySource?: boolean;
  skillRoot?: string;
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Stable error codes the Store surfaces for create-only publication. */
export type SkillStoreErrorCode = "target-exists";

export class SkillStoreError extends Error {
  constructor(readonly code: SkillStoreErrorCode, message: string) {
    super(message);
    this.name = "SkillStoreError";
  }
}

/** Root directory of the host-owned Skill Store. */
export function skillStoreDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(userConfigDirectory(env), "skill-store");
}

/** Read the active index, or an empty index when the store has not been initialized. */
export async function readActiveIndex(env: NodeJS.ProcessEnv = process.env): Promise<SkillStoreIndex> {
  const path = join(skillStoreDirectory(env), INDEX_FILE);
  const raw = await readFile(path).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (raw === undefined) return { schema: INDEX_SCHEMA, entries: [] };
  return parseActiveIndex(raw);
}

/** Read the provenance sidecar for one installed version, if present. */
export async function readProvenance(
  name: string,
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SkillProvenance | undefined> {
  assertStoreSegment(name, "name");
  assertStoreSegment(version, "version");
  const path = join(skillStoreDirectory(env), name, `${version}.${PROVENANCE_FILE}`);
  const raw = await readFile(path).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  return parseProvenance(raw);
}

/**
 * Install one validated skill directory as an immutable snapshot.
 *
 * Inspects the source through the shared bundle seam, stages a byte-exact copy,
 * re-verifies by hash, and atomically renames it into place before updating the
 * active index. Throws on any validation, safety, or conflict failure; partial
 * staging is cleaned up. Idempotent for identical content under the same version.
 */
export async function installSnapshot(options: InstallSnapshotOptions): Promise<SkillProvenance> {
  const env = options.env ?? process.env;
  const inspected = await inspectSkillBundle(options.sourceDirectory);
  const name = inspected.name;
  const version = options.version ?? inspected.version;
  // Defense in depth: `name` is parser-validated and `version` defaults to a
  // content-addressed label, but both are also used directly in path joins, so
  // every Store API re-validates them as single path segments.
  assertStoreSegment(name, "name");
  assertStoreSegment(version, "version");

  const storeRoot = skillStoreDirectory(env);
  const familyRoot = join(storeRoot, name);
  const versionDir = join(familyRoot, version);
  const provenancePath = join(familyRoot, `${version}.${PROVENANCE_FILE}`);

  if (await pathExists(versionDir)) {
    const existing = await hashBundleDirectory(versionDir);
    if (computeBundleHash(existing) !== inspected.bundleSha256) {
      throw new Error(`Skill "${name}" version "${version}" already exists with different content; use a distinct version.`);
    }
    // Idempotent reinstall by bundle hash: snapshot and provenance already exist.
    // Verify the active index actually points at this version; a prior install
    // may have written provenance but crashed before the index update.
    const existingProvenance = await readProvenance(name, version, env);
    if (existingProvenance) {
      await ensureActiveIndexEntry(storeRoot, name, version, options.enabled ?? true, existingProvenance.installedAt);
      return existingProvenance;
    }
    // Orphan recovery: snapshot exists without a sidecar. Rebuild provenance and
    // ensure the active-index entry without claiming a fresh install time.
    return writeProvenanceAndIndex(
      provenancePath,
      buildProvenance({ name, version, options, contentSha256: inspected.bodySha256, bundleSha256: inspected.bundleSha256, inventory: [...inspected.files] }),
      name,
      version,
      options,
      storeRoot,
    );
  }

  const staging = join(familyRoot, `${STAGING_DIR_PREFIX}${version}-${randomUUID()}`);
  await mkdir(familyRoot, { recursive: true });
  try {
    await stageSkillBundle(options.sourceDirectory, staging, inspected);
    await rename(staging, versionDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return writeProvenanceAndIndex(
    provenancePath,
    buildProvenance({ name, version, options, contentSha256: inspected.bodySha256, bundleSha256: inspected.bundleSha256, inventory: [...inspected.files] }),
    name,
    version,
    options,
    storeRoot,
  );
}

/**
 * Create-only publication: install one validated skill directory as an immutable
 * snapshot, rejecting any pre-existing name. Unlike `installSnapshot`, this is
 * not idempotent — an active index entry or a retained publication for another
 * version/content is a hard `target-exists` refusal. One exact, fully verified
 * version + provenance pair without an active index is treated as an interrupted
 * first publication and has only its missing index commit repaired. The
 * authoritative name-existence check, staging, rename, provenance
 * write, and index publication all run inside the existing cross-process
 * `withIndexLock` so concurrent create-only attempts produce exactly one winner.
 *
 * Exact-hash orphan recovery covers both crash windows after the final rename:
 * with no provenance it writes provenance + index; with matching provenance it
 * writes only the missing index. Different/corrupt content or another retained
 * version/provenance remains a refusal.
 */
export async function installSnapshotCreateOnly(options: InstallSnapshotOptions): Promise<SkillProvenance> {
  const env = options.env ?? process.env;
  const inspected = await inspectSkillBundle(options.sourceDirectory);
  const name = inspected.name;
  const version = inspected.version;
  assertStoreSegment(name, "name");
  assertStoreSegment(version, "version");

  const storeRoot = skillStoreDirectory(env);
  const familyRoot = join(storeRoot, name);
  const versionDir = join(familyRoot, version);
  const provenancePath = join(familyRoot, `${version}.${PROVENANCE_FILE}`);
  const staging = join(familyRoot, `${STAGING_DIR_PREFIX}${version}-${randomUUID()}`);

  return withIndexLock(storeRoot, async () => {
    const index = await readIndexFile(storeRoot);
    if (index.entries.some((entry) => entry.name === name)) {
      throw new SkillStoreError("target-exists", `Skill "${name}" is already installed; create-only publication does not overwrite or upgrade.`);
    }
    const familyInfo = await lstat(familyRoot).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (familyInfo && (familyInfo.isSymbolicLink() || !familyInfo.isDirectory())) {
      throw new SkillStoreError("target-exists", `Skill "${name}" has conflicting retained Store state; create-only publication refuses linked or non-directory families.`);
    }

    // Recover the crash after provenance became durable but before index.json
    // committed. This is safe only for one exact version/provenance pair whose
    // bytes and recorded inventory still match the submitted draft.
    if (await pathExists(versionDir)) {
      const versionInfo = await lstat(versionDir);
      if (versionInfo.isSymbolicLink() || !versionInfo.isDirectory()) {
        throw new SkillStoreError("target-exists", `Skill "${name}" has conflicting retained Store state; create-only publication refuses linked or non-directory versions.`);
      }
      const existingProvenance = await readProvenance(name, version, env);
      if (existingProvenance) {
        const retained = await retainedPublicationNames(familyRoot);
        const expectedEntries = new Set([version, `${version}.${PROVENANCE_FILE}`]);
        if (retained.some((entry) => !expectedEntries.has(entry))) {
          throw new SkillStoreError("target-exists", `Skill "${name}" has another retained publication; create-only publication does not overwrite or upgrade.`);
        }
        const existingInventory = await hashBundleDirectory(versionDir);
        if (!provenanceMatchesInspection(existingProvenance, inspected, existingInventory)) {
          throw new SkillStoreError("target-exists", `Skill "${name}" has conflicting retained publication state; create-only publication does not overwrite or repair it.`);
        }
        await writeIndexFile(storeRoot, upsertEntry(index, name, version, options.enabled ?? true, existingProvenance.installedAt));
        return existingProvenance;
      }
    }

    if (await pathExists(familyRoot)) {
      // The exact version directory without provenance is handled below. Any
      // other durable directory/sidecar represents retained or corrupt state.
      const retained = await retainedPublicationNames(familyRoot);
      if (retained.some((entry) => entry !== version)) {
        throw new SkillStoreError("target-exists", `Skill "${name}" has a retained version; create-only publication does not overwrite or upgrade.`);
      }
    }

    // Exact-hash orphan recovery for an interrupted first publication that
    // reached the final version directory but has neither provenance nor an
    // active index entry (both checked above).
    if (await pathExists(versionDir)) {
      const existingHash = computeBundleHash(await hashBundleDirectory(versionDir));
      if (existingHash !== inspected.bundleSha256) {
        throw new SkillStoreError("target-exists", `Skill "${name}" already has different content under "${version}"; create-only publication does not overwrite.`);
      }
      const provenance = buildProvenance({ name, version, options, contentSha256: inspected.bodySha256, bundleSha256: inspected.bundleSha256, inventory: [...inspected.files] });
      await writeJsonAtomic(provenancePath, provenance);
      await writeIndexFile(storeRoot, upsertEntry(index, name, version, options.enabled ?? true, provenance.installedAt));
      return provenance;
    }

    try {
      await mkdir(familyRoot, { recursive: true });
      await stageSkillBundle(options.sourceDirectory, staging, inspected);
      await rename(staging, versionDir);
      const provenance = buildProvenance({ name, version, options, contentSha256: inspected.bodySha256, bundleSha256: inspected.bundleSha256, inventory: [...inspected.files] });
      await writeJsonAtomic(provenancePath, provenance);
      await writeIndexFile(storeRoot, upsertEntry(index, name, version, options.enabled ?? true, provenance.installedAt));
      return provenance;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

// --- lifecycle: list / activate / rollback / uninstall ---------------------

/**
 * List every installed version directory of a skill family, oldest first by
 * each version's provenance install time. Used by `rollback` and the CLI.
 */
export async function listSkillVersions(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  assertStoreSegment(name, "name");
  const familyRoot = join(skillStoreDirectory(env), name);
  const entries = await readdir(familyRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (!entries) return [];
  const stamped: Array<{ version: string; installedAt: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    // Skip in-flight staging dirs from an interrupted install and version dirs
    // without a provenance sidecar (orphans). rollback must only target fully
    // installed versions, or it can repoint the active index at a half-copied tree.
    if (entry.name.startsWith(STAGING_DIR_PREFIX)) continue;
    assertStoreSegment(entry.name, "version");
    const provenance = await readProvenance(name, entry.name, env);
    if (!provenance) continue;
    stamped.push({ version: entry.name, installedAt: provenance.installedAt });
  }
  stamped.sort((left, right) => left.installedAt.localeCompare(right.installedAt) || left.version.localeCompare(right.version));
  return stamped.map((entry) => entry.version);
}

/** Point a skill's active index entry at an already-installed version. */
export async function setActiveVersion(name: string, version: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertStoreSegment(name, "name");
  assertStoreSegment(version, "version");
  const storeRoot = skillStoreDirectory(env);
  if (!(await pathExists(join(storeRoot, name, version)))) {
    throw new Error(`Version "${version}" is not installed for skill "${name}".`);
  }
  await updateActiveIndex(storeRoot, (index) => {
    const existing = index.entries.find((entry) => entry.name === name);
    if (!existing) throw new Error(`No installed skill named "${name}".`);
    const entries = index.entries.filter((entry) => entry.name !== name);
    entries.push({ ...existing, version, installedAt: new Date().toISOString() });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return { schema: INDEX_SCHEMA, entries };
  });
}

/**
 * Roll a skill back to the most recently installed version that is not the
 * current one. Returns the version it rolled back to.
 */
export async function rollbackSkill(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const index = await readActiveIndex(env);
  const entry = index.entries.find((item) => item.name === name);
  if (!entry) throw new Error(`No installed skill named "${name}".`);
  const versions = (await listSkillVersions(name, env)).filter((version) => version !== entry.version);
  if (versions.length === 0) throw new Error(`No previous version to roll back to for "${name}".`);
  const target = versions[versions.length - 1]!;
  await setActiveVersion(name, target, env);
  return target;
}

/** Remove a skill entirely: drop its index entry and delete its version family. */
export async function uninstallSkill(name: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertStoreSegment(name, "name");
  const storeRoot = skillStoreDirectory(env);
  const familyRoot = join(storeRoot, name);
  const index = await readActiveIndex(env);
  const indexHas = index.entries.some((entry) => entry.name === name);
  const dirHas = await pathExists(familyRoot);
  if (!indexHas && !dirHas) throw new Error(`No installed skill named "${name}".`);
  // Keep the index entry until the version family is actually gone. If removal
  // fails, the command reports the error and a later uninstall can retry from
  // the same visible state instead of claiming success with files left behind.
  if (dirHas) await rm(familyRoot, { recursive: true, force: true });
  await updateActiveIndex(storeRoot, (current) => ({
    schema: INDEX_SCHEMA,
    entries: current.entries.filter((entry) => entry.name !== name).sort((left, right) => left.name.localeCompare(right.name)),
  }));
}

/** Toggle the enabled state of an installed skill. Throws if the skill is not installed. */
export async function setSkillEnabled(name: string, enabled: boolean, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertStoreSegment(name, "name");
  const storeRoot = skillStoreDirectory(env);
  await updateActiveIndex(storeRoot, (index) => {
    const entry = index.entries.find((item) => item.name === name);
    if (!entry) throw new Error(`No installed skill named "${name}".`);
    return {
      schema: INDEX_SCHEMA,
      entries: index.entries.map((item) => (item.name === name ? { ...item, enabled } : item)),
    };
  });
}

// --- provenance + index persistence -----------------------------------------

async function writeProvenanceAndIndex(
  provenancePath: string,
  provenance: SkillProvenance,
  name: string,
  version: string,
  options: InstallSnapshotOptions,
  storeRoot: string,
): Promise<SkillProvenance> {
  await writeJsonAtomic(provenancePath, provenance);
  await updateActiveIndex(storeRoot, (index) => {
    const without = index.entries.filter((entry) => entry.name !== name);
    without.push({
      name,
      version,
      enabled: options.enabled ?? true,
      installedAt: provenance.installedAt,
    });
    without.sort((left, right) => left.name.localeCompare(right.name));
    return { schema: INDEX_SCHEMA, entries: without };
  });
  return provenance;
}

/**
 * Verify the active index contains an entry for `name` pointing at `version`.
 * If the entry is missing or stale (points at a different version), upsert it.
 * Cheap no-op when the index is already correct.
 */
async function ensureActiveIndexEntry(
  storeRoot: string,
  name: string,
  version: string,
  enabled: boolean,
  installedAt: string,
): Promise<void> {
  await updateActiveIndex(storeRoot, (index) => {
    const existing = index.entries.find((entry) => entry.name === name);
    if (existing && existing.version === version) return index;
    return upsertEntry(index, name, version, enabled, installedAt);
  });
}

function upsertEntry(
  index: SkillStoreIndex,
  name: string,
  version: string,
  enabled: boolean,
  installedAt: string,
): SkillStoreIndex {
  const existing = index.entries.find((entry) => entry.name === name);
  const without = index.entries.filter((entry) => entry.name !== name);
  without.push(existing ? { ...existing, version } : { name, version, enabled, installedAt });
  without.sort((left, right) => left.name.localeCompare(right.name));
  return { schema: INDEX_SCHEMA, entries: without };
}

/** Durable family entries relevant to create-only collision/recovery checks. */
async function retainedPublicationNames(familyRoot: string): Promise<string[]> {
  const entries = await readdir(familyRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (isNotFound(error)) return [] as import("node:fs").Dirent[];
    throw error;
  });
  return entries
    .filter((entry) => !entry.name.startsWith(STAGING_DIR_PREFIX))
    .map((entry) => entry.name);
}

function provenanceMatchesInspection(
  provenance: SkillProvenance,
  inspected: Awaited<ReturnType<typeof inspectSkillBundle>>,
  actualInventory: SkillBundleFile[],
): boolean {
  if (
    provenance.name !== inspected.name
    || provenance.version !== inspected.version
    || provenance.installedAt.length === 0
    || provenance.contentSha256 !== inspected.bodySha256
    || provenance.bundleSha256 !== inspected.bundleSha256
    || computeBundleHash(actualInventory) !== inspected.bundleSha256
  ) return false;
  const normalize = (inventory: readonly SkillBundleFile[]) => [...inventory]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${file.sha256}\0${file.bytes}`);
  return JSON.stringify(normalize(provenance.fileInventory)) === JSON.stringify(normalize(inspected.files));
}

function buildProvenance(args: {
  name: string;
  version: string;
  options: InstallSnapshotOptions;
  contentSha256: string;
  bundleSha256: string;
  inventory: SkillBundleFile[];
}): SkillProvenance {
  const provenance: SkillProvenance = {
    schema: PROVENANCE_SCHEMA,
    name: args.name,
    version: args.version,
    sourceKind: args.options.sourceKind ?? "local-directory",
    skillRoot: args.options.skillRoot ?? ".",
    contentSha256: args.contentSha256,
    bundleSha256: args.bundleSha256,
    fileInventory: [...args.inventory].sort((left, right) => left.path.localeCompare(right.path)),
    installedAt: new Date().toISOString(),
  };
  if (args.options.sourceIdentity !== undefined) provenance.sourceIdentity = args.options.sourceIdentity;
  if (args.options.requestedRef !== undefined) provenance.requestedRef = args.options.requestedRef;
  if (args.options.resolvedCommit !== undefined) provenance.resolvedCommit = args.options.resolvedCommit;
  if (args.options.dirtySource) provenance.dirtySource = true;
  return provenance;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.tmp-${randomUUID()}`;
  await writeFile(staging, `${JSON.stringify(value, null, 2)}\n`);
  await rename(staging, path);
}

// --- index locking ---------------------------------------------------------

/**
 * The active-index read-modify-write is serialized twice. Within one process an
 * in-process chain orders overlapping installs so the later write cannot drop an
 * entry the earlier one added. Across processes (the install CLI invoked in two
 * terminals), `withIndexLock` holds a SQLite `BEGIN IMMEDIATE` transaction so
 * concurrent writes cannot interleave their read and write. SQLite releases the
 * lock when a process exits, including after a crash, so stale-lock guessing and
 * deletion cannot race a new owner. The atomic temp+rename still prevents a
 * half-written index; snapshot staging runs concurrently with everything except
 * the narrow index RMW.
 */
let indexUpdateChain: Promise<unknown> = Promise.resolve();

function updateActiveIndex(
  storeRoot: string,
  mutate: (index: SkillStoreIndex) => SkillStoreIndex,
): Promise<void> {
  const next = indexUpdateChain.then(() => updateActiveIndexCritical(storeRoot, mutate));
  // Keep the chain alive regardless of this update's outcome, while still
  // surfacing failures to the caller.
  indexUpdateChain = next.then(() => undefined, () => undefined);
  return next;
}

const INDEX_LOCK_DATABASE = "index-lock.sqlite";
/** Prefix for in-flight install staging directories inside a skill family. */
const STAGING_DIR_PREFIX = ".staging-";

/** Hold an exclusive cross-process lock around `critical`. */
async function withIndexLock<T>(storeRoot: string, critical: () => Promise<T>): Promise<T> {
  await mkdir(storeRoot, { recursive: true });
  return withSqliteMutex(
    join(storeRoot, INDEX_LOCK_DATABASE),
    "Skill Store index is locked by another process; retry later.",
    critical,
  );
}

async function updateActiveIndexCritical(
  storeRoot: string,
  mutate: (index: SkillStoreIndex) => SkillStoreIndex,
): Promise<void> {
  await withIndexLock(storeRoot, async () => {
    await writeIndexFile(storeRoot, mutate(await readIndexFile(storeRoot)));
  });
}

/** Read the index without acquiring the lock; the caller must already hold it. */
async function readIndexFile(storeRoot: string): Promise<SkillStoreIndex> {
  const indexPath = join(storeRoot, INDEX_FILE);
  const current = await readFile(indexPath).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  return current === undefined ? { schema: INDEX_SCHEMA, entries: [] } : parseActiveIndex(current);
}

/** Write the index atomically without acquiring the lock; the caller must hold it. */
async function writeIndexFile(storeRoot: string, index: SkillStoreIndex): Promise<void> {
  await writeJsonAtomic(join(storeRoot, INDEX_FILE), index);
}

// --- parsing ---------------------------------------------------------------

function parseActiveIndex(raw: Buffer | string): SkillStoreIndex {
  const value = parseJsonObject(raw, "Skill Store index");
  if (value.schema !== INDEX_SCHEMA) throw new Error("Skill Store index has an unsupported schema.");
  const entries = value.entries;
  if (!Array.isArray(entries)) throw new Error("Skill Store index entries must be a list.");
  return {
    schema: INDEX_SCHEMA,
    entries: entries.map((entry) => parseIndexEntry(entry)),
  };
}

function parseIndexEntry(value: unknown): SkillStoreIndexEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill Store index entry must be an object.");
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== "string" || entry.name.length === 0) throw new Error("Skill Store index entry name must be a non-empty string.");
  if (typeof entry.version !== "string" || entry.version.length === 0) throw new Error("Skill Store index entry version must be a non-empty string.");
  if (typeof entry.enabled !== "boolean") throw new Error("Skill Store index entry enabled must be a boolean.");
  if (typeof entry.installedAt !== "string") throw new Error("Skill Store index entry installedAt must be a string.");
  return { name: entry.name, version: entry.version, enabled: entry.enabled, installedAt: entry.installedAt };
}

function parseProvenance(raw: Buffer | string): SkillProvenance {
  const value = parseJsonObject(raw, "Skill provenance");
  if (value.schema !== PROVENANCE_SCHEMA) throw new Error("Skill provenance has an unsupported schema.");
  if (typeof value.name !== "string") throw new Error("Skill provenance name must be a string.");
  if (typeof value.version !== "string") throw new Error("Skill provenance version must be a string.");
  const sourceKind = value.sourceKind;
  if (sourceKind !== "local-directory" && sourceKind !== "local-git" && sourceKind !== "github") {
    throw new Error("Skill provenance sourceKind is invalid.");
  }
  if (typeof value.skillRoot !== "string") throw new Error("Skill provenance skillRoot must be a string.");
  if (typeof value.contentSha256 !== "string") throw new Error("Skill provenance contentSha256 must be a string.");
  if (typeof value.bundleSha256 !== "string") throw new Error("Skill provenance bundleSha256 must be a string.");
  if (!Array.isArray(value.fileInventory)) throw new Error("Skill provenance fileInventory must be a list.");
  const fileInventory = value.fileInventory.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Skill provenance inventory entry must be an object.");
    const entry = file as Record<string, unknown>;
    if (typeof entry.path !== "string" || typeof entry.sha256 !== "string" || typeof entry.bytes !== "number") {
      throw new Error("Skill provenance inventory entry is malformed.");
    }
    return { path: entry.path, sha256: entry.sha256, bytes: entry.bytes };
  });
  const provenance: SkillProvenance = {
    schema: PROVENANCE_SCHEMA,
    name: value.name,
    version: value.version,
    sourceKind,
    skillRoot: value.skillRoot,
    contentSha256: value.contentSha256,
    bundleSha256: value.bundleSha256,
    fileInventory,
    installedAt: typeof value.installedAt === "string" ? value.installedAt : "",
  };
  if (typeof value.sourceIdentity === "string") provenance.sourceIdentity = value.sourceIdentity;
  if (typeof value.requestedRef === "string") provenance.requestedRef = value.requestedRef;
  if (typeof value.resolvedCommit === "string") provenance.resolvedCommit = value.resolvedCommit;
  if (value.dirtySource === true) provenance.dirtySource = true;
  return provenance;
}

function parseJsonObject(raw: Buffer | string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

// --- small helpers ---------------------------------------------------------

async function pathExists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  }));
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/**
 * Reject anything that is not a single path segment. Used for every Store
 * `name`/`version` so a caller-supplied or Phase 1 remote/CLI value containing
 * `/`, `\`, `..`, `.`, or NUL cannot escape its directory via `join`.
 */
function assertStoreSegment(label: string, kind: "name" | "version"): void {
  if (!label || label.includes("\0")) {
    throw new Error(`Skill Store ${kind} is required.`);
  }
  if (label === "." || label === ".." || label.includes("/") || label.includes("\\")) {
    throw new Error(`Skill Store ${kind} must be a single path segment: ${label}.`);
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.message : String(error);
}
