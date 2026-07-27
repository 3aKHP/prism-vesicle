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
 * its source. Snapshots are staged, verified by re-hash, and atomically renamed
 * so an interrupted install never leaves a live dependency on the source path
 * or a half-written active version. Reinstalling identical content is idempotent
 * by bundle hash; a differing bundle under the same version is a hard conflict.
 *
 * Phase 0 ships the storage mechanism (`installSnapshot`) plus the read APIs so
 * Phase 1 can layer repository-install commands on top without re-deriving the
 * immutable-snapshot contract. The store is not yet a discovery source.
 */

import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { userConfigDirectory } from "../config/paths";
import { SKILL_FILE_NAME } from "./loader";
import { enumerateSkillBundle } from "./paths";
import { parseSkillMarkdown } from "./parser";

const INDEX_SCHEMA = "prism-vesicle-skill-store/v1";
const PROVENANCE_SCHEMA = "prism-vesicle-skill-provenance/v1";
const INDEX_FILE = "index.json";
const PROVENANCE_FILE = "provenance.json";

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

export interface SkillBundleFile {
  path: string;
  sha256: string;
  bytes: number;
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
 * Validates the source `SKILL.md`, enumerates the full bundle with symlink and
 * path guards, content-hashes every file, stages the copy, re-verifies by hash,
 * and atomically renames it into place before updating the active index. Throws
 * on any validation, safety, or conflict failure; partial staging is cleaned up.
 */
export async function installSnapshot(options: InstallSnapshotOptions): Promise<SkillProvenance> {
  const env = options.env ?? process.env;
  const sourceDirectory = options.sourceDirectory;
  const expectedName = basename(sourceDirectory);

  const rootInfo = await lstat(sourceDirectory).catch((error: unknown) => {
    throw new Error(`Cannot access skill source directory: ${errorMessage(error)}`);
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("Skill source must be a real directory, not a file or symbolic link.");
  }

  const skillFile = join(sourceDirectory, SKILL_FILE_NAME);
  const raw = await readFile(skillFile).catch((error: unknown) => {
    throw new Error(`Cannot read ${SKILL_FILE_NAME}: ${errorMessage(error)}`);
  });
  const content = decodeUtf8(raw.subarray(stripBom(raw)));
  const parsed = parseSkillMarkdown(content, expectedName);
  if (!parsed.ok) {
    const detail = parsed.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
    throw new Error(`Skill "${expectedName}" failed validation: ${detail}`);
  }

  const bundle = await enumerateSkillBundle(sourceDirectory, SKILL_FILE_NAME);
  const blocking = bundle.diagnostics.filter((diagnostic) => diagnostic.kind !== "resource-oversized");
  if (blocking.length > 0) {
    throw new Error(`Skill "${expectedName}" cannot be stored: ${blocking.map((diagnostic) => diagnostic.message).join(" ")}`);
  }

  const inventory = await hashFiles(sourceDirectory, bundle.files);
  const bundleSha256 = computeBundleHash(inventory);
  const version = options.version ?? `sha-${bundleSha256.slice(0, 12)}`;
  const name = parsed.metadata.name;
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
    const existing = await hashDirectory(versionDir, SKILL_FILE_NAME);
    if (computeBundleHash(existing) !== bundleSha256) {
      throw new Error(`Skill "${name}" version "${version}" already exists with different content; use a distinct version.`);
    }
    // Idempotent reinstall by bundle hash: a matching snapshot is a pure no-op.
    // Return the existing provenance without rewriting it or bumping the index.
    const existingProvenance = await readProvenance(name, version, env);
    if (existingProvenance) return existingProvenance;
    // Orphan recovery: snapshot exists without a sidecar. Rebuild provenance and
    // ensure the active-index entry without claiming a fresh install time.
    return writeProvenanceAndIndex(
      provenancePath,
      buildProvenance({ name, version, options, contentSha256: parsed.bodySha256, bundleSha256, inventory }),
      name,
      version,
      options,
      storeRoot,
    );
  }

  const staging = join(familyRoot, `${STAGING_DIR_PREFIX}${version}-${randomUUID()}`);
  await mkdir(familyRoot, { recursive: true });
  try {
    await copyBundle(sourceDirectory, staging, inventory);
    const staged = await hashDirectory(staging, SKILL_FILE_NAME);
    if (computeBundleHash(staged) !== bundleSha256) {
      throw new Error("Skill snapshot verification failed after staging; refusing to install.");
    }
    await rename(staging, versionDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return writeProvenanceAndIndex(
    provenancePath,
    buildProvenance({ name, version, options, contentSha256: parsed.bodySha256, bundleSha256, inventory }),
    name,
    version,
    options,
    storeRoot,
  );
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

// --- hashing ----------------------------------------------------------------

/** Deterministic SHA-256 over a sorted `path\0sha256` inventory. */
export function computeBundleHash(inventory: readonly SkillBundleFile[]): string {
  const payload = [...inventory]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${file.sha256}`)
    .join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

async function hashFiles(sourceDirectory: string, files: readonly { path: string }[]): Promise<SkillBundleFile[]> {
  const inventory: SkillBundleFile[] = [];
  for (const file of files) {
    const absolutePath = join(sourceDirectory, ...file.path.split("/"));
    const bytes = await readFile(absolutePath);
    inventory.push({ path: file.path, sha256: sha256(bytes), bytes: bytes.byteLength });
  }
  return inventory;
}

async function hashDirectory(directory: string, skillFileName: string): Promise<SkillBundleFile[]> {
  const { files } = await enumerateSkillBundle(directory, skillFileName);
  return hashFiles(directory, files);
}

// --- staging + persistence --------------------------------------------------

async function copyBundle(sourceDirectory: string, staging: string, inventory: readonly SkillBundleFile[]): Promise<void> {
  await mkdir(staging, { recursive: true });
  for (const file of inventory) {
    const target = join(staging, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sourceDirectory, ...file.path.split("/")), target);
  }
}

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
const INDEX_LOCK_TIMEOUT_MS = 10_000;
/** Prefix for in-flight install staging directories inside a skill family. */
const STAGING_DIR_PREFIX = ".staging-";

/** Hold an exclusive cross-process lock around `critical`. */
async function withIndexLock<T>(storeRoot: string, critical: () => Promise<T>): Promise<T> {
  await mkdir(storeRoot, { recursive: true });
  const database = new Database(join(storeRoot, INDEX_LOCK_DATABASE), { create: true });
  let transactionOpen = false;
  try {
    await beginImmediateWithRetry(database);
    transactionOpen = true;
    const result = await critical();
    database.exec("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original index update failure.
      }
    }
    if (error instanceof Error && /database is locked|database is busy/i.test(error.message)) {
      throw new Error("Skill Store index is locked by another process; retry later.", { cause: error });
    }
    throw error;
  } finally {
    database.close(false);
  }
}

async function beginImmediateWithRetry(database: Database): Promise<void> {
  const deadline = Date.now() + INDEX_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      database.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/database is locked|database is busy/i.test(error.message)) throw error;
      if (Date.now() >= deadline) {
        throw new Error("Skill Store index is locked by another process; retry later.", { cause: error });
      }
      await Bun.sleep(50);
    }
  }
}

async function updateActiveIndexCritical(
  storeRoot: string,
  mutate: (index: SkillStoreIndex) => SkillStoreIndex,
): Promise<void> {
  await withIndexLock(storeRoot, async () => {
    const indexPath = join(storeRoot, INDEX_FILE);
    const current = await readFile(indexPath).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    const base: SkillStoreIndex = current === undefined ? { schema: INDEX_SCHEMA, entries: [] } : parseActiveIndex(current);
    await writeJsonAtomic(indexPath, mutate(base));
  });
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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(raw: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error(`${SKILL_FILE_NAME} is not valid UTF-8.`);
  }
}

function stripBom(raw: Uint8Array): number {
  return raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
}

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
